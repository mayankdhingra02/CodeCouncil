import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { reconciliationOutputSchema } from "../agents/types.js";
import { isErrnoException } from "../core/errors.js";
import type { PlanOutput, ReconciliationOutput } from "../agents/types.js";
import type { TaskSession } from "./schema.js";

export const approvedPlanSchema = z
  .object({
    approvedAt: z.string().datetime({ offset: true }),
    approvedBy: z.enum(["agent", "manual", "reconciled"]),
    agentId: z.string().optional(),
    plan: z.unknown().optional(),
    sessionId: z.string().min(1),
    summary: z.string().min(1)
  })
  .strict();

export type ApprovedPlan = z.infer<typeof approvedPlanSchema>;

export interface ApprovalArtifacts {
  jsonPath: string;
  markdownPath: string;
}

export async function approveAgentPlan(
  session: TaskSession,
  agentId: string,
  now = new Date()
): Promise<ApprovalArtifacts> {
  const planPath = path.join(session.paths.plansDir, `${sanitizeArtifactName(agentId)}.json`);
  const plan = JSON.parse(await readFile(planPath, "utf8")) as PlanOutput;
  const approvedPlan = approvedPlanSchema.parse({
    approvedAt: now.toISOString(),
    approvedBy: "agent",
    agentId,
    plan,
    sessionId: session.id,
    summary: plan.summary
  });

  return writeApprovalArtifacts(session, approvedPlan, renderAgentApprovalMarkdown(approvedPlan, plan));
}

export async function approveManualPlan(
  session: TaskSession,
  now = new Date()
): Promise<ApprovalArtifacts> {
  const approvedPlan = approvedPlanSchema.parse({
    approvedAt: now.toISOString(),
    approvedBy: "manual",
    sessionId: session.id,
    summary: "Manual approved plan. Edit approved-plan.md before implementation if needed."
  });

  return writeApprovalArtifacts(session, approvedPlan, renderManualApprovalMarkdown(session));
}

export async function approveReconciledPlan(
  session: TaskSession,
  now = new Date()
): Promise<ApprovalArtifacts> {
  const reconciliationPath = path.join(session.paths.plansDir, "reconciled.json");
  const reconciliation = reconciliationOutputSchema.parse(JSON.parse(await readFile(reconciliationPath, "utf8")) as unknown);
  const approvedPlan = approvedPlanSchema.parse({
    approvedAt: now.toISOString(),
    approvedBy: "reconciled",
    agentId: reconciliation.reconcilerAgentId,
    plan: reconciliation,
    sessionId: session.id,
    summary: reconciliation.mergedPlan.summary
  });

  return writeApprovalArtifacts(session, approvedPlan, renderReconciledApprovalMarkdown(approvedPlan, reconciliation));
}

export async function approvePlanFromMarkdown(
  session: TaskSession,
  markdown: string,
  options: {
    sourcePath?: string;
    now?: Date;
  } = {}
): Promise<ApprovalArtifacts> {
  const summary = extractMarkdownSummary(markdown);
  const approvedPlan = approvedPlanSchema.parse({
    approvedAt: (options.now ?? new Date()).toISOString(),
    approvedBy: "manual",
    plan: {
      ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
      markdown
    },
    sessionId: session.id,
    summary
  });

  return writeApprovalArtifacts(session, approvedPlan, normalizeApprovedMarkdown(session, markdown));
}

