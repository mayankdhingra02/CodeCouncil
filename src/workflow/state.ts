import { access, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { isErrnoException } from "../core/errors.js";
import type { TaskSession } from "../session/index.js";

export const workflowStatusSchema = z.enum([
  "created",
  "planned",
  "approved",
  "implemented",
  "tested",
  "reviewed",
  "reported",
  "failed"
]);

export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

export const workflowStateSchema = z
  .object({
    artifacts: z.record(z.array(z.string())).default({}),
    completedStages: z.array(workflowStatusSchema).default([]),
    failedStage: z.string().optional(),
    nextRecommendedCommand: z.string().optional(),
    sessionId: z.string().min(1),
    status: workflowStatusSchema,
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict();

export type WorkflowState = z.infer<typeof workflowStateSchema>;

export function getWorkflowStatePath(session: TaskSession): string {
  return path.join(session.paths.sessionDir, "workflow.json");
}

export async function saveWorkflowState(
  session: TaskSession,
  state: Omit<WorkflowState, "nextRecommendedCommand" | "sessionId" | "updatedAt"> & {
    nextRecommendedCommand?: string;
    sessionId?: string;
    updatedAt?: string;
  }
): Promise<WorkflowState> {
  const workflowState = workflowStateSchema.parse({
    ...state,
    nextRecommendedCommand:
      state.nextRecommendedCommand ?? suggestNextCommand(session, state.status, state.artifacts),
    sessionId: state.sessionId ?? session.id,
    updatedAt: state.updatedAt ?? new Date().toISOString()
  });

  await writeFile(getWorkflowStatePath(session), `${JSON.stringify(workflowState, null, 2)}\n`, "utf8");
  return workflowState;
}

export async function loadWorkflowState(session: TaskSession): Promise<WorkflowState | undefined> {
  const statePath = getWorkflowStatePath(session);

  try {
    return workflowStateSchema.parse(JSON.parse(await readFile(statePath, "utf8")) as unknown);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

export async function inferWorkflowState(session: TaskSession): Promise<WorkflowState> {
  const explicitState = await loadWorkflowState(session);
  const artifacts = await collectWorkflowArtifacts(session);
  const inferredStatus =
    explicitState?.status === "failed" ? "failed" : inferStatusFromArtifacts(artifacts);
  const completedStages = collectCompletedStages(inferredStatus, artifacts);

  return workflowStateSchema.parse({
    artifacts,
    completedStages,
    ...(explicitState?.failedStage ? { failedStage: explicitState.failedStage } : {}),
    nextRecommendedCommand: suggestNextCommand(session, inferredStatus, artifacts),
    sessionId: session.id,
    status: inferredStatus,
    updatedAt: explicitState?.updatedAt ?? new Date().toISOString()
  });
}

export async function collectWorkflowArtifacts(
  session: TaskSession
): Promise<Record<string, string[]>> {
  const artifacts: Record<string, string[]> = {};
  const planFiles = await listExistingFiles(session.paths.plansDir, (fileName) =>
    /^.+\.(json|md)$/u.test(fileName)
  );
  const implementationFiles = await listImplementationFiles(session);
  const reviewFiles = await listExistingFiles(session.paths.reviewsDir, (fileName) =>
    /^.+\.(json|md)$/u.test(fileName)
  );

  if (planFiles.length > 0) {
    artifacts["plans"] = planFiles;
  }

  await addIfExists(artifacts, "comparison", path.join(session.paths.plansDir, "comparison.json"));
  await addIfExists(
    artifacts,
    "reconciliationRotation",
    path.join(session.paths.plansDir, "reconciliation-rotation.json")
  );
  await addIfExists(
    artifacts,
    "suggestedApproval",
    path.join(session.paths.plansDir, "suggested-approved-plan.md")
  );
  await addIfExists(artifacts, "reconciledPlan", path.join(session.paths.plansDir, "reconciled.json"));
  await addIfExists(artifacts, "approvedPlan", path.join(session.paths.sessionDir, "approved-plan.json"));

  if (implementationFiles.length > 0) {
    artifacts["implementations"] = implementationFiles;
  }

  await addIfExists(artifacts, "tests", path.join(session.paths.testsDir, "summary.json"));
  await addIfExists(
    artifacts,
    "scores",
    path.join(session.paths.sessionDir, "scores", "implementation-scores.json")
  );

  if (reviewFiles.length > 0) {
    artifacts["reviews"] = reviewFiles;
  }

  await addIfExists(artifacts, "reviewSummary", path.join(session.paths.reviewsDir, "summary.json"));
  await addIfExists(
    artifacts,
    "safety",
    path.join(session.paths.sessionDir, "safety", "safety-summary.json")
  );
  await addIfExists(artifacts, "report", path.join(session.paths.reportsDir, "final-recommendation.json"));

  return Object.fromEntries(
    Object.entries(artifacts).map(([key, values]) => [key, [...new Set(values)].sort()])
  );
}

export function suggestNextCommand(
  session: TaskSession,
  status: WorkflowStatus,
  artifacts: Record<string, readonly string[]> = {}
): string {
  const agents = inferAgentsFromArtifacts(artifacts);
  const agentsCsv = agents.length > 0 ? agents.join(",") : "<agents>";
  const suggestedAgent = agents[0] ?? "<agent>";

  switch (status) {
    case "created":
      return `codecouncil plan "${session.task}"`;
    case "planned":
      return artifacts["reconciledPlan"]?.length
        ? `codecouncil approve --session ${session.id} --reconciled`
        : `codecouncil reconcile --session ${session.id} --reconciler ${suggestedAgent}`;
    case "approved":
      return `codecouncil implement --session ${session.id} --agents ${agentsCsv}`;
    case "implemented":
      return `codecouncil test --session ${session.id} --agents ${agentsCsv}`;
    case "tested":
      return `codecouncil review --session ${session.id} --reviewers ${agentsCsv} --targets ${agentsCsv}`;
    case "reviewed":
      return `codecouncil report --session ${session.id}`;
    case "reported":
      return `codecouncil apply --session ${session.id} --agent ${suggestedAgent} --dry-run`;
    case "failed":
      return `codecouncil resume --session ${session.id}`;
  }
}

function inferStatusFromArtifacts(artifacts: Record<string, readonly string[]>): WorkflowStatus {
  if (artifacts["report"]?.length) {
    return "reported";
  }

  if (artifacts["reviewSummary"]?.length) {
    return "reviewed";
  }

  if (artifacts["tests"]?.length) {
    return "tested";
  }

  if (artifacts["implementations"]?.length) {
    return "implemented";
  }

  if (artifacts["approvedPlan"]?.length) {
    return "approved";
  }

  if (artifacts["comparison"]?.length) {
    return "planned";
  }

  return "created";
}

function collectCompletedStages(
  status: WorkflowStatus,
  artifacts: Record<string, readonly string[]>
): WorkflowStatus[] {
  if (status === "failed") {
    return [];
  }

  const stages: WorkflowStatus[] = ["created"];

  if (artifacts["comparison"]?.length) {
    stages.push("planned");
  }

  if (artifacts["approvedPlan"]?.length) {
    stages.push("approved");
  }

  if (artifacts["implementations"]?.length) {
    stages.push("implemented");
  }

  if (artifacts["tests"]?.length) {
    stages.push("tested");
  }

  if (artifacts["reviewSummary"]?.length) {
    stages.push("reviewed");
  }

  if (artifacts["report"]?.length) {
    stages.push("reported");
  }

  return stages;
}

function inferAgentsFromArtifacts(artifacts: Record<string, readonly string[]>): string[] {
  const plans = artifacts["plans"] ?? [];
  const agentIds = plans.flatMap((filePath) => {
    const baseName = path.basename(filePath);

    if ([
      "comparison.json",
      "comparison.md",
      "reconciliation-rotation.json",
      "reconciliation-rotation.md",
      "reconciled.json",
      "reconciled.md",
      "suggested-approved-plan.json",
      "suggested-approved-plan.md"
    ].includes(baseName)) {
      return [];
    }

    if (baseName.endsWith(".command.json") || baseName.endsWith(".parsed.json")) {
      return [];
    }

    const match = /^(?<agent>.+)\.json$/u.exec(baseName);
    return match?.groups?.["agent"] ? [match.groups["agent"]] : [];
  });

  return [...new Set(agentIds)].sort();
}

async function listImplementationFiles(session: TaskSession): Promise<string[]> {
  const runsDir = path.join(session.paths.sessionDir, "runs");
  const entries = await listDirectoryIfExists(runsDir);
  const files = [];

  for (const entry of entries) {
    const implementationPath = path.join(runsDir, entry, "implementation.json");

    if (await pathExists(implementationPath)) {
      files.push(implementationPath);
    }
  }

  return files;
}

async function listExistingFiles(
  directoryPath: string,
  predicate: (fileName: string) => boolean
): Promise<string[]> {
  const entries = await listDirectoryIfExists(directoryPath);
  const files = [];

  for (const entry of entries) {
    if (!predicate(entry)) {
      continue;
    }

    const filePath = path.join(directoryPath, entry);

    if (await pathExists(filePath)) {
      files.push(filePath);
    }
  }

  return files;
}

async function listDirectoryIfExists(directoryPath: string): Promise<string[]> {
  try {
    return await readdir(directoryPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function addIfExists(
  artifacts: Record<string, string[]>,
  key: string,
  filePath: string
): Promise<void> {
  if (!(await pathExists(filePath))) {
    return;
  }

  artifacts[key] = [...(artifacts[key] ?? []), filePath];
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}
