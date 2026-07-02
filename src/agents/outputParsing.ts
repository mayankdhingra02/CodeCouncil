import {
  implementationOutputSchema,
  planOutputSchema,
  reconciliationOutputSchema,
  reviewOutputSchema,
  type ImplementationOutput,
  type PlanOutput,
  type ReconciliationOutput,
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

export function buildReconciliationOutputFromCommand(input: {
  agentId: AgentId;
  displayName: string;
  result: AgentCommandResult;
}): ReconciliationOutput {
  const parsedOutput = parseAgentStdout(input.result.stdout);
  const candidate = findReconciliationCandidate(parsedOutput) ?? findObjectCandidate(parsedOutput);
  const mergedPlan = isRecord(candidate?.["mergedPlan"]) ? candidate["mergedPlan"] : candidate;

  return reconciliationOutputSchema.parse({
    reconcilerAgentId: input.agentId,
    displayName: input.displayName,
    generatedAt: input.result.completedAt,
    mergedPlan: {
      summary:
        getString(mergedPlan, "summary") ??
        firstMeaningfulLine(input.result.stdout) ??
        "Agent returned reconciled planning output.",
      assumptions: getStringArray(mergedPlan, "assumptions"),
      files: firstNonEmptyArray([
        getStringArray(mergedPlan, "files"),
        getStringArray(mergedPlan, "proposedFilesToChange")
      ]),
      steps: firstNonEmptyArray([
        getStringArray(mergedPlan, "steps"),
        getStringArray(mergedPlan, "stepByStepPlan")
      ]),
      risks: getStringArray(mergedPlan, "risks"),
      tests: firstNonEmptyArray([
        getStringArray(mergedPlan, "tests"),
        getStringArray(mergedPlan, "testsToRun")
      ]),
      estimatedComplexity: normalizeComplexity(getString(mergedPlan, "estimatedComplexity"))
    },
    resolutions: parseResolutionObjects(candidate),
    rejectedIdeas: parseRejectedIdeaObjects(candidate),
    openQuestionsForHuman: getStringArray(candidate, "openQuestionsForHuman"),
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
  return selectBestCandidate(value, scorePlanCandidate, 4);
}

function findObjectCandidate(value: unknown): Record<string, unknown> | undefined {
  return selectBestCandidate(value, scoreGenericCandidate, 2);
}

function findReconciliationCandidate(value: unknown): Record<string, unknown> | undefined {
  return selectBestCandidate(value, scoreReconciliationCandidate, 3);
}

function selectBestCandidate(
  value: unknown,
  scoreCandidate: (candidate: Record<string, unknown>) => number,
  minimumScore: number
): Record<string, unknown> | undefined {
  let best: { candidate: Record<string, unknown>; index: number; score: number } | undefined;
  const candidates = collectObjectCandidates(value);

  candidates.forEach((candidate, index) => {
    const score = scoreCandidate(candidate);

    if (score < minimumScore) {
      return;
    }

    if (!best || score > best.score || (score === best.score && index > best.index)) {
      best = { candidate, index, score };
    }
  });

  return best?.candidate;
}

function collectObjectCandidates(
  value: unknown,
  candidates: Record<string, unknown>[] = [],
  seen: Set<unknown> = new Set(),
  depth = 0
): Record<string, unknown>[] {
  if (depth > 24 || seen.has(value)) {
    return candidates;
  }

  if (typeof value === "string") {
    for (const parsed of parseEmbeddedJsonCandidates(value)) {
      collectObjectCandidates(parsed, candidates, seen, depth + 1);
    }

    return candidates;
  }

  if (Array.isArray(value)) {
    seen.add(value);

    for (const item of value) {
      collectObjectCandidates(item, candidates, seen, depth + 1);
    }

    return candidates;
  }

  if (isRecord(value)) {
    seen.add(value);
    candidates.push(value);

    for (const nestedValue of Object.values(value)) {
      collectObjectCandidates(nestedValue, candidates, seen, depth + 1);
    }
  }

  return candidates;
}

function parseEmbeddedJsonCandidates(value: string): unknown[] {
  const trimmed = value.trim();

  if (!trimmed.includes("{") && !trimmed.includes("[") && !trimmed.includes("```")) {
    return [];
  }

  const candidates: unknown[] = [];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const direct = tryParseJson(trimmed);

    if (direct !== undefined) {
      candidates.push(direct);
    }
  }

  const fencedJson = /```(?:json)?\s*([\s\S]*?)```/giu;

  for (const match of trimmed.matchAll(fencedJson)) {
    const [, source] = match;

    if (!source) {
      continue;
    }

    const parsed = tryParseJson(source.trim());

    if (parsed !== undefined) {
      candidates.push(parsed);
    }
  }

  return candidates;
}

function scorePlanCandidate(candidate: Record<string, unknown>): number {
  let score = 0;

  if (typeof candidate["summary"] === "string") {
    score += 2;
  }

  for (const key of [
    "assumptions",
    "proposedFilesToChange",
    "stepByStepPlan",
    "risks",
    "testsToRun"
  ]) {
    if (Array.isArray(candidate[key])) {
      score += 2;
    }
  }

  if (typeof candidate["estimatedComplexity"] === "string") {
    score += 1;
  }

  if (typeof candidate["confidence"] === "number") {
    score += 1;
  }

  return score;
}

function scoreGenericCandidate(candidate: Record<string, unknown>): number {
  let score = 0;

  if (typeof candidate["summary"] === "string") {
    score += 2;
  }

  for (const key of [
    "blockingIssues",
    "createdFiles",
    "filesChanged",
    "nonBlockingIssues",
    "recommendation",
    "securityConcerns",
    "suggestedFixes",
    "verdict"
  ]) {
    if (typeof candidate[key] === "string" || Array.isArray(candidate[key])) {
      score += 2;
    }
  }

  return score;
}

function scoreReconciliationCandidate(candidate: Record<string, unknown>): number {
  let score = 0;

  if (isRecord(candidate["mergedPlan"])) {
    score += 4;
  }

  for (const key of ["resolutions", "rejectedIdeas", "openQuestionsForHuman"]) {
    if (Array.isArray(candidate[key])) {
      score += 2;
    }
  }

  if (typeof candidate["confidence"] === "number") {
    score += 1;
  }

  return score;
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

function getObjectArray(value: Record<string, unknown> | undefined, key: string): Record<string, unknown>[] {
  const raw = value?.[key];

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter(isRecord);
}

function parseResolutionObjects(candidate: Record<string, unknown> | undefined) {
  return getObjectArray(candidate, "resolutions").map((item) => ({
    disagreement: getString(item, "disagreement") ?? "Unspecified disagreement.",
    chosenAgentId: getString(item, "chosenAgentId") ?? getString(item, "chosenAgent") ?? "synthesis",
    rationale: getString(item, "rationale") ?? "No rationale provided.",
    evidence: getStringArray(item, "evidence")
  }));
}

function parseRejectedIdeaObjects(candidate: Record<string, unknown> | undefined) {
  return getObjectArray(candidate, "rejectedIdeas").map((item) => ({
    agentId: getString(item, "agentId") ?? "unknown",
    item: getString(item, "item") ?? "Unspecified idea.",
    why: getString(item, "why") ?? "No rationale provided."
  }));
}

function firstNonEmptyArray(values: readonly string[][]): string[] {
  return values.find((value) => value.length > 0) ?? [];
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
