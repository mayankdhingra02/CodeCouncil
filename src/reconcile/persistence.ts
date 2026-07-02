import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ReconciliationOutput } from "../agents/index.js";
import type { TaskSession } from "../session/index.js";
import { readReconcilerBiasMetrics } from "./biasMetrics.js";

export interface SavedReconciliationArtifact {
  jsonPath: string;
  markdownPath: string;
  metadataPath?: string;
  parsedOutputPath?: string;
  rawOutputPath?: string;
}

export interface SaveReconciliationArtifactOptions {
  basename?: string;
  directory?: string;
}

export interface RotationComparisonCandidate {
  confidence: number;
  openQuestions: number;
  reconcilerAgentId: string;
  reconcilerPlanSelections: number;
  synthesisSelections: number;
  totalResolutions: number;
}

export interface ReconciliationRotationComparison {
  candidates: RotationComparisonCandidate[];
  generatedAt: string;
  recommendedReconcilerAgentId: string;
  recommendationReason: string;
  reconcilerAgentIds: string[];
  sessionId: string;
  sourcePlanAgentIds: string[];
  strategy: "rotate";
  warnings: string[];
}

export async function saveReconciliationArtifacts(
  session: TaskSession,
  reconciliation: ReconciliationOutput,
  options: SaveReconciliationArtifactOptions = {}
): Promise<SavedReconciliationArtifact> {
  const targetDir = options.directory ?? session.paths.plansDir;
  const basename = sanitizeArtifactName(options.basename ?? "reconciled");

  await mkdir(targetDir, { recursive: true });

  const jsonPath = path.join(targetDir, `${basename}.json`);
  const markdownPath = path.join(targetDir, `${basename}.md`);
  const metadataPath = path.join(targetDir, `${basename}.command.json`);
  const parsedOutputPath = path.join(targetDir, `${basename}.parsed.json`);
  const rawOutputPath = path.join(targetDir, `${basename}.raw.txt`);

  await writeFile(jsonPath, `${JSON.stringify(reconciliation, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderReconciliationMarkdown(session, reconciliation), "utf8");

  const result: SavedReconciliationArtifact = {
    jsonPath,
    markdownPath
  };

  if (reconciliation.command || reconciliation.error) {
    await writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          command: reconciliation.command,
          error: reconciliation.error
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    result.metadataPath = metadataPath;
  }

  if (reconciliation.parsedOutput !== undefined) {
    await writeFile(parsedOutputPath, `${JSON.stringify(reconciliation.parsedOutput, null, 2)}\n`, "utf8");
    result.parsedOutputPath = parsedOutputPath;
  }

  if (reconciliation.rawOutput) {
    await writeFile(
      rawOutputPath,
      ["STDOUT", reconciliation.rawOutput.stdout, "", "STDERR", reconciliation.rawOutput.stderr, ""].join("\n"),
      "utf8"
    );
    result.rawOutputPath = rawOutputPath;
  }

  return result;
}

export async function saveRotationComparisonArtifacts(
  session: TaskSession,
  comparison: ReconciliationRotationComparison
): Promise<{ jsonPath: string; markdownPath: string }> {
  const jsonPath = path.join(session.paths.plansDir, "reconciliation-rotation.json");
  const markdownPath = path.join(session.paths.plansDir, "reconciliation-rotation.md");

  await mkdir(session.paths.plansDir, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderRotationComparisonMarkdown(comparison), "utf8");

  return {
    jsonPath,
    markdownPath
  };
}

export function renderReconciliationMarkdown(
  session: TaskSession,
  reconciliation: ReconciliationOutput
): string {
  return [
    "# Reconciled Plan",
    "",
    `Session: \`${session.id}\``,
    `Reconciler: \`${reconciliation.reconcilerAgentId}\` (${reconciliation.displayName})`,
    `Generated: ${reconciliation.generatedAt}`,
    `Confidence: ${Math.round(reconciliation.confidence * 100)}%`,
    "",
    renderBiasWarning(reconciliation),
    renderBiasMetrics(reconciliation.metadata["reconcilerBiasMetrics"]),
    renderAliasMap(reconciliation.metadata["planAliases"]),
    "## Summary",
    "",
    reconciliation.mergedPlan.summary,
    "",
    renderList("Assumptions", reconciliation.mergedPlan.assumptions),
    renderList("Files", reconciliation.mergedPlan.files),
    renderList("Steps", reconciliation.mergedPlan.steps),
    renderList("Risks", reconciliation.mergedPlan.risks),
    renderList("Tests", reconciliation.mergedPlan.tests),
    "## Estimate",
    "",
    `- Complexity: ${reconciliation.mergedPlan.estimatedComplexity}`,
    "",
    renderResolutions(reconciliation),
    renderRejectedIdeas(reconciliation),
    renderList("Open Questions For Human", reconciliation.openQuestionsForHuman),
    "## Approval",
    "",
    "This is a candidate plan only. It is not approved automatically.",
    "",
    `Approve this reconciled plan with: \`codecouncil approve --session ${session.id} --reconciled\``,
    ""
  ].join("\n");
}

