import path from "node:path";
import type { Command } from "commander";

import { resolveSelectedAgents } from "../core/agentSelection.js";
import { CodeCouncilError } from "../core/errors.js";
import { GitManager, type GitWorktreeInfo } from "../git/index.js";
import type { AgentId, CodeCouncilConfig } from "../config/schema.js";
import {
  appendSessionEvent,
  createTaskSession,
  loadTaskSession,
  previewTaskSession,
  type TaskSession
} from "../session/index.js";
import { writeResult } from "./context.js";
import { formatConfigSource, loadRuntimeContext, relativeToCwd } from "./shared.js";

interface WorktreeCreateOptions {
  agent: string;
  base?: string;
  dryRun?: boolean;
  session?: string;
  task?: string;
}

interface WorktreeCleanupOptions {
  agent?: string;
  deleteBranch?: boolean;
  dryRun?: boolean;
  force?: boolean;
  session: string;
}

export function registerWorktreeCommand(program: Command): void {
  const worktree = program.command("worktree").description("Manage CodeCouncil git worktrees.");

  worktree
    .command("create")
    .description("Create an isolated git worktree and branch for an agent.")
    .requiredOption("-a, --agent <agent>", "agent id to create a worktree for")
    .option("-t, --task <task>", "task description for a new session")
    .option("--session <id>", "existing session id to add the worktree to")
    .option("--base <branch>", "base branch to create the agent branch from")
    .option("--dry-run", "show the worktree operation without creating it")
    .action(async (options: WorktreeCreateOptions, command: Command) => {
      const runtime = await loadRuntimeContext(command);
      const agents = resolveSelectedAgents(runtime.loadedConfig.config, [options.agent]);
      const agent = agents[0];

      if (!agent) {
        throw new CodeCouncilError("No agent selected for worktree creation.", {
          code: "NO_AGENT_SELECTED",
          exitCode: 2
        });
      }

      const git = new GitManager(runtime.loadedConfig.rootDir);
      const repoStatus = await git.getRepositoryStatus();

      if (!repoStatus.insideWorkTree) {
        throw new CodeCouncilError("CodeCouncil worktrees require a git repository.", {
          code: "NOT_A_GIT_REPOSITORY",
          exitCode: 2
        });
      }

      if (repoStatus.clean === false) {
        runtime.commandContext.stderr.write(
          `codecouncil: warning: repository has uncommitted changes; agent worktree will still be isolated.\n`
        );
      }

      const session = await getOrCreateSessionForWorktreeCreate(
        options,
        runtime.loadedConfig.config,
        runtime.loadedConfig.rootDir
      );
      const worktreeResult = await git.createWorktree({
        agentId: agent.id,
        dryRun: options.dryRun === true,
        session,
        ...(options.base ? { baseBranch: options.base } : {})
      });

      if (options.dryRun !== true) {
        if (repoStatus.clean === false) {
          await appendSessionEvent(session, {
            type: "git.warning.dirty",
            status: "skipped",
            message: "Repository had uncommitted changes before worktree creation.",
            metadata: {
              changedFiles: repoStatus.changedFiles
            }
          });
        }

        await appendSessionEvent(session, {
          type: "worktree.created",
          agentId: agent.id,
          status: "success",
          message: "Created agent git worktree.",
          metadata: {
            baseBranch: worktreeResult.baseBranch,
            branchName: worktreeResult.branchName,
            worktreePath: worktreeResult.worktreePath
          }
        });
      }

      writeResult(
        runtime.commandContext,
        {
          agent: agent.id,
          baseBranch: worktreeResult.baseBranch,
          branchName: worktreeResult.branchName,
          command: "worktree.create",
          config: formatConfigSource(runtime.loadedConfig),
          dirty: repoStatus.clean === false,
          dryRun: worktreeResult.dryRun,
          sessionId: session.id,
          worktreePath: worktreeResult.worktreePath
        },
        [
          options.dryRun === true ? "Worktree create dry run." : "Created CodeCouncil worktree.",
          `Agent: ${agent.id}`,
          `Session: ${session.id}`,
          `Base branch: ${worktreeResult.baseBranch}`,
          `Agent branch: ${worktreeResult.branchName}`,
          `Worktree: ${relativeToCwd(runtime.commandContext, worktreeResult.worktreePath)}`,
          repoStatus.clean === false ? "Warning: repository has uncommitted changes." : "Repository: clean"
        ]
      );
    });

  worktree
    .command("list")
    .description("List git worktrees known to the repository.")
    .action(async (_options: Record<string, never>, command: Command) => {
      const runtime = await loadRuntimeContext(command);
      const git = new GitManager(runtime.loadedConfig.rootDir);
      const repoStatus = await git.getRepositoryStatus();

      if (!repoStatus.insideWorkTree) {
        throw new CodeCouncilError("CodeCouncil worktrees require a git repository.", {
          code: "NOT_A_GIT_REPOSITORY",
          exitCode: 2
        });
      }

      const worktrees = await git.listWorktrees();

      writeResult(
        runtime.commandContext,
        {
          command: "worktree.list",
          worktrees
        },
        formatWorktreeList(worktrees)
      );
    });

  worktree
    .command("cleanup")
    .description("Remove CodeCouncil worktrees from an existing session.")
    .requiredOption("--session <id>", "session id to clean up")
    .option("-a, --agent <agent>", "agent id to clean up; omit to clean all session worktrees")
    .option("--delete-branch", "delete the CodeCouncil branch after removing the worktree")
    .option("--dry-run", "show cleanup actions without removing worktrees")
    .option("--force", "force removal of dirty agent worktrees")
    .action(async (options: WorktreeCleanupOptions, command: Command) => {
      const runtime = await loadRuntimeContext(command);
      const git = new GitManager(runtime.loadedConfig.rootDir);
      const session = await loadTaskSession({
        rootDir: runtime.loadedConfig.rootDir,
        sessionId: options.session,
        workspaceDir: runtime.loadedConfig.config.workspaceDir
      });
      const agentIds = options.agent
        ? [resolveSelectedAgents(runtime.loadedConfig.config, [options.agent])[0]?.id].filter(
            (agentId): agentId is AgentId => Boolean(agentId)
          )
        : await findSessionWorktreeAgentIds(git, session);

      const results = [];

      for (const agentId of agentIds) {
        const result = await git.removeWorktree({
          agentId,
          deleteBranch: options.deleteBranch === true,
          dryRun: options.dryRun === true,
          force: options.force === true,
          session
        });
        results.push(result);

        if (options.dryRun !== true) {
          await appendSessionEvent(session, {
            type: "worktree.removed",
            agentId,
            status: "success",
            message: "Removed agent git worktree.",
            metadata: {
              branchName: result.branchName,
              deleteBranch: options.deleteBranch === true,
              worktreePath: result.worktreePath
            }
          });
        }
      }

      writeResult(
        runtime.commandContext,
        {
          command: "worktree.cleanup",
          dryRun: options.dryRun === true,
          results,
          sessionId: session.id
        },
        [
          options.dryRun === true ? "Worktree cleanup dry run." : "Cleaned CodeCouncil worktrees.",
          `Session: ${session.id}`,
          `Worktrees: ${results.length}`,
          ...results.map(
            (result) =>
              `${result.agentId}: ${relativeToCwd(runtime.commandContext, result.worktreePath)}`
          )
        ]
      );
    });
}

