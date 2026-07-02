import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";

import { CodeCouncilError } from "../core/errors.js";
import {
  applyModelSelectionToConfig,
  formatModelSelectionArgs,
  parseModelSelection,
  type ModelSelection
} from "../core/modelSelection.js";
import { redactSecrets } from "../core/redact.js";
import { runDoctorChecks, type DoctorCheck } from "./doctor.js";
import { runPlanningStage, type PlanningStageResult } from "../workflow/planning.js";
import {
  collectWorkflowArtifacts,
  getWorkflowStatePath,
  inferWorkflowState,
  saveWorkflowState,
  suggestNextCommand,
  type WorkflowState,
  type WorkflowStatus
} from "../workflow/state.js";
import {
  appendSessionEvent,
  approveAgentPlan,
  approvePlanFromMarkdown,
  approveReconciledPlan,
  createTaskSession,
  loadTaskSession,
  type ApprovalArtifacts,
  type TaskSession
} from "../session/index.js";
import { writeResult } from "./context.js";
import {
  collectRepeatableOption,
  formatConfigSource,
  joinTaskWords,
  loadRuntimeContext,
  parseAgentsOption,
  relativeToCwd
} from "./shared.js";
import type { AgentId } from "../config/schema.js";
import type { PlanComparison, PlanOutput } from "../agents/index.js";

interface SolveOptions {
  agents?: string;
  approvedPlan?: string;
  autoApprovePlan?: boolean;
  dryRun?: boolean;
  implement?: string;
  maxDuration?: string;
  model?: string[];
  models?: string;
  reconcile?: boolean | string;
  report?: boolean;
  review?: boolean;
  runTests?: boolean;
  workspaceDir?: string;
  yes?: boolean;
}

interface ResumeOptions {
  session?: string;
}

interface SuggestedApprovalArtifacts {
  jsonPath: string;
  markdownPath: string;
  sourceAgentId?: string;
}

interface InternalCliCommandArtifacts {
  commandMetadataPath: string;
  durationMs: number;
  stage: string;
  status: "success" | "failed";
  stderrPath: string;
  stdoutPath: string;
}