function renderBiasWarning(reconciliation: ReconciliationOutput): string {
  if (reconciliation.metadata["reconcilerWasAlsoPlanner"] !== true) {
    return "";
  }

  const warning = typeof reconciliation.metadata["reconcilerBiasWarning"] === "string"
    ? reconciliation.metadata["reconcilerBiasWarning"]
    : "The reconciler also produced one of the source plans, so this reconciliation may contain model self-preference bias.";

  return [
    "## Bias Disclosure",
    "",
    `Warning: ${warning}`,
    ""
  ].join("\n");
}

function renderBiasMetrics(value: unknown): string {
  const metrics = readReconcilerBiasMetrics(value);

  if (!metrics) {
    return "";
  }

  return [
    "## Bias Metrics",
    "",
    `- Reconciler: \`${metrics.reconcilerAgentId}\``,
    `- Reconciler was also planner: ${metrics.reconcilerWasAlsoPlanner ? "yes" : "no"}`,
    `- Total disagreements resolved: ${metrics.totalResolutions}`,
    `- Reconciler-plan selections: ${metrics.reconcilerPlanSelections}`,
    `- Other-planner selections: ${metrics.otherPlannerSelections}`,
    `- Synthesis selections: ${metrics.synthesisSelections}`,
    `- Unknown selections: ${metrics.unknownSelections}`,
    "",
    "| Source Plan Agent | Selections |",
    "| --- | ---: |",
    ...metrics.sourcePlanAgentIds.map((agentId) => `| \`${agentId}\` | ${metrics.selectionsByAgentId[agentId] ?? 0} |`),
    ""
  ].join("\n");
}

function renderAliasMap(value: unknown): string {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return "";
  }

  return [
    "## Plan Aliases",
    "",
    ...Object.entries(value).map(([alias, agentId]) => `- \`${alias}\`: \`${String(agentId)}\``),
    ""
  ].join("\n");
}

function renderResolutions(reconciliation: ReconciliationOutput): string {
  const lines = ["## Resolutions", ""];

  if (reconciliation.resolutions.length === 0) {
    lines.push("- None");
  } else {
    lines.push(
      ...reconciliation.resolutions.flatMap((resolution) => [
        `- ${resolution.disagreement}`,
        `  - Chosen: \`${resolution.chosenAgentId}\``,
        `  - Rationale: ${resolution.rationale}`,
        `  - Evidence: ${resolution.evidence.length > 0 ? resolution.evidence.map((item) => `\`${item}\``).join(", ") : "not provided"}`
      ])
    );
  }

  const unverifiable = reconciliation.resolutions.filter((resolution) => resolution.evidence.length === 0);

  if (unverifiable.length > 0) {
    lines.push("", "### Evidence Warnings", "");
    lines.push(...unverifiable.map((resolution) => `- No file evidence for: ${resolution.disagreement}`));
  }

  lines.push("");
  return lines.join("\n");
}

function renderRejectedIdeas(reconciliation: ReconciliationOutput): string {
  const lines = ["## Rejected Ideas", ""];

  if (reconciliation.rejectedIdeas.length === 0) {
    lines.push("- None");
  } else {
    lines.push(
      ...reconciliation.rejectedIdeas.map((idea) => `- \`${idea.agentId}\`: ${idea.item} - ${idea.why}`)
    );
  }

  lines.push("");
  return lines.join("\n");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderRotationComparisonMarkdown(comparison: ReconciliationRotationComparison): string {
  return [
    "# Reconciliation Rotation Comparison",
    "",
    `Session: \`${comparison.sessionId}\``,
    `Generated: ${comparison.generatedAt}`,
    "",
    "## Recommendation",
    "",
    `Inspect reconciled candidate from \`${comparison.recommendedReconcilerAgentId}\` first.`,
    "",
    comparison.recommendationReason,
    "",
    "## Candidates",
    "",
    "| Reconciler | Confidence | Resolutions | Own-Plan Picks | Synthesis Picks | Open Questions |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...comparison.candidates.map(
      (candidate) => `| \`${candidate.reconcilerAgentId}\` | ${Math.round(candidate.confidence * 100)}% | ${candidate.totalResolutions} | ${candidate.reconcilerPlanSelections} | ${candidate.synthesisSelections} | ${candidate.openQuestions} |`
    ),
    "",
    "## Source Plan Agents",
    "",
    ...comparison.sourcePlanAgentIds.map((agentId) => `- \`${agentId}\``),
    "",
    "## Warnings",
    "",
    ...(comparison.warnings.length > 0 ? comparison.warnings.map((warning) => `- ${warning}`) : ["- None"]),
    "",
    "## Approval",
    "",
    "Rotation creates multiple candidate reconciliations. CodeCouncil writes the recommended candidate to `plans/reconciled.json`, but it is still only a candidate until you run `codecouncil approve --session <id> --reconciled`.",
    ""
  ].join("\n");
}

function sanitizeArtifactName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/giu, "-");
}
