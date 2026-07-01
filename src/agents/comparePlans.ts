import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TaskSession } from "../session/schema.js";
import type { PlanOutput } from "./types.js";

export interface PlanComparisonAgentSummary {
  agentId: string;
  confidence: number;
  estimatedComplexity: string;
  proposedFilesToChange: string[];
  risks: string[];
  summary: string;
  testsToRun: string[];
}

export interface PlanComparison {
  agentSummaries: PlanComparisonAgentSummary[];
  architectureChoices: {
    common: string[];
    byAgent: Record<string, string[]>;
  };
  complexity: {
    byAgent: Record<string, string>;
    consensus?: string;
  };
  confidence: {
    average: number;
    byAgent: Record<string, number>;
    highestAgentId?: string;
  };
  files: {
    shared: string[];
    uniqueByAgent: Record<string, string[]>;
  };
  majorAgreements: string[];
  majorDisagreements: string[];
  missingConsiderations: string[];
  recommendedApproach: string;
  recommendedNextStep: string;
  riskyAreas: string[];
  securityConsiderations: string[];
  similarities: string[];
  suggestedImplementationAgent?: string;
  testingStrategy: {
    shared: string[];
    uniqueByAgent: Record<string, string[]>;
  };
}

export interface SavedComparisonArtifact {
  jsonPath: string;
  markdownPath: string;
}

const SECURITY_PATTERNS = [
  /auth/iu,
  /credential/iu,
  /encrypt/iu,
  /permission/iu,
  /secret/iu,
  /security/iu,
  /token/iu,
  /validation/iu,
  /path/iu,
  /filesystem/iu
];