export function registerSolveCommand(program: Command): void {
  program
    .command("solve")
    .description("Run the guided CodeCouncil workflow while preserving human control.")
    .argument("[task...]", "task description to solve")
    .option("--agents <agents>", "comma-separated agent ids to include")
    .option("--auto-approve-plan", "approve the suggested agent plan after comparison")
    .option("--approved-plan <file>", "markdown file to use as the approved plan")
    .option("--implement <agent|both>", "implementation agent id, comma-separated ids, or both")
    .option("-m, --model <model>", "model override for this solve run; use agent=model for one agent", collectRepeatableOption)
    .option("--models <models>", "comma-separated model overrides, for example codex=gpt-5.5,claude=sonnet")
    .option("--reconcile [strategy]", "run reconciliation before approval; strategy: single or rotate", parseSolveReconcileOption)
    .option("--run-tests", "run the test phase after implementation")
    .option("--review", "run cross-agent review after implementation")
    .option("--report", "generate a final report after requested stages")
    .option("--dry-run", "show the workflow stages without creating sessions or running agents")
    .option("--yes", "accept non-destructive confirmations")
    .option("--max-duration <seconds>", "maximum solve orchestration duration in seconds")
    .option("--workspace-dir <path>", "override the CodeCouncil workspace directory")
    .action(async (taskWords: string[] | undefined, options: SolveOptions, command: Command) => {
      const task = joinTaskWords(taskWords);

      if (!task) {
        throw new CodeCouncilError("Missing task description for solve.", {
          code: "MISSING_TASK",
          exitCode: 2
        });
      }

      if (options.autoApprovePlan && options.approvedPlan) {
        throw new CodeCouncilError("Use either --auto-approve-plan or --approved-plan, not both.", {
          code: "CONFLICTING_APPROVAL_OPTIONS",
          exitCode: 2
        });
      }

      const runtime = await loadRuntimeContext(command);
      const selectedAgentIds = parseAgentsOption(options.agents);
      const modelSelection = parseModelSelection({
        model: options.model,
        models: options.models
      });
      const config = applyModelSelectionToConfig(runtime.loadedConfig.config, modelSelection, {
        targetAgentIds: selectedAgentIds
      });
      const modelArgs = formatModelSelectionArgs(modelSelection);
      const deadlineMs = parseMaxDurationDeadline(options.maxDuration);
      const plannedStages = buildPlannedStages(options);

      if (options.dryRun) {
        writeResult(
          runtime.commandContext,
          {
            agents: selectedAgentIds.length > 0 ? selectedAgentIds : "enabled agents",
            command: "solve",
            config: formatConfigSource(runtime.loadedConfig),
            dryRun: true,
            modelSelection,
            plannedStages,
            status: "dry-run",
            task
          },
          [
            "Solve dry run.",
            `Task: ${task}`,
            `Agents: ${selectedAgentIds.length > 0 ? selectedAgentIds.join(", ") : "enabled agents"}`,
            ...formatModelSelectionLines(modelSelection),
            `Stages: ${plannedStages.join(" -> ")}`,
            "No session was created and no agents were executed."
          ]
        );
        return;
      }

      let session: TaskSession | undefined;
      let currentStage = "created";
      const completedStages: WorkflowStatus[] = [];
      const internalCommandOutputs: InternalCliCommandArtifacts[] = [];
      const reconcileStrategy = resolveSolveReconcileStrategy(options.reconcile);

      try {
        session = await createTaskSession({
          config,
          rootDir: runtime.loadedConfig.rootDir,
          task
        });
        addCompletedStage(completedStages, "created");
        await saveWorkflowState(session, {
          artifacts: await collectWorkflowArtifacts(session),
          completedStages,
          status: "created"
        });

        currentStage = "doctor";
        assertWithinDeadline(deadlineMs, currentStage);
        const doctorChecks = await runDoctorChecks({
          rootDir: runtime.loadedConfig.rootDir,
          testCommands: config.testCommands,
          workspaceDir: config.workspaceDir
        });
        await appendSessionEvent(session, {
          type: "workflow.doctor.completed",
          status: doctorChecks.some((check) => check.status === "error") ? "failed" : "success",
          message: "Completed doctor checks for solve workflow.",
          metadata: {
            checks: doctorChecks
          }
        });

        currentStage = "plan";
        assertWithinDeadline(deadlineMs, currentStage);
        const planning = await runPlanningStage({
          agentIds: selectedAgentIds,
          config,
          ...(deadlineMs ? { deadlineMs } : {}),
          repoRoot: runtime.loadedConfig.rootDir,
          session,
          task
        });
        const suggestedApproval = await saveSuggestedApprovalArtifacts({
          comparison: planning.comparison,
          plans: planning.plans,
          session
        });
        let artifacts = await collectWorkflowArtifacts(session);
        addCompletedStage(completedStages, "planned");
        await saveWorkflowState(session, {
          artifacts,
          completedStages,
          status: "planned"
        });

        if (reconcileStrategy) {
          currentStage = "reconcile";
          assertWithinDeadline(deadlineMs, currentStage);
          internalCommandOutputs.push(await runInternalCliCommand(
            [
              ...buildInternalGlobalArgs(runtime.commandContext.cwd, runtime.loadedConfig.path, options.workspaceDir),
              "reconcile",
              "--session",
              session.id,
              "--strategy",
              reconcileStrategy,
              ...modelArgs
            ],
            {
              index: internalCommandOutputs.length + 1,
              session,
              stage: "reconcile"
            }
          ));
          artifacts = await collectWorkflowArtifacts(session);
          await saveWorkflowState(session, {
            artifacts,
            completedStages,
            status: "planned"
          });
        }

        const shouldAttemptApproval = options.approvedPlan !== undefined || options.autoApprovePlan === true;

        if (shouldAttemptApproval) {
          currentStage = "approve";
          assertWithinDeadline(deadlineMs, currentStage);
        }

        const approvalArtifacts = await maybeApprovePlan({
          didReconcile: reconcileStrategy !== undefined,
          options,
          planning,
          runtimeCwd: runtime.commandContext.cwd,
          session
        });

        if (approvalArtifacts) {
          await appendSessionEvent(session, {
            type: "plan.approved",
            status: "success",
            message: "Approved a plan through solve workflow.",
            metadata: {
              jsonPath: approvalArtifacts.jsonPath,
              markdownPath: approvalArtifacts.markdownPath
            }
          });
          artifacts = await collectWorkflowArtifacts(session);
          addCompletedStage(completedStages, "approved");
          await saveWorkflowState(session, {
            artifacts,
            completedStages,
            status: "approved"
          });
        }

        const implementationAgents = resolveImplementationAgents(options.implement, planning.agents);
        const canProceedPastPlanning = approvalArtifacts !== undefined;
        const skippedStages: string[] = [];

        if (implementationAgents.length > 0 && !canProceedPastPlanning) {
          skippedStages.push("implementation requires --auto-approve-plan or --approved-plan");
        }

        if (implementationAgents.length > 0 && canProceedPastPlanning) {
          currentStage = "implement";
          assertWithinDeadline(deadlineMs, currentStage);
          internalCommandOutputs.push(await runInternalCliCommand(
            [
              ...buildInternalGlobalArgs(runtime.commandContext.cwd, runtime.loadedConfig.path, options.workspaceDir),
              "implement",
              "--session",
              session.id,
              "--agents",
              implementationAgents.join(","),
              ...modelArgs
            ],
            {
              index: internalCommandOutputs.length + 1,
              session,
              stage: "implement"
            }
          ));
          artifacts = await collectWorkflowArtifacts(session);
          addCompletedStage(completedStages, "implemented");
          await saveWorkflowState(session, {
            artifacts,
            completedStages,
            status: "implemented"
          });
        }

        if (options.runTests && implementationAgents.length > 0 && canProceedPastPlanning) {
          currentStage = "test";
          assertWithinDeadline(deadlineMs, currentStage);
          internalCommandOutputs.push(await runInternalCliCommand(
            [
              ...buildInternalGlobalArgs(runtime.commandContext.cwd, runtime.loadedConfig.path, options.workspaceDir),
              "test",
              "--session",
              session.id,
              "--agents",
              implementationAgents.join(",")
            ],
            {
              index: internalCommandOutputs.length + 1,
              session,
              stage: "test"
            }
          ));
          artifacts = await collectWorkflowArtifacts(session);
          addCompletedStage(completedStages, "tested");
          await saveWorkflowState(session, {
            artifacts,
            completedStages,
            status: "tested"
          });
        } else if (options.runTests) {
          skippedStages.push("tests require implementation in this solve run");
        }

        if (options.review && implementationAgents.length > 1 && canProceedPastPlanning) {
          currentStage = "review";
          assertWithinDeadline(deadlineMs, currentStage);
          internalCommandOutputs.push(await runInternalCliCommand(
            [
              ...buildInternalGlobalArgs(runtime.commandContext.cwd, runtime.loadedConfig.path, options.workspaceDir),
              "review",
              "--session",
              session.id,
              "--reviewers",
              implementationAgents.join(","),
              "--targets",
              implementationAgents.join(","),
              ...modelArgs
            ],
            {
              index: internalCommandOutputs.length + 1,
              session,
              stage: "review"
            }
          ));
          artifacts = await collectWorkflowArtifacts(session);
          addCompletedStage(completedStages, "reviewed");
          await saveWorkflowState(session, {
            artifacts,
            completedStages,
            status: "reviewed"
          });
        } else if (options.review) {
          skippedStages.push("review requires at least two implemented agents");
        }

        if (options.report && implementationAgents.length > 0 && canProceedPastPlanning) {
          currentStage = "report";
          assertWithinDeadline(deadlineMs, currentStage);
          internalCommandOutputs.push(await runInternalCliCommand(
            [
              ...buildInternalGlobalArgs(runtime.commandContext.cwd, runtime.loadedConfig.path, options.workspaceDir),
              "report",
              "--session",
              session.id
            ],
            {
              index: internalCommandOutputs.length + 1,
              session,
              stage: "report"
            }
          ));
          artifacts = await collectWorkflowArtifacts(session);
          addCompletedStage(completedStages, "reported");
          await saveWorkflowState(session, {
            artifacts,
            completedStages,
            status: "reported"
          });
        } else if (options.report) {
          skippedStages.push("report requires implementation results in this solve run");
        }

        const finalWorkflow = await inferWorkflowState(session);

        writeResult(
          runtime.commandContext,
          {
            approved: approvalArtifacts !== undefined,
            approvalArtifacts,
            command: "solve",
            config: formatConfigSource(runtime.loadedConfig),
            doctorChecks,
            internalCommandOutputs,
            modelSelection,
            reconcileStrategy,
            sessionDir: session.paths.sessionDir,
            sessionId: session.id,
            skippedStages,
            status: "success",
            suggestedApproval,
            task,
            workflow: finalWorkflow,
            workflowPath: getWorkflowStatePath(session),
            yes: options.yes === true
          },
          formatSolveOutputLines({
            ...(approvalArtifacts ? { approvalArtifacts } : {}),
            doctorChecks,
            session,
            skippedStages,
            suggestedApproval,
            workflow: finalWorkflow,
            cwd: runtime.commandContext.cwd,
            modelSelection
          })
        );
      } catch (error) {
        if (session) {
          await saveWorkflowState(session, {
            artifacts: await collectWorkflowArtifacts(session),
            completedStages,
            failedStage: currentStage,
            status: "failed"
          });
          await appendSessionEvent(session, {
            type: "workflow.failed",
            status: "failed",
            message: error instanceof Error ? error.message : "Solve workflow failed.",
            metadata: {
              failedStage: currentStage
            }
          });
        }

        throw error;
      }
    });
}

