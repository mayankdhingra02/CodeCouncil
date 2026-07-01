import path from "node:path";
import type { Command } from "commander";

import { loadConfig, type LoadedConfig } from "../config/loadConfig.js";
import {
  loadCodecouncilIgnore,
  type LoadedCodecouncilIgnore
} from "../ignore/loadCodecouncilIgnore.js";
import { getCommandContext, type CommandContext } from "./context.js";
import type { SelectedAgentConfig } from "../core/agentSelection.js";

export interface RuntimeContext {
  commandContext: CommandContext;
  ignore: LoadedCodecouncilIgnore;
  loadedConfig: LoadedConfig;
}

export function collectRepeatableOption(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

export function joinTaskWords(taskWords: string[] | undefined): string {
  return (taskWords ?? []).join(" ").trim();
}

export function parseAgentsOption(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((agentId) => agentId.trim())
    .filter(Boolean);
}

export async function loadRuntimeContext(command: Command): Promise<RuntimeContext> {
  const commandContext = getCommandContext(command);
  const loadOptions = commandContext.configPath
    ? {
        configPath: commandContext.configPath,
        cwd: commandContext.cwd
      }
    : {
        cwd: commandContext.cwd
      };
  const loadedConfigSource = await loadConfig(loadOptions);
  const loadedConfig = commandContext.workspaceDir
    ? {
        ...loadedConfigSource,
        config: {
          ...loadedConfigSource.config,
          workspaceDir: commandContext.workspaceDir
        }
      }
    : loadedConfigSource;
  const ignore = await loadCodecouncilIgnore(
    loadedConfig.rootDir,
    ".codecouncilignore",
    loadedConfig.config.ignore
  );

  return {
    commandContext,
    ignore,
    loadedConfig
  };
}

export function formatAgents(agents: readonly SelectedAgentConfig[]): string {
  return agents.map((agent) => `${agent.id} (${agent.command})`).join(", ");
}

export function formatConfigSource(loadedConfig: LoadedConfig): string {
  return loadedConfig.path ?? "built-in defaults";
}

export function relativeToCwd(context: CommandContext, filePath: string): string {
  return path.relative(context.cwd, filePath) || ".";
}
