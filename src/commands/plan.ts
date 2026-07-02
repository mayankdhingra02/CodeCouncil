import type { Command } from "commander";

import { CodeCouncilError } from "../core/errors.js";
import {
  applyModelSelectionToConfig,
  parseModelSelection,
  type ModelSelection
} from "../core/modelSelection.js";
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
  model?: string[];
  models?: string;
}

export function registerPlanCommand(program: Command): void {
  program
    .command("plan")
    .description("Ask configured agents for structured implementation plans.")
    .argument("[task...]", "task description to plan")
    .option("-a, --agent <agent>", "agent id to include; repeat for multiple agents", collectRepeatableOption)
    .option("--agents <agents>", "comma-separated agent ids to include")
    .option("-m, --model <model>", "model override for this planning run; use agent=model for one agent", collectRepeatableOption)
    .option("--models <models>", "comma-separated model overrides, for example codex=gpt-5.5,claude=sonnet")
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
      const modelSelection = parseModelSelection({
        model: options.model,
        models: options.models
      });
      const config = applyModelSelectionToConfig(
        runtime.loadedConfig.config,
        modelSelection,
        {
          stage: "plan",
          targetAgentIds: selectedAgentIds
        }
      );
      const planning = await runPlanningStage({
        agentIds: selectedAgentIds,
        config,
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
          modelSelection,
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
          modelSelection,
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
  modelSelection: ModelSelection;
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
    ...formatModelSelectionLines(input.modelSelection),
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