async function getOrCreateSessionForWorktreeCreate(
  options: WorktreeCreateOptions,
  config: CodeCouncilConfig,
  rootDir: string
): Promise<TaskSession> {
  if (options.session) {
    return loadTaskSession({
      rootDir,
      sessionId: options.session,
      workspaceDir: config.workspaceDir
    });
  }

  const task = options.task?.trim();

  if (!task) {
    throw new CodeCouncilError("Provide --task when creating a new worktree session.", {
      code: "MISSING_TASK",
      exitCode: 2
    });
  }

  if (options.dryRun === true) {
    return previewTaskSession({
      config,
      rootDir,
      task
    });
  }

  return createTaskSession({
    config,
    rootDir,
    task
  });
}

async function findSessionWorktreeAgentIds(
  git: GitManager,
  session: TaskSession
): Promise<AgentId[]> {
  const worktrees = await git.listWorktrees();
  const sessionWorktreesDir = path.resolve(session.paths.worktreesDir);

  return worktrees
    .map((worktree) => path.resolve(worktree.path))
    .filter((worktreePath) => {
      const relativePath = path.relative(sessionWorktreesDir, worktreePath);
      return relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
    })
    .map((worktreePath) => path.basename(worktreePath));
}

function formatWorktreeList(worktrees: readonly GitWorktreeInfo[]): string[] {
  if (worktrees.length === 0) {
    return ["No git worktrees found."];
  }

  return worktrees.map((worktree) => {
    const branch = worktree.branch ?? (worktree.detached === true ? "(detached)" : "(unknown)");
    return `${worktree.path} ${branch}`;
  });
}
