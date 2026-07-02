import type { AgentConfig, AgentId, CodeCouncilConfig } from "../config/schema.js";
import { CodeCouncilError } from "./errors.js";

export type AgentStage = "plan" | "implement" | "review";

export interface ModelCatalogEntry {
  id: string;
  label: string;
  notes: string;
  recommendedFor: string;
}

export interface ProviderModelCatalog {
  agentId: AgentId;
  cliFlag: string;
  docsUrl: string;
  entries: ModelCatalogEntry[];
  provider: string;
}

export interface ModelSelection {
  defaultModel?: string;
  byAgent: Record<AgentId, string>;
}

export const MODEL_CATALOGS: ProviderModelCatalog[] = [
  {
    agentId: "codex",
    cliFlag: "--model",
    docsUrl: "https://developers.openai.com/codex/models",
    provider: "OpenAI Codex",
    entries: [
      {
        id: "gpt-5.5",
        label: "Best/strongest Codex model",
        notes: "Use when the task is complex, ambiguous, or important enough to justify higher token spend.",
        recommendedFor: "complex coding, research, computer use, difficult reviews"
      },
      {
        id: "gpt-5.4-mini",
        label: "Faster/lower-cost Codex option",
        notes: "Good default for lightweight planning, routine reviews, and cheaper exploratory runs.",
        recommendedFor: "small tasks, first-pass planning, subagents"
      },
      {
        id: "gpt-5.3-codex-spark",
        label: "Near-instant coding iteration preview",
        notes: "Availability can depend on account access; let the Codex CLI validate it.",
        recommendedFor: "quick iteration where latency matters"
      }
    ]
  },
  {
    agentId: "claude",
    cliFlag: "--model",
    docsUrl: "https://docs.anthropic.com/en/docs/about-claude/models/overview",
    provider: "Anthropic Claude Code",
    entries: [
      {
        id: "fable",
        label: "Highest available Claude capability alias",
        notes: "Use only when the task really needs top capability because it is typically the expensive/slow path.",
        recommendedFor: "hard planning, deep cross-review, long-running agentic tasks"
      },
      {
        id: "opus",
        label: "Complex agentic coding alias",
        notes: "Strong choice for implementation or architectural review when cost matters but quality is central.",
        recommendedFor: "complex coding, enterprise-style review, implementation"
      },
      {
        id: "sonnet",
        label: "Balanced speed/intelligence alias",
        notes: "Good default for most CodeCouncil planning and review runs.",
        recommendedFor: "routine planning, implementation, cross-review"
      },
      {
        id: "haiku",
        label: "Fastest Claude alias",
        notes: "Use for cheap first-pass checks, summaries, or low-risk tasks.",
        recommendedFor: "quick planning, lightweight reviews"
      }
    ]
  }
];

export function parseModelSelection(input: {
  model?: readonly string[] | undefined;
  models?: string | undefined;
}): ModelSelection {
  const selection: ModelSelection = {
    byAgent: {}
  };
  const rawValues = [
    ...(input.model ?? []),
    ...splitCsv(input.models)
  ];

  for (const rawValue of rawValues) {
    const value = rawValue.trim();

    if (!value) {
      continue;
    }

    const assignment = splitModelAssignment(value);

    if (assignment) {
      selection.byAgent[assignment.agentId] = assignment.model;
    } else {
      selection.defaultModel = value;
    }
  }

  return selection;
}

export function applyModelSelectionToConfig(
  config: CodeCouncilConfig,
  selection: ModelSelection,
  options: {
    stage?: AgentStage;
    targetAgentIds?: readonly string[];
  } = {}
): CodeCouncilConfig {
  if (!selection.defaultModel && Object.keys(selection.byAgent).length === 0) {
    return config;
  }

  const targetAgentIds = resolveTargetAgentIds(config, options.targetAgentIds);
  validateModelSelection(config, selection, targetAgentIds);

  const nextConfig: CodeCouncilConfig = {
    ...config,
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([agentId, agentConfig]) => {
        if (!targetAgentIds.includes(agentId)) {
          return [agentId, agentConfig];
        }

        const selectedModel = selection.byAgent[agentId] ?? selection.defaultModel;

        if (!selectedModel) {
          return [agentId, agentConfig];
        }

        return [
          agentId,
          applyModelToAgentConfig(agentConfig, selectedModel, options.stage)
        ];
      })
    )
  };

  return nextConfig;
}

