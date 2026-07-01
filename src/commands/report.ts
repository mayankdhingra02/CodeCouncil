import type { Command } from "commander";

import { CodeCouncilError } from "../core/errors.js";
import {
  buildFinalReportData,
  saveFinalReport,
  type AgentReportSummary,
  type FinalRecommendation
} from "../report/index.js";
import { appendSessionEvent, loadTaskSession } from "../session/index.js";
import { writeResult } from "./context.js";
import { formatConfigSource, loadRuntimeContext, relativeToCwd } from "./shared.js";

interface ReportOptions {
  session?: string;
}

export function registerReportCommand(program: Command): void {
  program
    .command("report")
    .description("Generate a final CodeCouncil recommendation report.")
    .option("--session <id>", "session id to report on")
    .action(async (options: ReportOptions, command: Command) => {
      const runtime = await loadRuntimeContext(command);

      if (!options.session) {
        throw new CodeCouncilError("Report generation requires --session.", {
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
        type: "report.started",
        status: "running",
        message: "Started final report generation."
      });

      const reportData = await buildFinalReportData(session);
      const savedReport = await saveFinalReport(reportData);

      await appendSessionEvent(session, {
        type: "report.completed",
        status: "success",
        message: "Generated final report.",
        metadata: {
          recommendationType: savedReport.recommendation.recommendationType,
          reportPath: savedReport.markdownPath,
          recommendationPath: savedReport.jsonPath
        }
      });

      writeResult(
        runtime.commandContext,
        {
          command: "report",
          config: formatConfigSource(runtime.loadedConfig),
          recommendation: savedReport.recommendation,
          recommendationPath: savedReport.jsonPath,
          reportPath: savedReport.markdownPath,
          sessionId: session.id,
          status: "success",
          worktrees: reportData.agents.map((agent) => ({
            agentId: agent.agentId,
            worktreePath: agent.worktreePath
          }))
        },
        [
          "Final report generated.",
          `Session: ${session.id}`,
          `Recommendation: ${formatRecommendation(savedReport.recommendation)}`,
          `Reason: ${savedReport.recommendation.reasons[0] ?? savedReport.recommendation.summary}`,
          `Report: ${relativeToCwd(runtime.commandContext, savedReport.markdownPath)}`,
          `Recommendation JSON: ${relativeToCwd(runtime.commandContext, savedReport.jsonPath)}`,
          "",
          ...renderWorktreeLines(reportData.agents),
          "",
          ...renderNextCommands(session.id, savedReport.recommendation, reportData.agents)
        ]
      );
    });
}

function formatRecommendation(recommendation: FinalRecommendation): string {
  if (recommendation.recommendedAgentIds.length === 0) {
    return recommendation.recommendationType;
  }

  return `${recommendation.recommendationType}: ${recommendation.recommendedAgentIds.join(", ")}`;
}

function renderWorktreeLines(agents: readonly AgentReportSummary[]): string[] {
  if (agents.length === 0) {
    return ["Worktrees: none found"];
  }

  return [
    "Worktrees:",
    ...agents.map((agent) => `- ${agent.agentId}: ${agent.worktreePath ?? "(missing)"}`)
  ];
}

function renderNextCommands(
  sessionId: string,
  recommendation: FinalRecommendation,
  agents: readonly AgentReportSummary[]
): string[] {
  const selectedAgents =
    recommendation.recommendedAgentIds.length > 0
      ? agents.filter((agent) => recommendation.recommendedAgentIds.includes(agent.agentId))
      : agents;

  if (selectedAgents.length === 0) {
    return ["Next: run implementation, tests, and review before applying anything."];
  }

  return [
    "Next manual commands:",
    ...selectedAgents.flatMap((agent) => [
      `- codecouncil apply --session ${sessionId} --agent ${agent.agentId} --dry-run`,
      `- cd ${agent.worktreePath ?? `<${agent.agentId}-worktree>`}`,
      "- git status",
      `- git diff ${agent.branchName ? `${agent.branchName}^` : "<base-branch>"} --`
    ])
  ];
}
