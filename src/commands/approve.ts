import type { Command } from "commander";

import { CodeCouncilError } from "../core/errors.js";
import {
  appendSessionEvent,
  approveAgentPlan,
  approveManualPlan,
  approveReconciledPlan,
  loadTaskSession
} from "../session/index.js";
import { writeResult } from "./context.js";
import { loadRuntimeContext, relativeToCwd } from "./shared.js";

interface ApproveOptions {
  agent?: string;
  manual?: boolean;
  reconciled?: boolean;
  session: string;
}

export function registerApproveCommand(program: Command): void {
  program
    .command("approve")
    .description("Approve an agent plan or create a manual approved plan for a session.")
    .requiredOption("--session <id>", "session id to approve")
    .option("--agent <agent>", "agent id whose plan should be approved")
    .option("--manual", "create an editable manual approved plan")
    .option("--reconciled", "approve the reconciled candidate plan")
    .action(async (options: ApproveOptions, command: Command) => {
      if ((options.agent ? 1 : 0) + (options.manual === true ? 1 : 0) + (options.reconciled === true ? 1 : 0) !== 1) {
        throw new CodeCouncilError("Choose exactly one approval mode: --agent <id>, --manual, or --reconciled.", {
          code: "INVALID_APPROVAL_MODE",
          exitCode: 2
        });
      }

      const runtime = await loadRuntimeContext(command);
      const session = await loadTaskSession({
        rootDir: runtime.loadedConfig.rootDir,
        sessionId: options.session,
        workspaceDir: runtime.loadedConfig.config.workspaceDir
      });
      const artifacts =
        options.manual === true
          ? await approveManualPlan(session)
          : options.reconciled === true
            ? await approveReconciledPlan(session)
            : await approveAgentPlan(session, options.agent ?? "");

      await appendSessionEvent(session, {
        type: "plan.approved",
        status: "success",
        message:
          options.manual === true
            ? "Created manual approved plan."
            : options.reconciled === true
              ? "Approved reconciled plan."
            : `Approved plan from ${options.agent}.`,
        metadata: {
          agentId: options.agent,
          jsonPath: artifacts.jsonPath,
          markdownPath: artifacts.markdownPath,
          manual: options.manual === true,
          reconciled: options.reconciled === true
        }
      });

      writeResult(
        runtime.commandContext,
        {
          artifacts,
          command: "approve",
          manual: options.manual === true,
          reconciled: options.reconciled === true,
          selectedAgent: options.agent,
          sessionId: session.id,
          status: "success"
        },
        [
          options.manual === true
            ? "Created manual approved plan."
            : options.reconciled === true
              ? "Approved reconciled plan."
              : "Approved agent plan.",
          `Session: ${session.id}`,
          options.agent ? `Agent: ${options.agent}` : `Mode: ${options.reconciled === true ? "reconciled" : "manual"}`,
          `JSON: ${relativeToCwd(runtime.commandContext, artifacts.jsonPath)}`,
          `Markdown: ${relativeToCwd(runtime.commandContext, artifacts.markdownPath)}`,
          options.manual === true
            ? "Edit approved-plan.md before implementation if you want to refine the plan."
            : "Implementation may now proceed for this session."
        ]
      );
    });
}
