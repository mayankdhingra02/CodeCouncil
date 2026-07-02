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
  stage?: AgentStage
): CodeCouncilConfig {
  if (!selection.defaultModel && Object.keys(selection.byAgent).length === 0) {
    return config;
  }

  const nextConfig: CodeCouncilConfig = {
    ...config,
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([agentId, agentConfig]) => {
        const selectedModel = selection.byAgent[agentId] ?? selection.defaultModel;

        if (!selectedModel) {
          return [agentId, agentConfig];
        }

        return [
          agentId,
          applyModelToAgentConfig(agentConfig, selectedModel, stage)
        ];
      })
    )
  };

  return nextConfig;
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
