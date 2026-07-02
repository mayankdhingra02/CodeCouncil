import type { Command } from "commander";

import { MODEL_CATALOGS } from "../core/modelSelection.js";
import { writeResult } from "./context.js";
import { loadRuntimeContext } from "./shared.js";

export function registerModelsCommand(program: Command): void {
  const models = program
    .command("models")
    .description("Show model selection guidance for supported agent CLIs.");

  models
    .command("list")
    .description("List recommended model choices and override examples.")
    .action(async (_options: unknown, command: Command) => {
      const runtime = await loadRuntimeContext(command);

      writeResult(
        runtime.commandContext,
        {
          catalogs: MODEL_CATALOGS,
          command: "models list",
          status: "success"
        },
        [
          "Model selection guidance.",
          "",
          ...MODEL_CATALOGS.flatMap((catalog) => [
            `${catalog.provider} (${catalog.agentId})`,
            `Docs: ${catalog.docsUrl}`,
            `CLI flag: ${catalog.cliFlag}`,
            ...catalog.entries.map(
              (entry) =>
                `- ${entry.id}: ${entry.label}. ${entry.recommendedFor}. ${entry.notes}`
            ),
            ""
          ]),
          "Examples:",
          "- codecouncil plan \"task\" --agents codex,claude --models codex=gpt-5.4-mini,claude=sonnet",
          "- codecouncil implement --session <id> --agent claude --model claude=opus",
          "- codecouncil review --session <id> --reviewers codex,claude --targets codex,claude --models codex=gpt-5.5,claude=fable",
          "",
          "CodeCouncil passes the selected model to the official CLI. The CLI/provider decides whether your account can use it."
        ]
      );
    });
}
