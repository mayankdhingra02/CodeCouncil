import { CodeCouncilError } from "../core/errors.js";
import type { AgentConfig, AgentId, CodeCouncilConfig } from "../config/schema.js";
import { createClaudeCodeAgent, createCodexAgent } from "./cliAgents.js";
import { createMockClaudeAgent, createMockCodexAgent } from "./mockAgents.js";
import type { CodeCouncilAgent } from "./types.js";
import type { AgentCommandRunner } from "./commandRunner.js";

type AgentFactory = (
  id: AgentId,
  config: AgentConfig,
  runner?: AgentCommandRunner
) => CodeCouncilAgent;

const BUILT_IN_AGENT_FACTORIES = new Map<string, AgentFactory>([
  ["mock-codex", createMockCodexAgent],
  ["mock-claude", createMockClaudeAgent],
  ["codex", createCodexAgent],
  ["claude", createClaudeCodeAgent]
]);

export class AgentRegistry {
  private readonly agents = new Map<AgentId, CodeCouncilAgent>();

  public static fromConfig(config: CodeCouncilConfig, runner?: AgentCommandRunner): AgentRegistry {
    const registry = new AgentRegistry();

    for (const [id, agentConfig] of Object.entries(config.agents)) {
      if (!agentConfig.enabled) {
        continue;
      }

      const adapterId = agentConfig.adapter ?? id;
      const factory = BUILT_IN_AGENT_FACTORIES.get(adapterId);

      if (!factory) {
        throw new CodeCouncilError(
          `Agent "${id}" is enabled with adapter "${adapterId}", but no adapter is registered for it. Available adapters: ${[
            ...BUILT_IN_AGENT_FACTORIES.keys()
          ].join(", ")}.`,
          {
            code: "AGENT_ADAPTER_NOT_FOUND",
            exitCode: 2
          }
        );
      }

      registry.register(factory(id, agentConfig, runner));
    }

    if (registry.listEnabled().length === 0) {
      throw new CodeCouncilError("No enabled agents are available.", {
        code: "NO_ENABLED_AGENTS",
        exitCode: 2
      });
    }

    return registry;
  }

  public register(agent: CodeCouncilAgent): void {
    this.agents.set(agent.id, agent);
  }

  public get(agentId: AgentId): CodeCouncilAgent {
    const agent = this.agents.get(agentId);

    if (!agent) {
      throw new CodeCouncilError(`Agent "${agentId}" is not enabled for this project.`, {
        code: "AGENT_NOT_ENABLED",
        exitCode: 2
      });
    }

    return agent;
  }

  public listEnabled(): CodeCouncilAgent[] {
    return [...this.agents.values()];
  }

  public select(agentIds: readonly AgentId[]): CodeCouncilAgent[] {
    if (agentIds.length === 0) {
      return this.listEnabled();
    }

    return [...new Set(agentIds)].map((agentId) => this.get(agentId));
  }
}

export function listBuiltInAgentIds(): AgentId[] {
  return [...BUILT_IN_AGENT_FACTORIES.keys()];
}
