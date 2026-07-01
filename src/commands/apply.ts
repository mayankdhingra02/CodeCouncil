import type { Command } from "commander";

import type { AgentId } from "../config/schema.js";
import { CodeCouncilError } from "../core/errors.js";
import { buildFinalReportData } from "../report/index.js";
import { appendSessionEvent, loadTaskSession } from "../session/index.js";
import { writeResult } from "./context.js";
import { formatConfigSource, loadRuntimeContext, relativeToCwd } from "./shared.js";

interface ApplyOptions {
  agent?: string;
  dryRun?: boolean;
  session?: string;
}

export function registerApplyCommand(program: Command): void {
  program
    .command("apply")
    .description("Preview applying an agent solution. Only --dry-run is implemented.")
    .requiredOption("--session <id>", "session id containing implementation artifacts")
    .requiredOption("--agent <agent>", "agent implementation to inspect")
    .option("--dry-run", "show what would be applied without changing files")
    .action(async (options: ApplyOptions, command: Command) => {
      const runtime = await loadRuntimeContext(command);

      if (options.dryRun !== true) {
        throw new CodeCouncilError("Only dry-run apply is implemented. Re-run with --dry-run.", {
          code: "APPLY_REQUIRES_DRY_RUN",
          exitCode: 2
        });
      }

      if (!options.session || !options.agent) {
        throw new CodeCouncilError("Apply requires --session and --agent.", {
          code: "MISSING_APPLY_INPUT",
          exitCode: 2
        });
      }

      const session = await loadTaskSession({
        rootDir: runtime.loadedConfig.rootDir,
        sessionId: options.session,
        workspaceDir: runtime.loadedConfig.config.workspaceDir
      });
      const reportData = await buildFinalReportData(session);
      const agent = reportData.agents.find((candidate) => candidate.agentId === options.agent);

      if (!agent) {
        throw new CodeCouncilError(`No implementation artifacts were found for agent "${options.agent}".`, {
          code: "APPLY_AGENT_NOT_FOUND",
          exitCode: 2
        });
      }

      await appendSessionEvent(session, {
        type: "apply.dry_run",
        agentId: options.agent as AgentId,
        status: "success",
        message: `Previewed applying ${options.agent}.`,
        metadata: {
          diffPath: agent.diffPath,
          worktreePath: agent.worktreePath
        }
      });

      writeResult(
        runtime.commandContext,
        {
          agentId: agent.agentId,
          branchName: agent.branchName,
          changedFiles: agent.changedFiles,
          command: "apply",
          config: formatConfigSource(runtime.loadedConfig),
          diffPath: agent.diffPath,
          dryRun: true,
          sessionId: session.id,
          status: "dry-run",
          worktreePath: agent.worktreePath
        },
        [
          "Apply dry-run only. No files were changed.",
          `Session: ${session.id}`,
          `Agent: ${agent.agentId}`,
          `Worktree: ${agent.worktreePath ?? "(missing)"}`,
          `Branch: ${agent.branchName ?? "(unknown)"}`,
          `Diff: ${agent.diffPath ? relativeToCwd(runtime.commandContext, agent.diffPath) : "(missing)"}`,
          `Changed files: ${agent.changedFiles.length > 0 ? agent.changedFiles.join(", ") : "none"}`,
          "",
          "Manual inspection commands:",
          `cd ${agent.worktreePath ?? `<${agent.agentId}-worktree>`}`,
          "git status",
          `git diff ${session.baseBranch} --`,
          "",
          "Manual apply options after inspection:",
          agent.branchName
            ? `git merge --no-ff ${agent.branchName}`
            : "git merge --no-ff <agent-branch>",
          agent.diffPath
            ? `git apply --check ${agent.diffPath}`
            : "git apply --check <patch-file>",
          agent.diffPath ? `git apply ${agent.diffPath}` : "git apply <patch-file>",
          "",
          "CodeCouncil did not merge, cherry-pick, push, or delete anything."
        ]
      );
    });
}
