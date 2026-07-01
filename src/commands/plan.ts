import type { Command } from "commander";

import { CodeCouncilError } from "../core/errors.js";
import { runPlanningStage } from "../workflow/planning.js";
import { writeResult } from "./context.js";
import {
  collectRepeatableOption,
  formatConfigSource,
  joinTaskWords,
  loadRuntimeContext,
  parseAgentsOption,
  relativeToCwd
} from "./shared.js";
import type {
  PlanComparison,
  PlanOutput,
  SavedComparisonArtifact,
  SavedPlanArtifact
} from "../agents/index.js";

interface PlanOptions {
  agent?: string[];
  agents?: string;
}

export function registerPlanCommand(program: Command): void {
  program
    .command("plan")
    .description("Ask configured agents for structured implementation plans.")
    .argument("[task...]", "task description to plan")
    .option("-a, --agent <agent>", "agent id to include; repeat for multiple agents", collectRepeatableOption)
    .option("--agents <agents>", "comma-separated agent ids to include")
    .action(async (taskWords: string[] | undefined, options: PlanOptions, command: Command) => {
      const task = joinTaskWords(taskWords);

      if (!task) {
        throw new CodeCouncilError("Missing task description for plan.", {
          code: "MISSING_TASK",
          exitCode: 2
        });
      }

      const runtime = await loadRuntimeContext(command);
      const selectedAgentIds = [...(options.agent ?? []), ...parseAgentsOption(options.agents)];
      const planning = await runPlanningStage({
        agentIds: selectedAgentIds,
        config: runtime.loadedConfig.config,
        repoRoot: runtime.loadedConfig.rootDir,
        task
      });

      writeResult(
        runtime.commandContext,
        {
          agents: planning.agents,
          artifacts: planning.artifacts,
          command: "plan",
          comparison: planning.comparison,
          comparisonArtifact: planning.comparisonArtifact,
          config: formatConfigSource(runtime.loadedConfig),
          cwd: runtime.commandContext.cwd,
          ignorePatterns: runtime.ignore.patterns.length,
          plans: planning.plans,
          sessionDir: planning.session.paths.sessionDir,
          sessionId: planning.session.id,
          status: "success",
          task
        },
        formatPlanOutputLines({
          artifacts: planning.artifacts,
          comparison: planning.comparison,
          comparisonArtifact: planning.comparisonArtifact,
          plans: planning.plans,
          sessionDir: relativeToCwd(runtime.commandContext, planning.session.paths.sessionDir),
          sessionId: planning.session.id,
          task
        })
      );
    });
}

function formatPlanOutputLines(input: {
  artifacts: readonly SavedPlanArtifact[];
  comparison: PlanComparison;
  comparisonArtifact: SavedComparisonArtifact;
  plans: readonly PlanOutput[];
  sessionDir: string;
  sessionId: string;
  task: string;
}): string[] {
  return [
    "Planning complete.",
    `Task: ${input.task}`,
    `Session: ${input.sessionId}`,
    `Session dir: ${input.sessionDir}`,
    "",
    "Plans:",
    ...input.plans.map((plan) => {
      const artifact = input.artifacts.find((candidate) => candidate.agentId === plan.agentId);
      const jsonPath = artifact?.jsonPath ? ` -> ${artifact.jsonPath}` : "";
      return `- ${plan.agentId} (${plan.displayName}): ${plan.summary}${jsonPath}`;
    }),
    "",
    `Comparison: ${input.comparisonArtifact.markdownPath}`,
    "",
    "Major agreements:",
    ...formatListItems(input.comparison.majorAgreements),
    "Major disagreements:",
    ...formatListItems(input.comparison.majorDisagreements),
    "Risks:",
    ...formatListItems(input.comparison.riskyAreas),
    "Recommended approach:",
    `- ${input.comparison.recommendedApproach}`,
    "Suggested implementation agent:",
    `- ${input.comparison.suggestedImplementationAgent ?? "No single agent suggested"}`
  ];
}

function formatListItems(items: readonly string[]): string[] {
  if (items.length === 0) {
    return ["- None"];
  }

  return items.map((item) => `- ${item}`);
}