export function comparePlans(plans: readonly PlanOutput[]): PlanComparison {
  if (plans.length === 0) {
    return {
      agentSummaries: [],
      architectureChoices: {
        common: [],
        byAgent: {}
      },
      complexity: {
        byAgent: {}
      },
      confidence: {
        average: 0,
        byAgent: {}
      },
      files: {
        shared: [],
        uniqueByAgent: {}
      },
      majorAgreements: ["No plans were generated."],
      majorDisagreements: [],
      missingConsiderations: ["At least one enabled planning agent is required."],
      recommendedApproach: "Enable an agent and rerun planning.",
      recommendedNextStep: "Enable at least one agent and run plan again.",
      riskyAreas: [],
      securityConsiderations: [],
      similarities: ["No plans were generated."],
      testingStrategy: {
        shared: [],
        uniqueByAgent: {}
      }
    };
  }

  const agentSummaries = plans.map((plan) => ({
    agentId: plan.agentId,
    confidence: plan.confidence,
    estimatedComplexity: plan.estimatedComplexity,
    proposedFilesToChange: plan.proposedFilesToChange,
    risks: plan.risks,
    summary: plan.summary,
    testsToRun: plan.testsToRun
  }));
  const sharedFiles = intersection(plans.map((plan) => plan.proposedFilesToChange));
  const uniqueFilesByAgent = uniqueByAgent(plans, (plan) => plan.proposedFilesToChange);
  const sharedTests = intersection(plans.map((plan) => plan.testsToRun));
  const uniqueTestsByAgent = uniqueByAgent(plans, (plan) => plan.testsToRun);
  const architectureByAgent = Object.fromEntries(
    plans.map((plan) => [plan.agentId, inferArchitectureChoices(plan)])
  );
  const commonArchitecture = intersection(Object.values(architectureByAgent));
  const complexityByAgent = Object.fromEntries(
    plans.map((plan) => [plan.agentId, plan.estimatedComplexity])
  );
  const confidenceByAgent = Object.fromEntries(plans.map((plan) => [plan.agentId, plan.confidence]));
  const highestConfidencePlan = [...plans].sort((a, b) => b.confidence - a.confidence)[0];
  const consensusComplexity = new Set(plans.map((plan) => plan.estimatedComplexity)).size === 1
    ? plans[0]?.estimatedComplexity
    : undefined;
  const riskyAreas = unique(plans.flatMap((plan) => plan.risks));
  const securityConsiderations = inferSecurityConsiderations(plans);
  const missingConsiderations = inferMissingConsiderations(plans, securityConsiderations);
  const majorAgreements = [
    plans.length > 1 ? "All selected agents produced structured plans." : "One structured plan is available.",
    sharedFiles.length > 0 ? `Shared file/area focus: ${sharedFiles.join(", ")}.` : "",
    sharedTests.length > 0 ? `Shared testing strategy: ${sharedTests.join(", ")}.` : "",
    consensusComplexity ? `All agents estimate ${consensusComplexity} complexity.` : ""
  ].filter(Boolean);
  const majorDisagreements = [
    ...Object.entries(uniqueFilesByAgent).flatMap(([agentId, files]) =>
      files.length > 0 ? [`${agentId} uniquely proposes: ${files.join(", ")}.`] : []
    ),
    ...Object.entries(uniqueTestsByAgent).flatMap(([agentId, tests]) =>
      tests.length > 0 ? [`${agentId} uniquely suggests tests: ${tests.join(", ")}.`] : []
    ),
    consensusComplexity ? "" : `Complexity differs: ${formatRecord(complexityByAgent)}.`,
    `Confidence differs: ${formatRecord(
      Object.fromEntries(
        Object.entries(confidenceByAgent).map(([agentId, confidence]) => [
          agentId,
          `${Math.round(confidence * 100)}%`
        ])
      )
    )}.`
  ].filter(Boolean);
  const suggestedImplementationAgent = chooseSuggestedAgent(plans, riskyAreas, missingConsiderations);

  return {
    agentSummaries,
    architectureChoices: {
      common: commonArchitecture,
      byAgent: architectureByAgent
    },
    complexity: {
      byAgent: complexityByAgent,
      ...(consensusComplexity ? { consensus: consensusComplexity } : {})
    },
    confidence: {
      average: plans.reduce((sum, plan) => sum + plan.confidence, 0) / plans.length,
      byAgent: confidenceByAgent,
      ...(highestConfidencePlan ? { highestAgentId: highestConfidencePlan.agentId } : {})
    },
    files: {
      shared: sharedFiles,
      uniqueByAgent: uniqueFilesByAgent
    },
    majorAgreements,
    majorDisagreements,
    missingConsiderations,
    recommendedApproach: buildRecommendedApproach(plans, suggestedImplementationAgent),
    recommendedNextStep:
      "Approve one plan, create a manual merged plan, or proceed to implementation with an approved plan.",
    riskyAreas,
    securityConsiderations,
    similarities: majorAgreements,
    ...(suggestedImplementationAgent ? { suggestedImplementationAgent } : {}),
    testingStrategy: {
      shared: sharedTests,
      uniqueByAgent: uniqueTestsByAgent
    }
  };
}

export async function savePlanComparisonArtifacts(
  session: TaskSession,
  comparison: PlanComparison
): Promise<SavedComparisonArtifact> {
  await mkdir(session.paths.plansDir, { recursive: true });
  const jsonPath = path.join(session.paths.plansDir, "comparison.json");
  const markdownPath = path.join(session.paths.plansDir, "comparison.md");

  await writeFile(jsonPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderPlanComparisonMarkdown(comparison), "utf8");

  return {
    jsonPath,
    markdownPath
  };
}

export function renderPlanComparisonMarkdown(comparison: PlanComparison): string {
  return [
    "# Plan Comparison",
    "",
    "## Agent Summaries",
    "",
    ...comparison.agentSummaries.flatMap((summary) => [
      `### ${summary.agentId}`,
      "",
      summary.summary,
      "",
      `- Complexity: ${summary.estimatedComplexity}`,
      `- Confidence: ${Math.round(summary.confidence * 100)}%`,
      ""
    ]),
    renderList("Major Agreements", comparison.majorAgreements),
    renderList("Major Disagreements", comparison.majorDisagreements),
    renderList("Risk Areas", comparison.riskyAreas),
    renderList("Security Considerations", comparison.securityConsiderations),
    renderList("Missing Considerations", comparison.missingConsiderations),
    "## Recommended Approach",
    "",
    comparison.recommendedApproach,
    "",
    "## Suggested Implementation Agent",
    "",
    comparison.suggestedImplementationAgent ?? "No single agent is clearly preferred.",
    ""
  ].join("\n");
}

