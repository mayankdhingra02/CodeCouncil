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

export async function saveReconciliationArtifacts(
  session: TaskSession,
  reconciliation: ReconciliationOutput
): Promise<SavedReconciliationArtifact> {
  await mkdir(session.paths.plansDir, { recursive: true });

  const jsonPath = path.join(session.paths.plansDir, "reconciled.json");
  const markdownPath = path.join(session.paths.plansDir, "reconciled.md");
  const metadataPath = path.join(session.paths.plansDir, "reconciled.command.json");
  const parsedOutputPath = path.join(session.paths.plansDir, "reconciled.parsed.json");
  const rawOutputPath = path.join(session.paths.plansDir, "reconciled.raw.txt");

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