export function registerResumeCommand(program: Command): void {
  program
    .command("resume")
    .description("Inspect a CodeCouncil session and suggest the next workflow command.")
    .option("--session <id>", "session id to resume")
    .action(async (options: ResumeOptions, command: Command) => {
      const runtime = await loadRuntimeContext(command);

      if (!options.session) {
        throw new CodeCouncilError("Resume requires --session.", {
          code: "MISSING_SESSION",
          exitCode: 2
        });
      }

      const session = await loadTaskSession({
        rootDir: runtime.loadedConfig.rootDir,
        sessionId: options.session,
        workspaceDir: runtime.loadedConfig.config.workspaceDir
      });
      const workflow = await inferWorkflowState(session);

      writeResult(
        runtime.commandContext,
        {
          command: "resume",
          session,
          status: "success",
          workflow,
          workflowPath: getWorkflowStatePath(session)
        },
        [
          "Resume suggestion.",
          `Session: ${session.id}`,
          `Current state: ${workflow.status}`,
          `Next: ${workflow.nextRecommendedCommand ?? suggestNextCommand(session, workflow.status, workflow.artifacts)}`,
          `Workflow state: ${relativeToCwd(runtime.commandContext, getWorkflowStatePath(session))}`,
          "",
          ...formatArtifactLines(workflow.artifacts, runtime.commandContext.cwd)
        ]
      );
    });
}

