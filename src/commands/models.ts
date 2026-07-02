import type { Command } from "commander";

import type { CodeCouncilConfig } from "../config/schema.js";
import { MODEL_CATALOGS, type ProviderModelCatalog } from "../core/modelSelection.js";
import { writeResult } from "./context.js";
import { loadRuntimeContext } from "./shared.js";

interface ModelCatalogView extends ProviderModelCatalog {
  adapterId: string;
}

export function registerModelsCommand(program: Command): void {
  const models = program
    .command("models")
    .description("Show model selection guidance for supported agent CLIs.");

  models
    .command("list")
    .description("List recommended model choices and override examples.")
    .action(async (_options: unknown, command: Command) => {
      const runtime = await loadRuntimeContext(command);
      const catalogs = resolveModelCatalogViews(runtime.loadedConfig.config);
      const examples = buildModelExamples(catalogs);

      writeResult(
        runtime.commandContext,
        {
          catalogs,
          command: "models list",
          status: "success"
        },
        [
          "Model selection guidance.",
          "",
          ...catalogs.flatMap((catalog) => [
            `${catalog.provider} (${formatCatalogAgentLabel(catalog)})`,
            `Docs: ${catalog.docsUrl}`,
            `CLI flag: ${catalog.cliFlag}`,
            ...catalog.entries.map(
              (entry) =>
                `- ${entry.id}: ${entry.label}. ${entry.recommendedFor}. ${entry.notes}`
            ),
            ""
          ]),
          "Examples:",
          ...examples.map((example) => `- ${example}`),
          "",
          "CodeCouncil passes the selected model to the official CLI. The CLI/provider decides whether your account can use it."
        ]
      );
    });
}

function resolveModelCatalogViews(config: CodeCouncilConfig): ModelCatalogView[] {
  const configuredCatalogs = Object.entries(config.agents)
    .filter(([, agent]) => agent.enabled)
    .flatMap(([agentId, agent]) => {
      const adapterId = agent.adapter ?? agentId;
      const catalog = MODEL_CATALOGS.find((candidate) => candidate.agentId === adapterId);

      return catalog
        ? [
            {
              ...catalog,
              adapterId,
              agentId
            }
          ]
        : [];
    });

  if (configuredCatalogs.length > 0) {
    return configuredCatalogs;
  }

  return MODEL_CATALOGS.map((catalog) => ({
    ...catalog,
    adapterId: catalog.agentId
  }));
}

function formatCatalogAgentLabel(catalog: ModelCatalogView): string {
  return catalog.agentId === catalog.adapterId
    ? catalog.agentId
    : `${catalog.agentId} via ${catalog.adapterId}`;
}

function buildModelExamples(catalogs: readonly ModelCatalogView[]): string[] {
  const codex = catalogs.find((catalog) => catalog.adapterId === "codex");
  const claude = catalogs.find((catalog) => catalog.adapterId === "claude");

  if (codex && claude) {
    return [
      `codecouncil plan "task" --agents ${codex.agentId},${claude.agentId} --models ${codex.agentId}=gpt-5.4-mini,${claude.agentId}=sonnet`,
      `codecouncil implement --session <id> --agent ${claude.agentId} --model ${claude.agentId}=opus`,
      `codecouncil review --session <id> --reviewers ${codex.agentId},${claude.agentId} --targets ${codex.agentId},${claude.agentId} --models ${codex.agentId}=gpt-5.5,${claude.agentId}=fable`
    ];
  }

  if (codex) {
    return [
      `codecouncil plan "task" --agents ${codex.agentId} --model gpt-5.4-mini`,
      `codecouncil review --session <id> --reviewers ${codex.agentId} --targets <target-agent> --model gpt-5.5`
    ];
  }

  if (claude) {
    return [
      `codecouncil plan "task" --agents ${claude.agentId} --model sonnet`,
      `codecouncil implement --session <id> --agent ${claude.agentId} --model opus`
    ];
  }

  return ["Configure a Codex or Claude adapter to see provider-specific examples."];
}