export async function hasApprovedPlan(session: TaskSession): Promise<boolean> {
  try {
    await access(getApprovedPlanJsonPath(session));
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export async function loadApprovedPlan(session: TaskSession): Promise<ApprovedPlan> {
  const source = await readFile(getApprovedPlanJsonPath(session), "utf8");
  return approvedPlanSchema.parse(JSON.parse(source) as unknown);
}

export async function loadApprovedPlanMarkdown(session: TaskSession): Promise<string> {
  return readFile(getApprovedPlanMarkdownPath(session), "utf8");
}

export function getApprovedPlanJsonPath(session: TaskSession): string {
  return path.join(session.paths.sessionDir, "approved-plan.json");
}

export function getApprovedPlanMarkdownPath(session: TaskSession): string {
  return path.join(session.paths.sessionDir, "approved-plan.md");
}

async function writeApprovalArtifacts(
  session: TaskSession,
  approvedPlan: ApprovedPlan,
  markdown: string
): Promise<ApprovalArtifacts> {
  const jsonPath = getApprovedPlanJsonPath(session);
  const markdownPath = getApprovedPlanMarkdownPath(session);

  await writeFile(jsonPath, `${JSON.stringify(approvedPlan, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdown, "utf8");

  return {
    jsonPath,
    markdownPath
  };
}

function renderAgentApprovalMarkdown(approvedPlan: ApprovedPlan, plan: PlanOutput): string {
  return [
    "# Approved Plan",
    "",
    `Session: \`${approvedPlan.sessionId}\``,
    `Source agent: \`${approvedPlan.agentId ?? "unknown"}\``,
    `Approved at: ${approvedPlan.approvedAt}`,
    "",
    "## Summary",
    "",
    plan.summary,
    "",
    renderList("Assumptions", plan.assumptions),
    renderList("Files Proposed", plan.proposedFilesToChange),
    renderList("Step By Step Plan", plan.stepByStepPlan),
    renderList("Risks", plan.risks),
    renderList("Tests To Run", plan.testsToRun),
    "## Notes",
    "",
    "This approved plan was copied from an agent plan. Edit this file before implementation if you want to merge ideas manually.",
    ""
  ].join("\n");
}

function renderManualApprovalMarkdown(session: TaskSession): string {
  return [
    "# Approved Plan",
    "",
    `Session: \`${session.id}\``,
    "Source: manual",
    "",
    "## Summary",
    "",
    "Write the approved implementation approach here.",
    "",
    "## Approved Files Or Areas",
    "",
    "- ",
    "",
    "## Implementation Steps",
    "",
    "1. ",
    "",
    "## Risks And Mitigations",
    "",
    "- ",
    "",
    "## Tests To Run",
    "",
    "- ",
    ""
  ].join("\n");
}

function renderReconciledApprovalMarkdown(
  approvedPlan: ApprovedPlan,
  reconciliation: ReconciliationOutput
): string {
  return [
    "# Approved Plan",
    "",
    `Session: \`${approvedPlan.sessionId}\``,
    `Source: reconciled plan from \`${reconciliation.reconcilerAgentId}\``,
    `Approved at: ${approvedPlan.approvedAt}`,
    "",
    "## Summary",
    "",
    reconciliation.mergedPlan.summary,
    "",
    renderList("Assumptions", reconciliation.mergedPlan.assumptions),
    renderList("Files Proposed", reconciliation.mergedPlan.files),
    renderList("Step By Step Plan", reconciliation.mergedPlan.steps),
    renderList("Risks", reconciliation.mergedPlan.risks),
    renderList("Tests To Run", reconciliation.mergedPlan.tests),
    "## Reconciliation Notes",
    "",
    ...reconciliation.resolutions.map(
      (resolution) => `- ${resolution.disagreement}: ${resolution.rationale}`
    ),
    "",
    "This approved plan was copied from the reconciled candidate plan. Edit this file before implementation if you want to refine it.",
    ""
  ].join("\n");
}

function normalizeApprovedMarkdown(session: TaskSession, markdown: string): string {
  const trimmed = markdown.trim();

  if (trimmed.startsWith("#")) {
    return `${trimmed}\n`;
  }

  return [
    "# Approved Plan",
    "",
    `Session: \`${session.id}\``,
    "Source: imported markdown",
    "",
    trimmed,
    ""
  ].join("\n");
}

function extractMarkdownSummary(markdown: string): string {
  const meaningfulLine = markdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));

  return meaningfulLine?.replace(/^[-*]\s+/u, "").slice(0, 240) || "Approved plan imported from markdown.";
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

function sanitizeArtifactName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-");
}
