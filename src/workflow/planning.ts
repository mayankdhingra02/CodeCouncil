import {
  AgentRegistry,
  comparePlans,
  savePlanArtifacts,
  savePlanComparisonArtifacts
} from "../agents/index.js";
import { CodeCouncilError } from "../core/errors.js";
import { appendSessionEvent, createTaskSession, type TaskSession } from "../session/index.js";
import type {
  PlanComparison,
  PlanOutput,
  SavedComparisonArtifact,
  SavedPlanArtifact
} from "../agents/index.js";
import type { AgentId, CodeCouncilConfig } from "../config/schema.js";

export interface RunPlanningStageInput {
  agentIds: readonly AgentId[];
  config: CodeCouncilConfig;
  deadlineMs?: number;
  repoRoot: string;
  session?: TaskSession;
  task: string;
}

export interface PlanningStageResult {
  agents: AgentId[];
  artifacts: SavedPlanArtifact[];
  comparison: PlanComparison;
  comparisonArtifact: SavedComparisonArtifact;
  plans: PlanOutput[];
  session: TaskSession;
}

export async function runPlanningStage(input: RunPlanningStageInput): Promise<PlanningStageResult> {
  const session =
    input.session ??
    (await createTaskSession({
      config: input.config,
      rootDir: input.repoRoot,
      task: input.task
    }));
  const registry = AgentRegistry.fromConfig(input.config);
  const agents = registry.select(input.agentIds);
  const plans: PlanOutput[] = [];
  const artifacts: SavedPlanArtifact[] = [];

  await appendSessionEvent(session, {
    type: "plan.started",
    status: "running",
    message: "Started agent planning.",
    metadata: {
      agents: agents.map((agent) => agent.id)
    }
  });

  for (const agent of agents) {
    assertWithinDeadline(input.deadlineMs, "planning");

    await appendSessionEvent(session, {
      type: "agent.plan.started",
      agentId: agent.id,
      status: "running",
      message: `Started plan generation with ${agent.displayName}.`
    });

    try {
      const availability = await agent.checkAvailability();

      if (!availability.available) {
        throw new CodeCouncilError(
          `Agent "${agent.id}" is not available: ${availability.reason ?? "unknown reason"}`,
          {
            code: "AGENT_NOT_AVAILABLE",
            exitCode: 2
          }
        );
      }

      const plan = await agent.generatePlan({
        config: input.config,
        repoRoot: input.repoRoot,
        session,
        task: input.task
      });
      const saved = await savePlanArtifacts(session, plan);

      plans.push(plan);
      artifacts.push(saved);

      await appendSessionEvent(session, {
        type: "agent.plan.completed",
        agentId: agent.id,
        status: "success",
        message: `Completed plan generation with ${agent.displayName}.`,
        metadata: {
          jsonPath: saved.jsonPath,
          markdownPath: saved.markdownPath
        }
      });
    } catch (error) {
      await appendSessionEvent(session, {
        type: "agent.plan.failed",
        agentId: agent.id,
        status: "failed",
        message: error instanceof Error ? error.message : "Agent planning failed."
      });
      throw error;
    }
  }

  const comparison = comparePlans(plans);
  const comparisonArtifact = await savePlanComparisonArtifacts(session, comparison);

  await appendSessionEvent(session, {
    type: "plan.completed",
    status: "success",
    message: "Completed agent planning.",
    metadata: {
      agents: plans.map((plan) => plan.agentId),
      comparisonJsonPath: comparisonArtifact.jsonPath,
      comparisonMarkdownPath: comparisonArtifact.markdownPath,
      planCount: plans.length
    }
  });

  return {
    agents: plans.map((plan) => plan.agentId),
    artifacts,
    comparison,
    comparisonArtifact,
    plans,
    session
  };
}

function assertWithinDeadline(deadlineMs: number | undefined, stage: string): void {
  if (deadlineMs !== undefined && Date.now() > deadlineMs) {
    throw new CodeCouncilError(`Solve workflow exceeded --max-duration before ${stage}.`, {
      code: "WORKFLOW_TIMEOUT",
      exitCode: 2
    });
  }
}