async function maybeApprovePlan(input: {
  didReconcile: boolean;
  options: SolveOptions;
  planning: PlanningStageResult;
  runtimeCwd: string;
  session: TaskSession;
}): Promise<ApprovalArtifacts | undefined> {
  if (input.options.approvedPlan) {
    const approvedPlanPath = path.resolve(input.runtimeCwd, input.options.approvedPlan);
    const markdown = await readFile(approvedPlanPath, "utf8");
    return approvePlanFromMarkdown(input.session, markdown, {
      sourcePath: approvedPlanPath
    });
  }

  if (input.options.autoApprovePlan) {
    if (input.didReconcile) {
      return approveReconciledPlan(input.session);
    }

    const agentId = input.planning.comparison.suggestedImplementationAgent ?? input.planning.agents[0];

    if (!agentId) {
      throw new CodeCouncilError("No agent plan is available to auto approve.", {
        code: "NO_PLAN_TO_APPROVE",
        exitCode: 2
      });
    }

    return approveAgentPlan(input.session, agentId);
  }

  return undefined;
}

async function saveSuggestedApprovalArtifacts(input: {
  comparison: PlanComparison;
  plans: readonly PlanOutput[];
  session: TaskSession;
}): Promise<SuggestedApprovalArtifacts> {
  const sourceAgentId = input.comparison.suggestedImplementationAgent ?? input.plans[0]?.agentId;
  const plan = input.plans.find((candidate) => candidate.agentId === sourceAgentId) ?? input.plans[0];
  const jsonPath = path.join(input.session.paths.plansDir, "suggested-approved-plan.json");
  const markdownPath = path.join(input.session.paths.plansDir, "suggested-approved-plan.md");
  const payload = {
    createdAt: new Date().toISOString(),
    sessionId: input.session.id,
    sourceAgentId,
    status: "suggested",
    summary: plan?.summary ?? input.comparison.recommendedApproach,
    plan,
    comparison: input.comparison
  };

  await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderSuggestedApprovalMarkdown(input.session, input.comparison, plan), "utf8");

  return {
    jsonPath,
    markdownPath,
    ...(sourceAgentId ? { sourceAgentId } : {})
  };
}

