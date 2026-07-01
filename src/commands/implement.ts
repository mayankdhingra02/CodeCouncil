import path from "node:path";
import type { Command } from "commander";

import { AgentRegistry, type CodeCouncilAgent, type ImplementationOutput } from "../agents/index.js";
import type { AgentId, CodeCouncilConfig } from "../config/schema.js";
import { CodeCouncilError } from "../core/errors.js";
import { GitManager } from "../git/index.js";
import { saveImplementationArtifacts } from "../implementation/index.js";
import { classifyChangedFiles, type FileChangeSafetyResult } from "../safety/index.js";
import {
  appendSessionEvent,
  hasApprovedPlan,
  loadApprovedPlanMarkdown,
  loadTaskSession
} from "../session/index.js";
import type { TaskSession } from "../session/index.js";
import { writeResult } from "./context.js";
import {
  collectRepeatableOption,
  formatConfigSource,
  joinTaskWords,
  loadRuntimeContext,
  relativeToCwd
} from "./shared.js";

interface ImplementOptions {
  agent?: string[];
  agents?: string;
  fromPlan?: string;
  noApprovalRequired?: boolean;
  session?: string;
}

interface AgentImplementationSummary {
  agentId: AgentId;
  changedFiles: string[];
  diffPath: string;
  implementationJsonPath: string;
  safety: FileChangeSafetyResult;
  status: "success" | "failed" | "blocked";
  worktreePath: string;
}

export function registerImplementCommand(program: Command): void {
  program
    .command("implement")
    .description("Run one or more agents in isolated worktrees.")
    .argument("[task...]", "task description to implement")
    .option("-a, --agent <agent>", "agent id to include; repeat for multiple agents", collectRepeatableOption)
    .option("--agents <agents>", "comma-separated agent ids to include")
    .option("--from-plan <path>", "path to a saved plan file from a previous run")
    .option("--session <id>", "session id containing an approved plan")
    .option("--no-approval-required", "explicitly bypass the approved-plan requirement")
    .action(
      async (taskWords: string[] | undefined, options: ImplementOptions, command: Command) => {
        const taskOverride = joinTaskWords(taskWords);

        if (!taskOverride && !options.fromPlan && !options.session) {
          throw new CodeCouncilError("Provide a task description, --from-plan, or --session.", {
            code: "MISSING_IMPLEMENT_INPUT",
            exitCode: 2
          });
        }

        const runtime = await loadRuntimeContext(command);

        if (!options.session) {
          throw new CodeCouncilError("Implementation requires --session for isolated worktree execution.", {
            code: "MISSING_SESSION",
            exitCode: 2
          });
        }

        const session = await loadTaskSession({
          rootDir: runtime.loadedConfig.rootDir,
          sessionId: options.session,
          workspaceDir: runtime.loadedConfig.config.workspaceDir
        });
        const approvalBypassed = options.noApprovalRequired === true;

        if (!approvalBypassed && !(await hasApprovedPlan(session))) {
          throw new CodeCouncilError(
            `Session "${options.session}" has no approved-plan.json. Run codecouncil approve first.`,
            {
              code: "IMPLEMENTATION_APPROVAL_REQUIRED",
              exitCode: 2
            }
          );
        }

        const registry = AgentRegistry.fromConfig(runtime.loadedConfig.config);
        const selectedAgents = registry.select([
          ...(options.agent ?? []),
          ...parseAgentsOption(options.agents)
        ]);
        const git = new GitManager(runtime.loadedConfig.rootDir);
        const repoStatus = await git.getRepositoryStatus();

        if (!repoStatus.insideWorkTree) {
          throw new CodeCouncilError("Implementation requires a git repository.", {
            code: "NOT_A_GIT_REPOSITORY",
            exitCode: 2
          });
        }

        const approvedPlanMarkdown = approvalBypassed
          ? undefined
          : await loadApprovedPlanMarkdown(session);
        const task = taskOverride || session.task;
        const summaries: AgentImplementationSummary[] = [];

        await appendSessionEvent(session, {
          type: "implementation.started",
          status: "running",
          message: "Started implementation phase.",
          metadata: {
            agents: selectedAgents.map((agent) => agent.id),
            approvalBypassed
          }
        });

        for (const agent of selectedAgents) {
          const summary = await implementWithAgent({
            agent,
            baseBranch: runtime.loadedConfig.config.baseBranch,
            config: runtime.loadedConfig.config,
            createCommit: runtime.loadedConfig.config.safety.createCommitOnImplementation,
            git,
            ignoreMatcher: runtime.ignore,
            repoRoot: runtime.loadedConfig.rootDir,
            session,
            task,
            ...(approvedPlanMarkdown ? { approvedPlanMarkdown } : {})
          });
          summaries.push(summary);

          if (summary.safety.warnings.length > 0) {
            for (const warning of summary.safety.warnings) {
              runtime.commandContext.stderr.write(`codecouncil: warning: ${warning}\n`);
            }
          }

          if (summary.status === "blocked") {
            throw new CodeCouncilError(
              `Implementation by ${summary.agentId} changed blocked files: ${summary.safety.blockedFiles.join(", ")}`,
              {
                code: "BLOCKED_FILE_CHANGE",
                exitCode: 2
              }
            );
          }
        }

        await appendSessionEvent(session, {
          type: "implementation.completed",
          status: "success",
          message: "Completed implementation phase.",
          metadata: {
            agents: summaries.map((summary) => summary.agentId)
          }
        });

        writeResult(
          runtime.commandContext,
          {
            approvalBypassed,
            command: "implement",
            config: formatConfigSource(runtime.loadedConfig),
            fromPlan: options.fromPlan,
            sessionId: session.id,
            status: "success",
            summaries,
            task
          },
          [
            "Implementation phase complete.",
            `Task: ${task}`,
            `Session: ${session.id}`,
            `Approval: ${approvalBypassed ? "bypassed by flag" : "approved"}`,
            "",
            ...summaries.flatMap((summary) => [
              `${summary.agentId}: ${summary.status}`,
              `  Worktree: ${relativeToCwd(runtime.commandContext, summary.worktreePath)}`,
              `  Changed files: ${summary.changedFiles.length > 0 ? summary.changedFiles.join(", ") : "none"}`,
              `  Diff: ${relativeToCwd(runtime.commandContext, summary.diffPath)}`,
              `  Metadata: ${relativeToCwd(runtime.commandContext, summary.implementationJsonPath)}`
            ]),
            "",
            runtime.loadedConfig.config.testCommands.length > 0
              ? `Next: codecouncil test --worktree <path> --command "${runtime.loadedConfig.config.testCommands[0]}"`
              : "Next: run tests in the selected worktree, then request review."
          ]
        );
      }
    );
}

