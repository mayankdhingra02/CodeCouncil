import type { ReconciliationOutput } from "../agents/index.js";

export interface ReconcilerBiasMetrics {
  otherPlannerSelections: number;
  reconcilerAgentId: string;
  reconcilerPlanSelections: number;
  reconcilerWasAlsoPlanner: boolean;
  selectionsByAgentId: Record<string, number>;
  sourcePlanAgentIds: string[];
  synthesisSelections: number;
  totalResolutions: number;
  unknownSelections: number;
}

export function summarizeReconcilerBias(input: {
  reconciliation: ReconciliationOutput;
  reconcilerAgentId: string;
  reconcilerWasAlsoPlanner: boolean;
  sourcePlanAgentIds: readonly string[];
}): ReconcilerBiasMetrics {
  const sourceIdByNormalized = new Map(
    input.sourcePlanAgentIds.map((agentId) => [agentId.toLowerCase(), agentId])
  );
  const selectionsByAgentId = Object.fromEntries(input.sourcePlanAgentIds.map((agentId) => [agentId, 0]));
  let otherPlannerSelections = 0;
  let reconcilerPlanSelections = 0;
  let synthesisSelections = 0;
  let unknownSelections = 0;

  for (const resolution of input.reconciliation.resolutions) {
    const normalizedChoice = resolution.chosenAgentId.trim().toLowerCase();

    if (normalizedChoice === "synthesis") {
      synthesisSelections += 1;
      continue;
    }

    const sourceAgentId = sourceIdByNormalized.get(normalizedChoice);

    if (!sourceAgentId) {
      unknownSelections += 1;
      continue;
    }

    selectionsByAgentId[sourceAgentId] = (selectionsByAgentId[sourceAgentId] ?? 0) + 1;

    if (sourceAgentId.toLowerCase() === input.reconcilerAgentId.toLowerCase()) {
      reconcilerPlanSelections += 1;
    } else {
      otherPlannerSelections += 1;
    }
  }

  return {
    otherPlannerSelections,
    reconcilerAgentId: input.reconcilerAgentId,
    reconcilerPlanSelections,
    reconcilerWasAlsoPlanner: input.reconcilerWasAlsoPlanner,
    selectionsByAgentId,
    sourcePlanAgentIds: [...input.sourcePlanAgentIds],
    synthesisSelections,
    totalResolutions: input.reconciliation.resolutions.length,
    unknownSelections
  };
}

export function readReconcilerBiasMetrics(value: unknown): ReconcilerBiasMetrics | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const metrics = {
    otherPlannerSelections: readNumber(value["otherPlannerSelections"]),
    reconcilerAgentId: typeof value["reconcilerAgentId"] === "string" ? value["reconcilerAgentId"] : undefined,
    reconcilerPlanSelections: readNumber(value["reconcilerPlanSelections"]),
    reconcilerWasAlsoPlanner: typeof value["reconcilerWasAlsoPlanner"] === "boolean" ? value["reconcilerWasAlsoPlanner"] : undefined,
    selectionsByAgentId: isRecord(value["selectionsByAgentId"])
      ? Object.fromEntries(
        Object.entries(value["selectionsByAgentId"]).filter((entry): entry is [string, number] => typeof entry[1] === "number")
      )
      : undefined,
    sourcePlanAgentIds: Array.isArray(value["sourcePlanAgentIds"])
      ? value["sourcePlanAgentIds"].filter((item): item is string => typeof item === "string")
      : undefined,
    synthesisSelections: readNumber(value["synthesisSelections"]),
    totalResolutions: readNumber(value["totalResolutions"]),
    unknownSelections: readNumber(value["unknownSelections"])
  };

  if (
    metrics.otherPlannerSelections === undefined ||
    metrics.reconcilerAgentId === undefined ||
    metrics.reconcilerPlanSelections === undefined ||
    metrics.reconcilerWasAlsoPlanner === undefined ||
    metrics.selectionsByAgentId === undefined ||
    metrics.sourcePlanAgentIds === undefined ||
    metrics.synthesisSelections === undefined ||
    metrics.totalResolutions === undefined ||
    metrics.unknownSelections === undefined
  ) {
    return undefined;
  }

  return metrics as ReconcilerBiasMetrics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
