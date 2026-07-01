import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";

import {
  getApprovedPlanJsonPath,
  getApprovedPlanMarkdownPath,
  hasApprovedPlan,
  listTaskSessions,
  loadTaskSession
} from "../session/index.js";
import { writeResult } from "./context.js";
import { loadRuntimeContext, relativeToCwd } from "./shared.js";

export function registerSessionsCommand(program: Command): void {
  const sessions = program.command("sessions").description("List and inspect CodeCouncil sessions.");

  sessions
    .command("list")
    .description("List saved CodeCouncil sessions.")
    .action(async (_options: Record<string, never>, command: Command) => {
      const runtime = await loadRuntimeContext(command);
      const savedSessions = await listTaskSessions({
        rootDir: runtime.loadedConfig.rootDir,
        workspaceDir: runtime.loadedConfig.config.workspaceDir
      });
      const rows = await Promise.all(
        savedSessions.map(async (session) => ({
          approved: await hasApprovedPlan(session),
          createdAt: session.createdAt,
          id: session.id,
          task: session.task
        }))
      );

      writeResult(
        runtime.commandContext,
        {
          command: "sessions.list",
          sessions: rows
        },
        rows.length === 0
          ? ["No CodeCouncil sessions found."]
          : rows.map((row) => {
              const approved = row.approved ? "approved" : "not approved";
              return `${row.id} | ${approved} | ${row.task}`;
            })
      );
    });

  sessions
    .command("show")
    .description("Show details for a saved CodeCouncil session.")
    .argument("<id>", "session id to show")
    .action(async (sessionId: string, _options: Record<string, never>, command: Command) => {
      const runtime = await loadRuntimeContext(command);
      const session = await loadTaskSession({
        rootDir: runtime.loadedConfig.rootDir,
        sessionId,
        workspaceDir: runtime.loadedConfig.config.workspaceDir
      });
      const approved = await hasApprovedPlan(session);
      const comparisonPath = path.join(session.paths.plansDir, "comparison.json");
      const comparison = await readJsonIfExists(comparisonPath);
      const approvedPlanPath = getApprovedPlanJsonPath(session);
      const approvedPlan = await readJsonIfExists(approvedPlanPath);

      writeResult(
        runtime.commandContext,
        {
          approved,
          approvedPlan,
          approvedPlanMarkdownPath: getApprovedPlanMarkdownPath(session),
          command: "sessions.show",
          comparison,
          comparisonPath,
          session
        },
        [
          `Session: ${session.id}`,
          `Task: ${session.task}`,
          `Created: ${session.createdAt}`,
          `Directory: ${relativeToCwd(runtime.commandContext, session.paths.sessionDir)}`,
          `Approved: ${approved ? "yes" : "no"}`,
          `Comparison: ${relativeToCwd(runtime.commandContext, comparisonPath)}`,
          approved
            ? `Approved plan: ${relativeToCwd(runtime.commandContext, getApprovedPlanMarkdownPath(session))}`
            : "Approved plan: none"
        ]
      );
    });
}

async function readJsonIfExists(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}
