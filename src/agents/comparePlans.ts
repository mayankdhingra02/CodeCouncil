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

export interface PlanComparisonAgentAssessment {
  agentId: string;
  completenessScore: number;
  rubricScore: number;
  rubricChecks: PlanComparisonRubricCheck[];
  specificityScore: number;
  riskCoverageScore: number;
  testCoverageScore: number;
  scopeScore: number;
  confidenceScore: number;
  totalScore: number;
  strengths: string[];
  weaknesses: string[];
}

export interface PlanComparisonRubricCheck {
  id:
    | "task_understanding"
    | "localization"
    | "implementation_steps"
    | "validation"
    | "risk_and_safety"
    | "reviewability"
    | "scope_control";
  label: string;
  score: number;
  status: "strong" | "partial" | "missing";
  evidence: string[];
  warnings: string[];
}

export interface PlanComparison {
  agentSummaries: PlanComparisonAgentSummary[];
  agentAssessments: PlanComparisonAgentAssessment[];
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
  decisionPolicy: {
    description: string;
    engine: "local-rules";
    humanApprovalRequired: true;
    modelConfidenceWeight: number;
    researchBasis: string[];
    usesAiJudge: false;
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
  recommendationReasons: string[];
  planSynthesis: {
    commonCore: string[];
    uniqueContributionsByAgent: Record<string, string[]>;
    openQuestions: string[];
    suggestedMergedPlan: string[];
  };
  riskyAreas: string[];
  securityConsiderations: string[];
  similarities: string[];
  suggestedImplementationAgent?: string;
  testingStrategy: {
    shared: string[];
    uniqueByAgent: Record<string, string[]>;
  };
  warnings: string[];
}

export interface SavedComparisonArtifact {
  jsonPath: string;
  markdownPath: string;
}

const MODEL_CONFIDENCE_WEIGHT = 0.05;
const MANY_FILES_THRESHOLD = 12;
const RISK_WEIGHT = 0.95;

const RUBRIC_WEIGHTS: Record<PlanComparisonRubricCheck["id"], number> = {
  implementation_steps: 0.18,
  localization: 0.18,
  reviewability: 0.07,
  risk_and_safety: 0.2,
  scope_control: 0.05,
  task_understanding: 0.12,
  validation: 0.2
};

const SECURITY_CLASSIFIERS = [
  {
    label: "Authentication or authorization",
    patterns: [/auth/iu, /permission/iu, /access control/iu]
  },
  {
    label: "Secrets or credentials",
    patterns: [/credential/iu, /secret/iu, /token/iu, /api key/iu]
  },
  {
    label: "Input validation or output encoding",
    patterns: [/validation/iu, /sanitize/iu, /escape/iu, /xss/iu, /injection/iu]
  },
  {
    label: "Filesystem or path safety",
    patterns: [/filesystem/iu, /file system/iu, /path traversal/iu, /outside.*workspace/iu]
  },
  {
    label: "Encryption or sensitive data handling",
    patterns: [/encrypt/iu, /decrypt/iu, /sensitive/iu, /private key/iu]
  }
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
      planSynthesis: {
        commonCore: [],
        uniqueContributionsByAgent: {},
        openQuestions: ["Which agents should be enabled for planning?"],
        suggestedMergedPlan: []
      },
      recommendedApproach: "Enable an agent and rerun planning.",
      recommendedNextStep: "Enable at least one agent and run plan again.",
      recommendationReasons: [],
      riskyAreas: [],
      securityConsiderations: [],
      similarities: ["No plans were generated."],
      agentAssessments: [],
      decisionPolicy: createDecisionPolicy(),
      testingStrategy: {
        shared: [],
        uniqueByAgent: {}
      },
      warnings: ["No agent plans were available to compare."]
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
  const fileComparison = compareItemsByAgent(
    plans,
    (plan) => plan.proposedFilesToChange,
    normalizeFileReference
  );
  const sharedFiles = fileComparison.shared;
  const uniqueFilesByAgent = fileComparison.uniqueByAgent;
  const testComparison = compareItemsByAgent(
    plans,
    (plan) => plan.testsToRun,
    normalizeCommandReference
  );
  const sharedTests = testComparison.shared;
  const uniqueTestsByAgent = testComparison.uniqueByAgent;
  const architectureByAgent = Object.fromEntries(
    plans.map((plan) => [plan.agentId, inferArchitectureChoices(plan)])
  );
  const commonArchitecture = compareStringGroups(Object.values(architectureByAgent)).shared;
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
  const riskComparison = compareItemsByAgent(
    plans,
    (plan) => plan.risks,
    normalizeTextReference
  );
  const stepComparison = compareItemsByAgent(
    plans,
    (plan) => plan.stepByStepPlan,
    normalizeTextReference
  );
  const agentAssessments = plans.map((plan) =>
    assessPlan(plan, {
      sharedFiles,
      sharedRisks: riskComparison.shared,
      sharedSteps: stepComparison.shared,
      sharedTests
    })
  );
  const warnings = inferComparisonWarnings(plans, agentAssessments, securityConsiderations);
  const planSynthesis = buildPlanSynthesis({
    fileComparison,
    plans,
    riskComparison,
    securityConsiderations,
    stepComparison,
    testComparison
  });
  const majorAgreements = [
    plans.length > 1 ? "All selected agents produced structured plans." : "One structured plan is available.",
    sharedFiles.length > 0 ? `Shared file/area focus: ${sharedFiles.join(", ")}.` : "",
    sharedTests.length > 0 ? `Shared testing strategy: ${sharedTests.join(", ")}.` : "",
    riskComparison.shared.length > 0 ? `Shared risk focus: ${riskComparison.shared.join(", ")}.` : "",
    stepComparison.shared.length > 0 ? `Shared implementation step: ${stepComparison.shared.join(", ")}.` : "",
    consensusComplexity ? `All agents estimate ${consensusComplexity} complexity.` : ""
  ].filter(Boolean);
  const majorDisagreements = [
    ...Object.entries(uniqueFilesByAgent).flatMap(([agentId, files]) =>
      files.length > 0 ? [`${agentId} uniquely proposes: ${files.join(", ")}.`] : []
    ),
    ...Object.entries(uniqueTestsByAgent).flatMap(([agentId, tests]) =>
      tests.length > 0 ? [`${agentId} uniquely suggests tests: ${tests.join(", ")}.`] : []
    ),
    ...Object.entries(riskComparison.uniqueByAgent).flatMap(([agentId, risks]) =>
      risks.length > 0 ? [`${agentId} uniquely identifies risks: ${risks.join(", ")}.`] : []
    ),
    ...Object.entries(stepComparison.uniqueByAgent).flatMap(([agentId, steps]) =>
      steps.length > 0 ? [`${agentId} uniquely proposes steps: ${steps.join(", ")}.`] : []
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
  const suggestedImplementationAgent = chooseSuggestedAgent(agentAssessments);
  const recommendationReasons = buildRecommendationReasons(
    suggestedImplementationAgent,
    agentAssessments,
    plans,
    sharedFiles,
    sharedTests
  );

  return {
    agentSummaries,
    agentAssessments,
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
    decisionPolicy: createDecisionPolicy(),
    files: {
      shared: sharedFiles,
      uniqueByAgent: uniqueFilesByAgent
    },
    majorAgreements,
    majorDisagreements,
    missingConsiderations,
    planSynthesis,
    recommendedApproach: buildRecommendedApproach(plans, suggestedImplementationAgent),
    recommendedNextStep:
      "Approve one plan, create a manual merged plan, or proceed to implementation with an approved plan.",
    recommendationReasons,
    riskyAreas,
    securityConsiderations,
    similarities: majorAgreements,
    ...(suggestedImplementationAgent ? { suggestedImplementationAgent } : {}),
    testingStrategy: {
      shared: sharedTests,
      uniqueByAgent: uniqueTestsByAgent
    },
    warnings
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
    "## Decision Policy",
    "",
    `- Engine: ${comparison.decisionPolicy.engine}`,
    `- Uses AI judge: ${comparison.decisionPolicy.usesAiJudge ? "yes" : "no"}`,
    `- Human approval required: ${comparison.decisionPolicy.humanApprovalRequired ? "yes" : "no"}`,
    `- Model confidence score weight: ${Math.round(comparison.decisionPolicy.modelConfidenceWeight * 100)}%`,
    `- ${comparison.decisionPolicy.description}`,
    "",
    "Research basis:",
    ...comparison.decisionPolicy.researchBasis.map((item) => `- ${item}`),
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
    renderAssessmentTable(comparison.agentAssessments),
    renderPlanSynthesis(comparison.planSynthesis),
    renderList("Recommendation Evidence", comparison.recommendationReasons),
    renderList("Comparison Warnings", comparison.warnings),
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

function createDecisionPolicy(): PlanComparison["decisionPolicy"] {
  return {
    description:
      "CodeCouncil compares structured plan fields with deterministic local rules. It does not call Codex, Claude, or another model to judge the plans.",
    engine: "local-rules",
    humanApprovalRequired: true,
    modelConfidenceWeight: MODEL_CONFIDENCE_WEIGHT,
    researchBasis: [
      "Execution-based software engineering benchmarks value runnable validation over model confidence.",
      "Patch-generation systems separate localization, repair planning, and patch validation.",
      "LLM-judge literature favors explicit rubrics and pairwise evidence, while warning about judge bias."
    ],
    usesAiJudge: false
  };
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
  const matches = plans.flatMap((plan) => {
    const candidates = [
      ...plan.risks.map((item) => ({ field: "risk", item })),
      ...plan.assumptions.map((item) => ({ field: "assumption", item })),
      { field: "summary", item: plan.summary }
    ];

    return candidates.flatMap(({ field, item }) => {
      const classifier = SECURITY_CLASSIFIERS.find(({ patterns }) =>
        patterns.some((pattern) => pattern.test(item))
      );

      return classifier ? [`${plan.agentId} ${field}: ${classifier.label} - ${item}`] : [];
    });
  });

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
  assessments: readonly PlanComparisonAgentAssessment[]
): string | undefined {
  if (assessments.length === 0) {
    return undefined;
  }

  return [...assessments].sort((a, b) => b.totalScore - a.totalScore)[0]
    ?.agentId;
}

function assessPlan(
  plan: PlanOutput,
  context: {
    sharedFiles: readonly string[];
    sharedRisks: readonly string[];
    sharedSteps: readonly string[];
    sharedTests: readonly string[];
  }
): PlanComparisonAgentAssessment {
  const completenessScore = average([
    scorePresent(plan.summary),
    scoreNonEmpty(plan.assumptions),
    scoreNonEmpty(plan.proposedFilesToChange),
    scoreNonEmpty(plan.stepByStepPlan),
    scoreNonEmpty(plan.risks),
    scoreNonEmpty(plan.testsToRun)
  ]);
  const specificityScore = average([
    scoreBoundedCount(plan.proposedFilesToChange.length, 1, 8),
    scoreBoundedCount(plan.stepByStepPlan.length, 2, 10),
    scoreItemSpecificity(plan.proposedFilesToChange, /[/.]/u),
    scoreItemSpecificity(plan.stepByStepPlan, /\b(add|update|write|export|test|run|create|validate|render)\b/iu)
  ]);
  const riskCoverageScore = average([
    scoreBoundedCount(plan.risks.length, 1, 6),
    scoreItemSpecificity(plan.risks, /security|risk|secret|token|auth|escape|xss|validation|edge|fail/iu)
  ]);
  const testCoverageScore = average([
    scoreBoundedCount(plan.testsToRun.length, 1, 5),
    scoreItemSpecificity(plan.testsToRun, /\b(test|typecheck|lint|vitest|pytest|go test|cargo test)\b/iu)
  ]);
  const scopeScore = plan.proposedFilesToChange.length > MANY_FILES_THRESHOLD
    ? 0.35
    : plan.estimatedComplexity === "high"
      ? 0.55
      : plan.estimatedComplexity === "medium"
        ? 0.75
        : 1;
  const rubricChecks = buildRubricChecks(plan, {
    ...context,
    scopeScore
  });
  const rubricScore = scoreRubricChecks(rubricChecks);
  const confidenceScore = normalizeConfidence(plan.confidence);
  const totalScore = roundScore(
    rubricScore * RISK_WEIGHT +
      confidenceScore * MODEL_CONFIDENCE_WEIGHT
  );
  const strengths = buildStrengths(plan, {
    completenessScore,
    riskCoverageScore,
    rubricChecks,
    sharedFiles: context.sharedFiles,
    sharedRisks: context.sharedRisks,
    sharedSteps: context.sharedSteps,
    sharedTests: context.sharedTests,
    specificityScore,
    testCoverageScore
  });
  const weaknesses = buildWeaknesses({
    completenessScore,
    riskCoverageScore,
    scopeScore,
    specificityScore,
    testCoverageScore
  });

  return {
    agentId: plan.agentId,
    completenessScore: roundScore(completenessScore),
    rubricChecks,
    rubricScore: roundScore(rubricScore),
    specificityScore: roundScore(specificityScore),
    riskCoverageScore: roundScore(riskCoverageScore),
    testCoverageScore: roundScore(testCoverageScore),
    scopeScore: roundScore(scopeScore),
    confidenceScore: roundScore(confidenceScore),
    totalScore,
    strengths,
    weaknesses
  };
}

function buildStrengths(
  plan: PlanOutput,
  input: {
    completenessScore: number;
    riskCoverageScore: number;
    rubricChecks: readonly PlanComparisonRubricCheck[];
    sharedFiles: readonly string[];
    sharedRisks: readonly string[];
    sharedSteps: readonly string[];
    sharedTests: readonly string[];
    specificityScore: number;
    testCoverageScore: number;
  }
): string[] {
  return [
    input.completenessScore >= 0.8 ? "Provides most expected structured planning fields." : "",
    input.specificityScore >= 0.75 ? "Names concrete files and implementation steps." : "",
    input.riskCoverageScore >= 0.75 ? "Identifies concrete risks." : "",
    input.testCoverageScore >= 0.75 ? "Includes concrete test commands." : "",
    input.rubricChecks.every((check) => check.status !== "missing")
      ? "Covers every local comparison rubric dimension at least partially."
      : "",
    input.sharedFiles.some((file) => plan.proposedFilesToChange.some((item) => normalizeFileReference(item).key === normalizeFileReference(file).key))
      ? "Aligns with another agent on at least one file."
      : "",
    input.sharedSteps.some((step) => plan.stepByStepPlan.some((item) => normalizeTextReference(item).key === normalizeTextReference(step).key))
      ? "Aligns with another agent on at least one implementation step."
      : "",
    input.sharedRisks.some((risk) => plan.risks.some((item) => normalizeTextReference(item).key === normalizeTextReference(risk).key))
      ? "Aligns with another agent on at least one risk."
      : "",
    input.sharedTests.some((test) => plan.testsToRun.some((item) => normalizeCommandReference(item).key === normalizeCommandReference(test).key))
      ? "Aligns with another agent on at least one test command."
      : ""
  ].filter(Boolean);
}

function buildWeaknesses(input: {
  completenessScore: number;
  riskCoverageScore: number;
  scopeScore: number;
  specificityScore: number;
  testCoverageScore: number;
}): string[] {
  return [
    input.completenessScore < 0.6 ? "Missing several expected structured planning fields." : "",
    input.specificityScore < 0.6 ? "Plan is too vague about files or steps." : "",
    input.riskCoverageScore < 0.6 ? "Risk coverage is thin." : "",
    input.testCoverageScore < 0.6 ? "Testing strategy is thin." : "",
    input.scopeScore < 0.6 ? "Scope may be broad for a first implementation pass." : ""
  ].filter(Boolean);
}

function buildRecommendationReasons(
  suggestedImplementationAgent: string | undefined,
  assessments: readonly PlanComparisonAgentAssessment[],
  plans: readonly PlanOutput[],
  sharedFiles: readonly string[],
  sharedTests: readonly string[]
): string[] {
  if (!suggestedImplementationAgent) {
    return ["No implementation agent was selected because no plans were available."];
  }

  const selectedAssessment = assessments.find((assessment) => assessment.agentId === suggestedImplementationAgent);
  const selectedPlan = plans.find((plan) => plan.agentId === suggestedImplementationAgent);

  if (!selectedAssessment || !selectedPlan) {
    return ["The selected implementation agent could not be matched to an assessment."];
  }

  return [
    `${suggestedImplementationAgent} has the highest local rules score (${formatScore(selectedAssessment.totalScore)}).`,
    `Score uses a local rubric for task understanding, localization, implementation steps, validation, risk/safety, reviewability, scope control, and only ${Math.round(MODEL_CONFIDENCE_WEIGHT * 100)}% self-reported confidence.`,
    `Rubric score before confidence adjustment: ${formatScore(selectedAssessment.rubricScore)}.`,
    selectedAssessment.strengths.length > 0 ? `Strengths: ${selectedAssessment.strengths.join("; ")}.` : "",
    sharedFiles.length > 0 ? `Agents agree on these files/areas: ${sharedFiles.join(", ")}.` : "",
    sharedTests.length > 0 ? `Agents agree on these tests: ${sharedTests.join(", ")}.` : "",
    selectedPlan.confidence >= 0.9 ? "Model confidence is high, but CodeCouncil treats it as a small signal only." : ""
  ].filter(Boolean);
}

function buildRubricChecks(
  plan: PlanOutput,
  context: {
    scopeScore: number;
    sharedFiles: readonly string[];
    sharedRisks: readonly string[];
    sharedSteps: readonly string[];
    sharedTests: readonly string[];
  }
): PlanComparisonRubricCheck[] {
  return [
    createRubricCheck({
      evidence: [plan.summary, ...plan.assumptions],
      id: "task_understanding",
      label: "Task Understanding",
      score: average([scorePresent(plan.summary), scoreBoundedCount(plan.assumptions.length, 1, 3)]),
      warnings: plan.assumptions.length === 0 ? ["No assumptions were stated."] : []
    }),
    createRubricCheck({
      evidence: plan.proposedFilesToChange,
      id: "localization",
      label: "Repository Localization",
      score: average([
        scoreBoundedCount(plan.proposedFilesToChange.length, 1, 8),
        scoreItemSpecificity(plan.proposedFilesToChange, /[/.]/u),
        context.sharedFiles.length > 0 ? scoreOverlap(plan.proposedFilesToChange, context.sharedFiles, normalizeFileReference) : 0.65
      ]),
      warnings: plan.proposedFilesToChange.length === 0 ? ["No files or areas were named."] : []
    }),
    createRubricCheck({
      evidence: plan.stepByStepPlan,
      id: "implementation_steps",
      label: "Implementation Steps",
      score: average([
        scoreBoundedCount(plan.stepByStepPlan.length, 2, 10),
        scoreItemSpecificity(plan.stepByStepPlan, /\b(add|update|write|export|test|run|create|validate|render|compare|persist)\b/iu),
        context.sharedSteps.length > 0 ? scoreOverlap(plan.stepByStepPlan, context.sharedSteps, normalizeTextReference) : 0.65
      ]),
      warnings: plan.stepByStepPlan.length === 0 ? ["No implementation steps were provided."] : []
    }),
    createRubricCheck({
      evidence: plan.testsToRun,
      id: "validation",
      label: "Validation Strategy",
      score: average([
        scoreBoundedCount(plan.testsToRun.length, 1, 5),
        scoreItemSpecificity(plan.testsToRun, /\b(test|typecheck|lint|vitest|pytest|go test|cargo test|mvn test|dotnet test)\b/iu),
        context.sharedTests.length > 0 ? scoreOverlap(plan.testsToRun, context.sharedTests, normalizeCommandReference) : 0.65
      ]),
      warnings: plan.testsToRun.length === 0 ? ["No validation commands were provided."] : []
    }),
    createRubricCheck({
      evidence: [...plan.risks, ...plan.assumptions],
      id: "risk_and_safety",
      label: "Risk And Safety",
      score: average([
        scoreBoundedCount(plan.risks.length, 1, 6),
        scoreItemSpecificity(plan.risks, /security|risk|secret|token|auth|escape|xss|validation|edge|fail|regression|compat/iu),
        context.sharedRisks.length > 0 ? scoreOverlap(plan.risks, context.sharedRisks, normalizeTextReference) : 0.65
      ]),
      warnings: plan.risks.length === 0 ? ["No risks were provided."] : []
    }),
    createRubricCheck({
      evidence: [...plan.proposedFilesToChange, ...plan.stepByStepPlan],
      id: "reviewability",
      label: "Reviewability",
      score: average([
        plan.proposedFilesToChange.length <= MANY_FILES_THRESHOLD ? 1 : 0.35,
        plan.stepByStepPlan.length <= 12 ? 1 : 0.55,
        plan.estimatedComplexity === "high" ? 0.55 : 1
      ]),
      warnings: plan.proposedFilesToChange.length > MANY_FILES_THRESHOLD
        ? [`Plan touches more than ${MANY_FILES_THRESHOLD} files or areas.`]
        : []
    }),
    createRubricCheck({
      evidence: [plan.estimatedComplexity],
      id: "scope_control",
      label: "Scope Control",
      score: context.scopeScore,
      warnings: context.scopeScore < 0.6 ? ["Scope may be broad for the first pass."] : []
    })
  ];
}

function createRubricCheck(input: {
  evidence: readonly string[];
  id: PlanComparisonRubricCheck["id"];
  label: string;
  score: number;
  warnings: readonly string[];
}): PlanComparisonRubricCheck {
  const score = roundScore(input.score);

  return {
    evidence: unique(input.evidence).slice(0, 5),
    id: input.id,
    label: input.label,
    score,
    status: score >= 0.75 ? "strong" : score >= 0.4 ? "partial" : "missing",
    warnings: [...input.warnings]
  };
}

function scoreRubricChecks(checks: readonly PlanComparisonRubricCheck[]): number {
  const weightedScore = checks.reduce((sum, check) => sum + check.score * RUBRIC_WEIGHTS[check.id], 0);
  const totalWeight = checks.reduce((sum, check) => sum + RUBRIC_WEIGHTS[check.id], 0);

  return totalWeight === 0 ? 0 : weightedScore / totalWeight;
}

function buildPlanSynthesis(input: {
  fileComparison: { shared: string[]; uniqueByAgent: Record<string, string[]> };
  plans: readonly PlanOutput[];
  riskComparison: { shared: string[]; uniqueByAgent: Record<string, string[]> };
  securityConsiderations: readonly string[];
  stepComparison: { shared: string[]; uniqueByAgent: Record<string, string[]> };
  testComparison: { shared: string[]; uniqueByAgent: Record<string, string[]> };
}): PlanComparison["planSynthesis"] {
  const commonCore = [
    ...input.fileComparison.shared.map((item) => `Change or inspect ${item}.`),
    ...input.stepComparison.shared.map((item) => `Include shared step: ${item}.`),
    ...input.testComparison.shared.map((item) => `Validate with ${item}.`),
    ...input.riskComparison.shared.map((item) => `Track shared risk: ${item}.`)
  ];
  const uniqueContributionsByAgent = Object.fromEntries(
    input.plans.map((plan) => {
      const uniqueFiles = input.fileComparison.uniqueByAgent[plan.agentId] ?? [];
      const uniqueSteps = input.stepComparison.uniqueByAgent[plan.agentId] ?? [];
      const uniqueTests = input.testComparison.uniqueByAgent[plan.agentId] ?? [];
      const uniqueRisks = input.riskComparison.uniqueByAgent[plan.agentId] ?? [];

      return [
        plan.agentId,
        unique([
          ...uniqueFiles.map((item) => `Unique file/area: ${item}.`),
          ...uniqueSteps.map((item) => `Unique step: ${item}.`),
          ...uniqueTests.map((item) => `Unique validation: ${item}.`),
          ...uniqueRisks.map((item) => `Unique risk: ${item}.`)
        ])
      ];
    })
  );
  const openQuestions = [
    input.fileComparison.shared.length === 0 ? "Agents do not agree on the files or areas to change." : "",
    input.testComparison.shared.length === 0 ? "Agents do not share a validation command." : "",
    input.securityConsiderations.length === 0 ? "Neither plan called out explicit security considerations." : "",
    input.plans.some((plan) => plan.estimatedComplexity === "high")
      ? "At least one plan estimates high complexity; consider narrowing the first pass."
      : "",
    ...input.plans.flatMap((plan) =>
      plan.risks.length === 0 ? [`${plan.agentId} did not provide risk analysis.`] : []
    )
  ].filter(Boolean);
  const suggestedMergedPlan = [
    ...commonCore,
    ...Object.entries(uniqueContributionsByAgent).flatMap(([agentId, items]) =>
      items.length > 0 ? [`Consider ${agentId}'s unique contributions: ${items.join(" ")}`] : []
    ),
    openQuestions.length > 0
      ? `Resolve before implementation: ${openQuestions.join(" ")}`
      : "Approve the merged common core, then implement in an isolated worktree."
  ];

  return {
    commonCore: unique(commonCore),
    uniqueContributionsByAgent,
    openQuestions: unique(openQuestions),
    suggestedMergedPlan: unique(suggestedMergedPlan)
  };
}

function inferComparisonWarnings(
  plans: readonly PlanOutput[],
  assessments: readonly PlanComparisonAgentAssessment[],
  securityConsiderations: readonly string[]
): string[] {
  return [
    securityConsiderations.length === 0
      ? "No security considerations were detected. This may mean the task is low-risk, or that both agents missed security analysis."
      : "",
    plans.some((plan) => plan.proposedFilesToChange.length === 0)
      ? "At least one plan did not name files or areas to change."
      : "",
    plans.some((plan) => plan.testsToRun.length === 0)
      ? "At least one plan did not name test commands."
      : "",
    plans.some((plan) => plan.risks.length === 0)
      ? "At least one plan did not name risks."
      : "",
    assessments.some((assessment) => assessment.confidenceScore >= 0.9 && assessment.totalScore < 0.7)
      ? "At least one plan is highly self-confident but weak by local completeness/specificity checks."
      : "",
    "Local comparison is a briefing layer, not a final judge. Use reconcile/cross-review or human approval before implementation."
  ].filter(Boolean);
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

function compareItemsByAgent<TPlan extends { agentId: string }>(
  plans: readonly TPlan[],
  getItems: (plan: TPlan) => readonly string[],
  normalizeItem: (value: string) => ComparableItem
): { shared: string[]; uniqueByAgent: Record<string, string[]> } {
  const byKey = new Map<string, { agents: Set<string>; display: string }>();

  for (const plan of plans) {
    const seenForAgent = new Set<string>();

    for (const item of getItems(plan)) {
      const normalized = normalizeItem(item);

      if (!normalized.key || seenForAgent.has(normalized.key)) {
        continue;
      }

      seenForAgent.add(normalized.key);

      const existing = byKey.get(normalized.key);

      if (existing) {
        existing.agents.add(plan.agentId);
      } else {
        byKey.set(normalized.key, {
          agents: new Set([plan.agentId]),
          display: normalized.display
        });
      }
    }
  }

  const shared = [...byKey.values()]
    .filter((item) => item.agents.size === plans.length)
    .map((item) => item.display);

  const uniqueByAgent = Object.fromEntries(
    plans.map((plan) => {
      const uniqueItems = [...byKey.values()]
        .filter((item) => item.agents.size === 1 && item.agents.has(plan.agentId))
        .map((item) => item.display);

      return [plan.agentId, uniqueItems];
    })
  );

  return {
    shared,
    uniqueByAgent
  };
}

function compareStringGroups(groups: readonly string[][]): { shared: string[] } {
  const pseudoPlans = groups.map((group, index) => ({
    agentId: `group-${index}`,
    items: group
  }));
  const comparison = compareItemsByAgent(
    pseudoPlans,
    (plan) => plan.items,
    normalizeTextReference
  );

  return {
    shared: comparison.shared
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

interface ComparableItem {
  display: string;
  key: string;
}

function normalizeFileReference(value: string): ComparableItem {
  const trimmed = value.trim();
  const pathMatch = trimmed.match(
    /(?:^|\s)([A-Za-z0-9_.@/-]+\.(?:cjs|css|go|html|java|js|jsx|json|md|mjs|py|rs|ts|tsx|toml|yaml|yml))(?:\b|$)/u
  );
  const display = pathMatch?.[1] ?? stripDescription(trimmed);

  return {
    display,
    key: normalizeKey(display)
  };
}

function normalizeCommandReference(value: string): ComparableItem {
  const display = value.trim().replace(/\s+/gu, " ");

  return {
    display,
    key: normalizeKey(display)
  };
}

function normalizeTextReference(value: string): ComparableItem {
  const display = stripDescription(value.trim());

  return {
    display,
    key: normalizeKey(display)
  };
}

function stripDescription(value: string): string {
  return value
    .split(/\s+-\s+/u)[0]
    ?.split(/\s+:\s+/u)[0]
    ?.trim() ?? value.trim();
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function scorePresent(value: string): number {
  return value.trim().length > 0 ? 1 : 0;
}

function scoreNonEmpty(values: readonly string[]): number {
  return values.length > 0 ? 1 : 0;
}

function scoreBoundedCount(count: number, minimumUseful: number, ideal: number): number {
  if (count === 0) {
    return 0;
  }

  if (count < minimumUseful) {
    return 0.35;
  }

  return Math.min(1, count / ideal);
}

function scoreItemSpecificity(values: readonly string[], pattern: RegExp): number {
  if (values.length === 0) {
    return 0;
  }

  return values.filter((value) => pattern.test(value)).length / values.length;
}

function scoreOverlap(
  values: readonly string[],
  sharedValues: readonly string[],
  normalizeItem: (value: string) => ComparableItem
): number {
  if (values.length === 0 || sharedValues.length === 0) {
    return 0;
  }

  const valueKeys = new Set(values.map((value) => normalizeItem(value).key));
  const sharedKeys = unique(sharedValues.map((value) => normalizeItem(value).key));
  const overlapCount = sharedKeys.filter((key) => valueKeys.has(key)).length;

  return overlapCount / sharedKeys.length;
}

function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }

  if (value > 1 && value <= 100) {
    return value / 100;
  }

  return Math.min(1, Math.max(0, value));
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

function formatScore(value: number): string {
  return `${Math.round(value * 100)}%`;
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

function renderAssessmentTable(assessments: readonly PlanComparisonAgentAssessment[]): string {
  const lines = [
    "## Local Quality Assessment",
    "",
    "| Agent | Total | Rubric | Completeness | Specificity | Risks | Tests | Scope | Confidence |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];

  for (const assessment of assessments) {
    lines.push(
      `| ${assessment.agentId} | ${formatScore(assessment.totalScore)} | ${formatScore(assessment.rubricScore)} | ${formatScore(assessment.completenessScore)} | ${formatScore(assessment.specificityScore)} | ${formatScore(assessment.riskCoverageScore)} | ${formatScore(assessment.testCoverageScore)} | ${formatScore(assessment.scopeScore)} | ${formatScore(assessment.confidenceScore)} |`
    );
  }

  lines.push("");

  for (const assessment of assessments) {
    lines.push(`### ${assessment.agentId} Assessment`, "");
    lines.push("Strengths:");
    lines.push(...(assessment.strengths.length > 0 ? assessment.strengths : ["None"]).map((item) => `- ${item}`));
    lines.push("", "Weaknesses:");
    lines.push(...(assessment.weaknesses.length > 0 ? assessment.weaknesses : ["None"]).map((item) => `- ${item}`));
    lines.push("", "Rubric:");
    lines.push(
      ...assessment.rubricChecks.map((check) =>
        `- ${check.label}: ${check.status} (${formatScore(check.score)})${check.warnings.length > 0 ? ` - ${check.warnings.join("; ")}` : ""}`
      )
    );
    lines.push("");
  }

  return lines.join("\n");
}

function renderPlanSynthesis(synthesis: PlanComparison["planSynthesis"]): string {
  return [
    "## Suggested Merged Plan Skeleton",
    "",
    renderList("Common Core", synthesis.commonCore),
    renderUniqueContributions(synthesis.uniqueContributionsByAgent),
    renderList("Open Questions", synthesis.openQuestions),
    renderList("Suggested Merged Steps", synthesis.suggestedMergedPlan)
  ].join("\n");
}

function renderUniqueContributions(uniqueContributionsByAgent: Record<string, string[]>): string {
  const lines = ["## Unique Contributions By Agent", ""];

  for (const [agentId, items] of Object.entries(uniqueContributionsByAgent)) {
    lines.push(`### ${agentId}`, "");
    lines.push(...(items.length > 0 ? items : ["None"]).map((item) => `- ${item}`));
    lines.push("");
  }

  return lines.join("\n");
}