async function implementWithAgent(input: {
  agent: CodeCouncilAgent;
  approvedPlanMarkdown?: string;
  baseBranch: string;
  config: CodeCouncilConfig;
  createCommit: boolean;
  git: GitManager;
  ignoreMatcher: {
    ignores(filePath: string): boolean;
  };
  repoRoot: string;
  session: TaskSession;
  task: string;
}): Promise<AgentImplementationSummary> {
  const { agent, git, session } = input;

  await appendSessionEvent(session, {
    type: "agent.implementation.started",
    agentId: agent.id,
    status: "running",
    message: `Started implementation with ${agent.displayName}.`
  });

  const availability = await agent.checkAvailability();

  if (!availability.available) {
    throw new CodeCouncilError(
      `Agent "${agent.id}" is not available: ${availability.reason ?? "unknown reason"}`,
      {
        code: "AGENT_NOT_AVAILABLE",
        exitCode: 2
      }
    );
  }

  const worktree = await git.ensureWorktree({
    agentId: agent.id,
    baseBranch: input.baseBranch,
    session
  });

  if (path.resolve(worktree.worktreePath) === path.resolve(input.repoRoot)) {
    throw new CodeCouncilError("Refusing to run implementation in the original working tree.", {
      code: "IMPLEMENTATION_REQUIRES_WORKTREE",
      exitCode: 2
    });
  }

  let output: ImplementationOutput;
  let status: AgentImplementationSummary["status"] = "success";

  try {
    output = await agent.implementTask({
      ...(input.approvedPlanMarkdown ? { approvedPlanMarkdown: input.approvedPlanMarkdown } : {}),
      config: input.config,
      repoRoot: input.repoRoot,
      session,
      task: input.task,
      worktreePath: worktree.worktreePath
    });
  } catch (error) {
    status = "failed";
    output = {
      agentId: agent.id,
      completedAt: new Date().toISOString(),
      createdFiles: [],
      displayName: agent.displayName,
      error: error instanceof Error ? error.message : "Implementation failed.",
      filesChanged: [],
      metadata: {},
      status: "failed",
      summary: error instanceof Error ? error.message : "Implementation failed."
    };
  }

  const changedFiles = await git.getChangedFiles(worktree.worktreePath, input.baseBranch);
  const diffPath = path.join(session.paths.diffsDir, `${agent.id}.patch`);
  await git.createPatchFile({
    baseBranch: input.baseBranch,
    outputPath: diffPath,
    worktreePath: worktree.worktreePath
  });
  const safety = classifyChangedFiles(changedFiles, {
    ignoreMatcher: input.ignoreMatcher,
    secretPatterns: input.config.safety.secretPatterns
  });

  if (safety.blockedFiles.length > 0) {
    status = "blocked";
  }

  const commitResult =
    input.createCommit && status === "success" && changedFiles.length > 0
      ? await git.commitAgentChanges({
          message: `CodeCouncil implementation: ${input.task} (${agent.id})`,
          worktreePath: worktree.worktreePath
        })
      : undefined;

  const artifacts = await saveImplementationArtifacts({
    agentId: agent.id,
    changedFiles,
    ...(commitResult?.commitSha ? { commitSha: commitResult.commitSha } : {}),
    diffPath,
    output,
    safety,
    session,
    status,
    worktree
  });

  await appendSessionEvent(session, {
    type:
      status === "success"
        ? "agent.implementation.completed"
        : status === "blocked"
          ? "agent.implementation.blocked"
          : "agent.implementation.failed",
    agentId: agent.id,
    status: status === "success" ? "success" : "failed",
    message:
      status === "success"
        ? `Completed implementation with ${agent.displayName}.`
        : status === "blocked"
          ? `Implementation by ${agent.displayName} changed blocked files.`
          : `Implementation by ${agent.displayName} failed.`,
    metadata: {
      blockedFiles: safety.blockedFiles,
      changedFiles,
      diffPath,
      implementationJsonPath: artifacts.implementationJsonPath,
      worktreePath: worktree.worktreePath
    }
  });

  return {
    agentId: agent.id,
    changedFiles,
    diffPath,
    implementationJsonPath: artifacts.implementationJsonPath,
    safety,
    status,
    worktreePath: worktree.worktreePath
  };
}

function parseAgentsOption(value: string | undefined): AgentId[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((agentId) => agentId.trim())
    .filter(Boolean);
}