function inferArchitectureChoices(plan: PlanOutput): string[] {
  return unique(
    [...plan.stepByStepPlan, ...plan.proposedFilesToChange]
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item) =>
        /architecture|boundary|interface|module|service|workflow|orchestration|integration|source|primary/iu.test(
          item
        )
      )
  );
}

function inferSecurityConsiderations(plans: readonly PlanOutput[]): string[] {
  const candidates = plans.flatMap((plan) => [...plan.risks, ...plan.assumptions, ...plan.stepByStepPlan]);
  const matches = candidates.filter((item) => SECURITY_PATTERNS.some((pattern) => pattern.test(item)));

  return unique(matches);
}

function inferMissingConsiderations(
  plans: readonly PlanOutput[],
  securityConsiderations: readonly string[]
): string[] {
  const missing = [];

  for (const plan of plans) {
    if (plan.proposedFilesToChange.length === 0) {
      missing.push(`${plan.agentId} did not name files or areas likely to change.`);
    }

    if (plan.testsToRun.length === 0) {
      missing.push(`${plan.agentId} did not propose tests to run.`);
    }

    if (plan.risks.length === 0) {
      missing.push(`${plan.agentId} did not identify risks.`);
    }
  }

  if (securityConsiderations.length === 0) {
    missing.push("No explicit security consideration was identified.");
  }

  return unique(missing);
}

function chooseSuggestedAgent(
  plans: readonly PlanOutput[],
  riskyAreas: readonly string[],
  missingConsiderations: readonly string[]
): string | undefined {
  if (plans.length === 0) {
    return undefined;
  }

  return [...plans].sort((a, b) => scorePlan(b, riskyAreas, missingConsiderations) - scorePlan(a, riskyAreas, missingConsiderations))[0]
    ?.agentId;
}

function scorePlan(
  plan: PlanOutput,
  riskyAreas: readonly string[],
  missingConsiderations: readonly string[]
): number {
  const complexityPenalty = plan.estimatedComplexity === "high" ? 0.08 : plan.estimatedComplexity === "medium" ? 0.03 : 0;
  const riskCoverageBonus = plan.risks.length > 0 && riskyAreas.length > 0 ? 0.04 : 0;
  const missingPenalty = missingConsiderations.filter((item) => item.startsWith(plan.agentId)).length * 0.05;

  return plan.confidence + riskCoverageBonus - complexityPenalty - missingPenalty;
}

function buildRecommendedApproach(
  plans: readonly PlanOutput[],
  suggestedImplementationAgent: string | undefined
): string {
  if (plans.length === 1) {
    return `Use ${plans[0]?.agentId ?? "the available agent"} as the approved plan if it matches the user's intent.`;
  }

  if (!suggestedImplementationAgent) {
    return "Create a manual approved plan that merges the strongest parts of the agent plans.";
  }

  return `Use ${suggestedImplementationAgent} as the lead implementation plan, then manually incorporate any missing risk or testing coverage from the other plan(s).`;
}

function uniqueByAgent(
  plans: readonly PlanOutput[],
  getItems: (plan: PlanOutput) => readonly string[]
): Record<string, string[]> {
  const allItems = plans.flatMap((plan) => getItems(plan));

  return Object.fromEntries(
    plans.map((plan) => [
      plan.agentId,
      unique(getItems(plan)).filter((item) => allItems.filter((candidate) => candidate === item).length === 1)
    ])
  );
}

function intersection(groups: readonly string[][]): string[] {
  const [firstGroup, ...remainingGroups] = groups;

  if (!firstGroup) {
    return [];
  }

  return unique(firstGroup).filter((item) =>
    remainingGroups.every((group) => group.includes(item))
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function formatRecord(record: Record<string, string>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
}

function renderList(title: string, items: readonly string[]): string {
  const lines = [`## ${title}`, ""];

  if (items.length === 0) {
    lines.push("- None");
  } else {
    lines.push(...items.map((item) => `- ${item}`));
  }

  lines.push("");
  return lines.join("\n");
}

