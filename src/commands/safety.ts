import type { Command } from "commander";

import { CodeCouncilError } from "../core/errors.js";
import { saveSafetySummary } from "../safety/index.js";
import { appendSessionEvent, loadTaskSession } from "../session/index.js";
import { writeResult } from "./context.js";
import { formatConfigSource, loadRuntimeContext, relativeToCwd } from "./shared.js";

interface SafetyOptions {
  session?: string;
}

export function registerSafetyCommand(program: Command): void {
  program
    .command("safety")
    .description("Generate a defense-in-depth safety summary for a session.")
    .option("--session <id>", "session id to inspect")
    .action(async (options: SafetyOptions, command: Command) => {
      const runtime = await loadRuntimeContext(command);

      if (!options.session) {
        throw new CodeCouncilError("Safety summary requires --session.", {
          code: "MISSING_SESSION",
          exitCode: 2
        });
      }

      const session = await loadTaskSession({
        rootDir: runtime.loadedConfig.rootDir,
        sessionId: options.session,
        workspaceDir: runtime.loadedConfig.config.workspaceDir
      });

      await appendSessionEvent(session, {
        type: "safety.started",
        status: "running",
        message: "Started safety summary generation."
      });

      const result = await saveSafetySummary({
        ignoreMatcher: runtime.ignore,
        secretPatterns: runtime.loadedConfig.config.safety.secretPatterns,
        session
      });

      await appendSessionEvent(session, {
        type: "safety.completed",
        status: "success",
        message: "Generated safety summary.",
        metadata: {
          jsonPath: result.jsonPath,
          markdownPath: result.markdownPath,
          riskyCommands: result.summary.riskyCommands.length,
          sensitiveFilesTouched: result.summary.sensitiveFilesTouched.length
        }
      });

      writeResult(
        runtime.commandContext,
        {
          command: "safety",
          config: formatConfigSource(runtime.loadedConfig),
          jsonPath: result.jsonPath,
          markdownPath: result.markdownPath,
          sessionId: session.id,
          status: "success",
          summary: result.summary
        },
        [
          "Safety summary generated.",
          `Session: ${session.id}`,
          `Sensitive files touched: ${result.summary.sensitiveFilesTouched.length}`,
          `Ignored files touched: ${result.summary.ignoredFiles.length}`,
          `Risky commands observed: ${result.summary.riskyCommands.length}`,
          `Warnings: ${result.summary.warnings.length}`,
          `Markdown: ${relativeToCwd(runtime.commandContext, result.markdownPath)}`,
          `JSON: ${relativeToCwd(runtime.commandContext, result.jsonPath)}`,
          "",
          "Recommended manual checks:",
          ...result.summary.recommendedManualChecks.map((check) => `- ${check}`)
        ]
      );
    });
}