function renderSuggestedApprovalMarkdown(
  session: TaskSession,
  comparison: PlanComparison,
  plan: PlanOutput | undefined
): string {
  return [
    "# Suggested Approved Plan",
    "",
    `Session: \`${session.id}\``,
    "Status: suggested, not yet approved",
    `Source agent: \`${plan?.agentId ?? "none"}\``,
    "",
    "## Summary",
    "",
    plan?.summary ?? comparison.recommendedApproach,
    "",
    "## Recommended Approach",
    "",
    comparison.recommendedApproach,
    "",
    renderList("Files Proposed", plan?.proposedFilesToChange ?? []),
    renderList("Implementation Steps", plan?.stepByStepPlan ?? []),
    renderList("Risks", plan?.risks ?? comparison.riskyAreas),
    renderList("Tests To Run", plan?.testsToRun ?? []),
    "## Approval",
    "",
    `Approve this source plan with: \`codecouncil approve --session ${session.id} --agent ${plan?.agentId ?? "<agent>"}\``,
    "Or edit this file and rerun solve with `--approved-plan <file>`.",
    ""
  ].join("\n");
}

function resolveImplementationAgents(
  implementOption: string | undefined,
  plannedAgents: readonly AgentId[]
): AgentId[] {
  if (!implementOption) {
    return [];
  }

  if (implementOption.trim().toLowerCase() === "both") {
    return [...plannedAgents];
  }

  return parseAgentsOption(implementOption);
}

function buildInternalGlobalArgs(cwd: string, configPath: string | undefined, workspaceDir: string | undefined): string[] {
  const args = ["--cwd", cwd, "--json"];

  if (configPath) {
    args.push("--config", configPath);
  }

  if (workspaceDir) {
    args.push("--workspace-dir", workspaceDir);
  }

  return args;
}

