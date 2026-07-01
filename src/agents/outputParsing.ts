import {
  implementationOutputSchema,
  planOutputSchema,
  reviewOutputSchema,
  type ImplementationOutput,
  type PlanOutput,
  type ReviewOutput
} from "./types.js";
import type { AgentCommandResult } from "./commandRunner.js";
import type { AgentId } from "../config/schema.js";

export function parseAgentStdout(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();

  if (!trimmed) {
    return undefined;
  }

  const direct = tryParseJson(trimmed);

  if (direct !== undefined) {
    return direct;
  }

  const fencedJson = trimmed.match(/```json\s*([\s\S]*?)```/iu)?.[1];

  if (fencedJson) {
    const fenced = tryParseJson(fencedJson.trim());

    if (fenced !== undefined) {
      return fenced;
    }
  }

  const jsonLines = trimmed
    .split(/\r?\n/u)
    .map((line) => tryParseJson(line))
    .filter((line): line is unknown => line !== undefined);

  return jsonLines.length > 0 ? jsonLines : undefined;
}

export function buildPlanOutputFromCommand(input: {
  agentId: AgentId;
  displayName: string;
  result: AgentCommandResult;
}): PlanOutput {
  const parsedOutput = parseAgentStdout(input.result.stdout);
  const candidate = findPlanCandidate(parsedOutput);
  const fallbackSummary = firstMeaningfulLine(input.result.stdout) || "Agent returned planning output.";

  return planOutputSchema.parse({
    agentId: input.agentId,
    displayName: input.displayName,
    generatedAt: input.result.completedAt,
    summary: getString(candidate, "summary") ?? fallbackSummary,
    assumptions: getStringArray(candidate, "assumptions"),
    proposedFilesToChange: getStringArray(candidate, "proposedFilesToChange"),
    stepByStepPlan: getStringArray(candidate, "stepByStepPlan"),
    risks: getStringArray(candidate, "risks"),
    testsToRun: getStringArray(candidate, "testsToRun"),
    estimatedComplexity: normalizeComplexity(getString(candidate, "estimatedComplexity")),
    confidence: normalizeConfidence(candidate?.["confidence"]),
    command: toCommandMetadata(input.result),
    error: input.result.error,
    metadata: {
      parsed: parsedOutput !== undefined
    },
    parsedOutput,
    rawOutput: {
      stdout: input.result.stdout,
      stderr: input.result.stderr
    }
  });
}

export function buildImplementationOutputFromCommand(input: {
  agentId: AgentId;
  displayName: string;
  result: AgentCommandResult;
}): ImplementationOutput {
  const parsedOutput = parseAgentStdout(input.result.stdout);
  const candidate = findObjectCandidate(parsedOutput);

  return implementationOutputSchema.parse({
    agentId: input.agentId,
    displayName: input.displayName,
    completedAt: input.result.completedAt,
    status: input.result.exitCode === 0 ? "success" : "failed",
    summary:
      getString(candidate, "summary") ??
      firstMeaningfulLine(input.result.stdout) ??
      "Agent implementation command completed.",
    filesChanged: getStringArray(candidate, "filesChanged"),
    createdFiles: getStringArray(candidate, "createdFiles"),
    command: toCommandMetadata(input.result),
    error: input.result.error,
    metadata: {
      parsed: parsedOutput !== undefined
    },
    parsedOutput,
    rawOutput: {
      stdout: input.result.stdout,
      stderr: input.result.stderr
    }
  });
}

export function buildReviewOutputFromCommand(input: {
  agentId: AgentId;
  displayName: string;
  result: AgentCommandResult;
  targetAgentId: AgentId;
}): ReviewOutput {
  const parsedOutput = parseAgentStdout(input.result.stdout);
  const candidate = findObjectCandidate(parsedOutput);

  return reviewOutputSchema.parse({
    reviewerAgentId: input.agentId,
    targetAgentId: input.targetAgentId,
    displayName: input.displayName,
    generatedAt: input.result.completedAt,
    verdict: normalizeVerdict(getString(candidate, "verdict") ?? getString(candidate, "overallVerdict")),
    summary:
      getString(candidate, "summary") ??
      firstMeaningfulLine(input.result.stdout) ??
      "Agent returned review output.",
    blockingIssues: getStringArray(candidate, "blockingIssues"),
    nonBlockingIssues: getStringArray(candidate, "nonBlockingIssues"),
    securityConcerns: getStringArray(candidate, "securityConcerns"),
    missingTests: getStringArray(candidate, "missingTests"),
    edgeCases: getStringArray(candidate, "edgeCases"),
    maintainabilityConcerns: getStringArray(candidate, "maintainabilityConcerns"),
    suggestedFixes: getStringArray(candidate, "suggestedFixes"),
    findings: getStringArray(candidate, "findings"),
    riskyAreas: getStringArray(candidate, "riskyAreas"),
    recommendation: getString(candidate, "recommendation") ?? "Review the raw output before proceeding.",
    confidence: normalizeConfidence(candidate?.["confidence"]),
    command: toCommandMetadata(input.result),
    error: input.result.error,
    metadata: {
      parsed: parsedOutput !== undefined
    },
    parsedOutput,
    rawOutput: {
      stdout: input.result.stdout,
      stderr: input.result.stderr
    }
  });
}

function toCommandMetadata(result: AgentCommandResult) {
  return {
    args: result.args,
    command: result.command,
    completedAt: result.completedAt,
    cwd: result.cwd,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    startedAt: result.startedAt,
    timedOut: result.timedOut
  };
}

function findPlanCandidate(value: unknown): Record<string, unknown> | undefined {
  const candidate = findObjectCandidate(value);

  if (!candidate) {
    return undefined;
  }

  if ("summary" in candidate || "stepByStepPlan" in candidate) {
    return candidate;
  }

  return undefined;
}

function findObjectCandidate(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    if (typeof value["summary"] === "string") {
      return value;
    }

    for (const nestedValue of Object.values(value)) {
      const nested = findObjectCandidate(nestedValue);

      if (nested) {
        return nested;
      }
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findObjectCandidate(item);

      if (nested) {
        return nested;
      }
    }
  }

  return undefined;
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const raw = value?.[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function getStringArray(value: Record<string, unknown> | undefined, key: string): string[] {
  const raw = value?.[key];

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function firstMeaningfulLine(value: string): string | undefined {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.slice(0, 240);
}

function normalizeComplexity(value: string | undefined): "low" | "medium" | "high" {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }

  return "medium";
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0.5;
  }

  return Math.min(1, Math.max(0, value));
}

function normalizeVerdict(value: string | undefined): "approve" | "request_changes" | "reject" {
  const normalized = value?.trim().toLowerCase().replace(/[\s-]+/gu, "_");

  if (normalized === "approve" || normalized === "approved") {
    return "approve";
  }

  if (normalized === "reject" || normalized === "rejected") {
    return "reject";
  }

  return "request_changes";
}
