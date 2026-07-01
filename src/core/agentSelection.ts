import { CodeCouncilError } from "./errors.js";
import type { AgentConfig, AgentId, CodeCouncilConfig } from "../config/schema.js";

export type SelectedAgentConfig = AgentConfig & {
  id: AgentId;
};

export function resolveSelectedAgents(
  config: CodeCouncilConfig,
  requestedAgentIds: readonly string[]
): SelectedAgentConfig[] {
  const configuredAgents = Object.entries(config.agents).map(([id, agent]) => ({
    ...agent,
    id
  }));
  const enabledAgents = configuredAgents.filter((agent) => agent.enabled);
  const selectedIds =
    requestedAgentIds.length > 0 ? [...new Set(requestedAgentIds)] : enabledAgents.map((agent) => agent.id);

  const selectedAgents = selectedIds.map((agentId) => {
    const agent = configuredAgents.find((candidate) => candidate.id === agentId);

    if (!agent) {
      throw new CodeCouncilError(`Unknown agent "${agentId}". Check your config or --agent option.`, {
        code: "UNKNOWN_AGENT",
        exitCode: 2
      });
    }

    if (!agent.enabled) {
      throw new CodeCouncilError(`Agent "${agentId}" is disabled in the active config.`, {
        code: "DISABLED_AGENT",
        exitCode: 2
      });
    }

    return agent;
  });

  if (selectedAgents.length === 0) {
    throw new CodeCouncilError("No enabled agents are configured.", {
      code: "NO_ENABLED_AGENTS",
      exitCode: 2
    });
  }

  return selectedAgents;
}