async function runInternalCliCommand(
  argv: readonly string[],
  options: {
    index: number;
    session: TaskSession;
    stage: string;
  }
): Promise<InternalCliCommandArtifacts> {
  const { createCli } = await import("../cli.js");
  const originalWrite = process.stdout.write;
  const originalErrorWrite = process.stderr.write;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const startedAt = new Date();

  process.stdout.write = captureWrite(stdoutChunks) as typeof process.stdout.write;
  process.stderr.write = captureWrite(stderrChunks) as typeof process.stderr.write;

  try {
    await createCli().parseAsync(["node", "codecouncil", ...argv]);
    return await saveInternalCliCommandArtifacts({
      argv,
      completedAt: new Date(),
      error: undefined,
      index: options.index,
      session: options.session,
      stage: options.stage,
      startedAt,
      status: "success",
      stderr: stderrChunks.join(""),
      stdout: stdoutChunks.join("")
    });
  } catch (error) {
    await saveInternalCliCommandArtifacts({
      argv,
      completedAt: new Date(),
      error: error instanceof Error ? error.message : "Internal CLI command failed.",
      index: options.index,
      session: options.session,
      stage: options.stage,
      startedAt,
      status: "failed",
      stderr: stderrChunks.join(""),
      stdout: stdoutChunks.join("")
    });
    throw error;
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrorWrite;
  }
}

function captureWrite(chunks: string[]): NodeJS.WriteStream["write"] {
  return ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
  ): boolean => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));

    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return true;
  }) as NodeJS.WriteStream["write"];
}

async function saveInternalCliCommandArtifacts(input: {
  argv: readonly string[];
  completedAt: Date;
  error: string | undefined;
  index: number;
  session: TaskSession;
  stage: string;
  startedAt: Date;
  status: "success" | "failed";
  stderr: string;
  stdout: string;
}): Promise<InternalCliCommandArtifacts> {
  const workflowDir = path.join(input.session.paths.sessionDir, "workflow");
  await mkdir(workflowDir, { recursive: true });

  const basename = `${String(input.index).padStart(2, "0")}-${sanitizeArtifactName(input.stage)}`;
  const stdoutPath = path.join(workflowDir, `${basename}.stdout.log`);
  const stderrPath = path.join(workflowDir, `${basename}.stderr.log`);
  const commandMetadataPath = path.join(workflowDir, `${basename}.command.json`);
  const durationMs = input.completedAt.getTime() - input.startedAt.getTime();
  const metadata = {
    argv: input.argv.map((arg) => redactSecrets(arg)),
    completedAt: input.completedAt.toISOString(),
    durationMs,
    ...(input.error ? { error: redactSecrets(input.error) } : {}),
    stage: input.stage,
    startedAt: input.startedAt.toISOString(),
    status: input.status
  };

  await writeFile(stdoutPath, redactSecrets(input.stdout), "utf8");
  await writeFile(stderrPath, redactSecrets(input.stderr), "utf8");
  await writeFile(commandMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  return {
    commandMetadataPath,
    durationMs,
    stage: input.stage,
    status: input.status,
    stderrPath,
    stdoutPath
  };
}

function sanitizeArtifactName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "command";
}

function parseSolveReconcileOption(value: string): "single" | "rotate" {
  const strategy = value.trim().toLowerCase();

  if (strategy === "single" || strategy === "rotate") {
    return strategy;
  }

  throw new CodeCouncilError(`Unknown reconciliation strategy "${value}". Use "single" or "rotate".`, {
    code: "INVALID_RECONCILE_STRATEGY",
    exitCode: 2
  });
}

function resolveSolveReconcileStrategy(value: boolean | string | undefined): "single" | "rotate" | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }

  if (value === true) {
    return "single";
  }

  return parseSolveReconcileOption(value);
}

function addCompletedStage(stages: WorkflowStatus[], stage: WorkflowStatus): void {
  if (!stages.includes(stage)) {
    stages.push(stage);
  }
}