function validateModelSelection(
  config: CodeCouncilConfig,
  selection: ModelSelection,
  targetAgentIds: readonly string[]
): void {
  for (const agentId of Object.keys(selection.byAgent)) {
    const configuredAgent = config.agents[agentId];

    if (!configuredAgent) {
      throw new CodeCouncilError(`Unknown model override agent "${agentId}". Check your config or --models option.`, {
        code: "UNKNOWN_MODEL_AGENT",
        exitCode: 2
      });
    }

    if (!configuredAgent.enabled) {
      throw new CodeCouncilError(`Model override agent "${agentId}" is disabled in the active config.`, {
        code: "DISABLED_MODEL_AGENT",
        exitCode: 2
      });
    }

    if (!targetAgentIds.includes(agentId)) {
      throw new CodeCouncilError(
        `Model override for "${agentId}" does not match the selected agent set: ${targetAgentIds.join(", ")}.`,
        {
          code: "MODEL_AGENT_NOT_SELECTED",
          exitCode: 2
        }
      );
    }
  }

  if (selection.defaultModel && targetAgentIds.length !== 1) {
    throw new CodeCouncilError(
      "Bare --model/--models values are only allowed when exactly one agent is selected. Use agent=model form for multi-agent runs.",
      {
        code: "MODEL_SELECTION_REQUIRES_AGENT",
        exitCode: 2
      }
    );
  }
}

function resolveTargetAgentIds(
  config: CodeCouncilConfig,
  requestedAgentIds: readonly string[] | undefined
): string[] {
  const enabledAgentIds = Object.entries(config.agents)
    .filter(([, agent]) => agent.enabled)
    .map(([agentId]) => agentId);
  const targetAgentIds = requestedAgentIds && requestedAgentIds.length > 0
    ? [...new Set(requestedAgentIds)]
    : enabledAgentIds;

  for (const agentId of targetAgentIds) {
    if (!config.agents[agentId]) {
      throw new CodeCouncilError(`Unknown agent "${agentId}". Check your config or --agent option.`, {
        code: "UNKNOWN_AGENT",
        exitCode: 2
      });
    }
  }

  return targetAgentIds;
}

export function formatModelSelectionArgs(selection: ModelSelection): string[] {
  const args = Object.entries(selection.byAgent).map(([agentId, model]) => `${agentId}=${model}`);

  if (selection.defaultModel) {
    args.unshift(selection.defaultModel);
  }

  return args.length > 0 ? ["--models", args.join(",")] : [];
}

export function getAgentStageModel(config: AgentConfig, stage: AgentStage): string | undefined {
  return config.models[stage] ?? config.model;
}

export function injectModelArg(args: readonly string[], model: string | undefined): string[] {
  if (!model || hasModelArg(args)) {
    return [...args];
  }

  return [...args, "--model", model];
}

function applyModelToAgentConfig(
  config: AgentConfig,
  model: string,
  stage: AgentStage | undefined
): AgentConfig {
  if (!stage) {
    return {
      ...config,
      model
    };
  }

  return {
    ...config,
    models: {
      ...config.models,
      [stage]: model
    }
  };
}

function splitCsv(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function splitModelAssignment(value: string): { agentId: AgentId; model: string } | undefined {
  const match = /^(?<agentId>[a-z0-9][a-z0-9._-]*)\s*[=:]\s*(?<model>.+)$/iu.exec(value);

  if (!match?.groups) {
    return undefined;
  }

  const agentId = match.groups["agentId"]?.trim();
  const model = match.groups["model"]?.trim();

  if (!agentId || !model) {
    throw new CodeCouncilError(`Invalid model selection "${value}". Use agent=model.`, {
      code: "INVALID_MODEL_SELECTION",
      exitCode: 2
    });
  }

  return {
    agentId,
    model
  };
}

function hasModelArg(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--model" || arg === "-m");
}
