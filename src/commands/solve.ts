import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";

import { CodeCouncilError } from "../core/errors.js";
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
  createTaskSession,
  loadTaskSession,
  type ApprovalArtifacts,
  type TaskSession
} from "../session/index.js";
import { writeResult } from "./context.js";
import {
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

export function registerSolveCommand(program: Command): void {
  program
    .command("solve")
    .description("Run the guided CodeCouncil workflow while preserving human control.")
    .argument("[task...]", "task description to solve")
    .option("--agents <agents>", "comma-separated agent ids to include")
    .option("--auto-approve-plan", "approve the suggested agent plan after comparison")
    .option("--approved-plan <file>", "markdown file to use as the approved plan")
    .option("--implement <agent|both>", "implementation agent id, comma-separated ids, or both")
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
            plannedStages,
            status: "dry-run",
            task
          },
          [
            "Solve dry run.",
            `Task: ${task}`,
            `Agents: ${selectedAgentIds.length > 0 ? selectedAgentIds.join(", ") : "enabled agents"}`,
            `Stages: ${plannedStages.join(" -> ")}`,
            "No session was created and no agents were executed."
          ]
        );
        return;
      }

      let session: TaskSession | undefined;
      let currentStage = "created";

      try {
        session = await createTaskSession({
          config: runtime.loadedConfig.config,
          rootDir: runtime.loadedConfig.rootDir,
          task
        });
        await saveWorkflowState(session, {
          artifacts: await collectWorkflowArtifacts(session),
          completedStages: ["created"],
          status: "created"
        });

        currentStage = "doctor";
        assertWithinDeadline(deadlineMs, currentStage);
        const doctorChecks = await runDoctorChecks({
          rootDir: runtime.loadedConfig.rootDir,
          testCommands: runtime.loadedConfig.config.testCommands,
          workspaceDir: runtime.loadedConfig.config.workspaceDir
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
          config: runtime.loadedConfig.config,
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
        await saveWorkflowState(session, {
          artifacts,
          completedStages: ["created", "planned"],
          status: "planned"
        });
        const approvalArtifacts = await maybeApprovePlan({
          options,
          planning,
          runtimeCwd: runtime.commandContext.cwd,
          session
        });

        if (approvalArtifacts) {
          currentStage = "approve";
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
          await saveWorkflowState(session, {
            artifacts,
            completedStages: ["created", "planned", "approved"],
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
          await runInternalCliCommand([
            ...buildInternalGlobalArgs(runtime.commandContext.cwd, runtime.loadedConfig.path, options.workspaceDir),
            "implement",
            "--session",
            session.id,
            "--agents",
            implementationAgents.join(",")
          ]);
          artifacts = await collectWorkflowArtifacts(session);
          await saveWorkflowState(session, {
            artifacts,
            completedStages: ["created", "planned", "approved", "implemented"],
            status: "implemented"
          });
        }

        if (options.runTests && implementationAgents.length > 0 && canProceedPastPlanning) {
          currentStage = "test";
          assertWithinDeadline(deadlineMs, currentStage);
          await runInternalCliCommand([
            ...buildInternalGlobalArgs(runtime.commandContext.cwd, runtime.loadedConfig.path, options.workspaceDir),
            "test",
            "--session",
            session.id,
            "--agents",
            implementationAgents.join(",")
          ]);
          artifacts = await collectWorkflowArtifacts(session);
          await saveWorkflowState(session, {
            artifacts,
            completedStages: ["created", "planned", "approved", "implemented", "tested"],
            status: "tested"
          });
        } else if (options.runTests) {
          skippedStages.push("tests require implementation in this solve run");
        }

        if (options.review && implementationAgents.length > 1 && canProceedPastPlanning) {
          currentStage = "review";
          assertWithinDeadline(deadlineMs, currentStage);
          await runInternalCliCommand([
            ...buildInternalGlobalArgs(runtime.commandContext.cwd, runtime.loadedConfig.path, options.workspaceDir),
            "review",
            "--session",
            session.id,
            "--reviewers",
            implementationAgents.join(","),
            "--targets",
            implementationAgents.join(",")
          ]);
          artifacts = await collectWorkflowArtifacts(session);
          await saveWorkflowState(session, {
            artifacts,
            completedStages: ["created", "planned", "approved", "implemented", "tested", "reviewed"].filter(
              (stage) => stage !== "tested" || artifacts["tests"]?.length
            ) as WorkflowStatus[],
            status: "reviewed"
          });
        } else if (options.review) {
          skippedStages.push("review requires at least two implemented agents");
        }

        if (options.report && implementationAgents.length > 0 && canProceedPastPlanning) {
          currentStage = "report";
          assertWithinDeadline(deadlineMs, currentStage);
          await runInternalCliCommand([
            ...buildInternalGlobalArgs(runtime.commandContext.cwd, runtime.loadedConfig.path, options.workspaceDir),
            "report",
            "--session",
            session.id
          ]);
          artifacts = await collectWorkflowArtifacts(session);
          await saveWorkflowState(session, {
            artifacts,
            completedStages: [
              "created",
              "planned",
              "approved",
              "implemented",
              ...(artifacts["tests"]?.length ? (["tested"] as const) : []),
              ...(artifacts["reviewSummary"]?.length ? (["reviewed"] as const) : []),
              "reported"
            ],
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
            cwd: runtime.commandContext.cwd
          })
        );
      } catch (error) {
        if (session) {
          await saveWorkflowState(session, {
            artifacts: await collectWorkflowArtifacts(session),
            completedStages: [],
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

async function runInternalCliCommand(argv: readonly string[]): Promise<void> {
  const { createCli } = await import("../cli.js");
  const originalWrite = process.stdout.write;

  process.stdout.write = (() => true) as typeof process.stdout.write;

  try {
    await createCli().parseAsync(["node", "codecouncil", ...argv]);
  } finally {
    process.stdout.write = originalWrite;
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