function parseMaxDurationDeadline(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);

  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CodeCouncilError("--max-duration must be a positive number of seconds.", {
      code: "INVALID_MAX_DURATION",
      exitCode: 2
    });
  }

  return Date.now() + seconds * 1000;
}

function assertWithinDeadline(deadlineMs: number | undefined, stage: string): void {
  if (deadlineMs !== undefined && Date.now() > deadlineMs) {
    throw new CodeCouncilError(`Solve workflow exceeded --max-duration before ${stage}.`, {
      code: "WORKFLOW_TIMEOUT",
      exitCode: 2
    });
  }
}

function buildPlannedStages(options: SolveOptions): string[] {
  const stages = ["create-session", "doctor", "plan", "compare", "suggest-approval"];

  if (options.reconcile !== undefined && options.reconcile !== false) {
    stages.push("reconcile");
  }

  if (options.autoApprovePlan || options.approvedPlan) {
    stages.push("approve");
  }

  if (options.implement) {
    stages.push("implement");
  }

  if (options.runTests) {
    stages.push("test");
  }

  if (options.review) {
    stages.push("review");
  }

  if (options.report) {
    stages.push("report");
  }

  return stages;
}

function formatSolveOutputLines(input: {
  approvalArtifacts?: ApprovalArtifacts;
  cwd: string;
  doctorChecks: readonly DoctorCheck[];
  modelSelection: ModelSelection;
  session: TaskSession;
  skippedStages: readonly string[];
  suggestedApproval: SuggestedApprovalArtifacts;
  workflow: WorkflowState;
}): string[] {
  return [
    "Solve workflow checkpoint.",
    `Session: ${input.session.id}`,
    `Current state: ${input.workflow.status}`,
    `Session dir: ${path.relative(input.cwd, input.session.paths.sessionDir) || "."}`,
    `Doctor: ${summarizeDoctorChecks(input.doctorChecks)}`,
    ...formatModelSelectionLines(input.modelSelection),
    `Suggested plan: ${path.relative(input.cwd, input.suggestedApproval.markdownPath)}`,
    input.approvalArtifacts
      ? `Approved plan: ${path.relative(input.cwd, input.approvalArtifacts.markdownPath)}`
      : "Approved plan: not created",
    `Workflow state: ${path.relative(input.cwd, getWorkflowStatePath(input.session))}`,
    "",
    "Generated files:",
    ...formatArtifactLines(input.workflow.artifacts, input.cwd),
    ...(input.skippedStages.length > 0 ? ["", "Skipped stages:", ...input.skippedStages.map((stage) => `- ${stage}`)] : []),
    "",
    `Next: ${input.workflow.nextRecommendedCommand ?? suggestNextCommand(input.session, input.workflow.status, input.workflow.artifacts)}`
  ];
}

function formatModelSelectionLines(selection: ModelSelection): string[] {
  const assignments = Object.entries(selection.byAgent);

  if (!selection.defaultModel && assignments.length === 0) {
    return [];
  }

  return [
    `Model override: ${[
      selection.defaultModel ? `default=${selection.defaultModel}` : "",
      ...assignments.map(([agentId, model]) => `${agentId}=${model}`)
    ].filter(Boolean).join(", ")}`
  ];
}

function formatArtifactLines(artifacts: Record<string, readonly string[]>, cwd: string): string[] {
  const entries = Object.entries(artifacts);

  if (entries.length === 0) {
    return ["- None"];
  }

  return entries.flatMap(([label, files]) => [
    `- ${label}:`,
    ...files.map((filePath) => `  - ${path.relative(cwd, filePath) || "."}`)
  ]);
}

function summarizeDoctorChecks(checks: readonly DoctorCheck[]): string {
  const errors = checks.filter((check) => check.status === "error").length;
  const warnings = checks.filter((check) => check.status === "warning").length;

  if (errors > 0) {
    return `${errors} error(s), ${warnings} warning(s)`;
  }

  if (warnings > 0) {
    return `${warnings} warning(s)`;
  }

  return "ok";
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
