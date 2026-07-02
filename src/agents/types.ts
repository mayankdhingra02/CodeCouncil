import { z } from "zod";

import type { AgentConfig, AgentId, CodeCouncilConfig } from "../config/schema.js";
import type { TaskSession } from "../session/schema.js";

export const agentCapabilitySchema = z.enum(["plan", "implement", "reconcile", "review"]);

export const estimatedComplexitySchema = z.enum(["low", "medium", "high"]);
export const reviewVerdictSchema = z.enum(["approve", "request_changes", "reject"]);

export const agentAvailabilitySchema = z
  .object({
    available: z.boolean(),
    reason: z.string().optional(),
    command: z.string().optional(),
    metadata: z.record(z.unknown()).default({})
  })
  .strict();

export const agentCommandMetadataSchema = z
  .object({
    args: z.array(z.string()),
    command: z.string().min(1),
    completedAt: z.string().datetime({ offset: true }),
    cwd: z.string().min(1),
    durationMs: z.number().nonnegative(),
    exitCode: z.number().int().optional(),
    startedAt: z.string().datetime({ offset: true }),
    timedOut: z.boolean().default(false)
  })
  .strict();

export const rawAgentOutputSchema = z
  .object({
    stderr: z.string().default(""),
    stdout: z.string().default("")
  })
  .strict();

export const planOutputSchema = z
  .object({
    agentId: z.string().min(1),
    displayName: z.string().min(1),
    generatedAt: z.string().datetime({ offset: true }),
    summary: z.string().min(1),
    assumptions: z.array(z.string()).default([]),
    proposedFilesToChange: z.array(z.string()).default([]),
    stepByStepPlan: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
    testsToRun: z.array(z.string()).default([]),
    estimatedComplexity: estimatedComplexitySchema,
    confidence: z.number().min(0).max(1),
    command: agentCommandMetadataSchema.optional(),
    error: z.string().optional(),
    metadata: z.record(z.unknown()).default({}),
    parsedOutput: z.unknown().optional(),
    rawOutput: rawAgentOutputSchema.optional()
  })
  .strict();

export const implementationOutputSchema = z
  .object({
    agentId: z.string().min(1),
    displayName: z.string().min(1),
    completedAt: z.string().datetime({ offset: true }),
    status: z.enum(["success", "failed", "skipped"]),
    summary: z.string().min(1),
    filesChanged: z.array(z.string()).default([]),
    createdFiles: z.array(z.string()).default([]),
    command: agentCommandMetadataSchema.optional(),
    error: z.string().optional(),
    metadata: z.record(z.unknown()).default({}),
    parsedOutput: z.unknown().optional(),
    rawOutput: rawAgentOutputSchema.optional()
  })
  .strict();

export const reviewOutputSchema = z
  .object({
    reviewerAgentId: z.string().min(1),
    targetAgentId: z.string().min(1),
    displayName: z.string().min(1),
    generatedAt: z.string().datetime({ offset: true }),
    verdict: reviewVerdictSchema.default("request_changes"),
    summary: z.string().min(1),
    blockingIssues: z.array(z.string()).default([]),
    nonBlockingIssues: z.array(z.string()).default([]),
    securityConcerns: z.array(z.string()).default([]),
    missingTests: z.array(z.string()).default([]),
    edgeCases: z.array(z.string()).default([]),
    maintainabilityConcerns: z.array(z.string()).default([]),
    suggestedFixes: z.array(z.string()).default([]),
    findings: z.array(z.string()).default([]),
    riskyAreas: z.array(z.string()).default([]),
    recommendation: z.string().min(1),
    confidence: z.number().min(0).max(1),
    command: agentCommandMetadataSchema.optional(),
    error: z.string().optional(),
    metadata: z.record(z.unknown()).default({}),
    parsedOutput: z.unknown().optional(),
    rawOutput: rawAgentOutputSchema.optional()
  })
  .strict();

export const reconciledPlanSchema = z
  .object({
    summary: z.string().min(1),
    assumptions: z.array(z.string()).default([]),
    files: z.array(z.string()).default([]),
    steps: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
    tests: z.array(z.string()).default([]),
    estimatedComplexity: estimatedComplexitySchema.default("medium")
  })
  .strict();

export const reconciliationResolutionSchema = z
  .object({
    disagreement: z.string().min(1),
    chosenAgentId: z.string().min(1),
    rationale: z.string().min(1),
    evidence: z.array(z.string()).default([])
  })
  .strict();

export const rejectedReconciliationIdeaSchema = z
  .object({
    agentId: z.string().min(1),
    item: z.string().min(1),
    why: z.string().min(1)
  })
  .strict();

export const reconciliationOutputSchema = z
  .object({
    reconcilerAgentId: z.string().min(1),
    displayName: z.string().min(1),
    generatedAt: z.string().datetime({ offset: true }),
    mergedPlan: reconciledPlanSchema,
    resolutions: z.array(reconciliationResolutionSchema).default([]),
    rejectedIdeas: z.array(rejectedReconciliationIdeaSchema).default([]),
    openQuestionsForHuman: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1),
    command: agentCommandMetadataSchema.optional(),
    error: z.string().optional(),
    metadata: z.record(z.unknown()).default({}),
    parsedOutput: z.unknown().optional(),
    rawOutput: rawAgentOutputSchema.optional()
  })
  .strict();

export type AgentCapability = z.infer<typeof agentCapabilitySchema>;
export type AgentAvailability = z.infer<typeof agentAvailabilitySchema>;
export type AgentCommandMetadata = z.infer<typeof agentCommandMetadataSchema>;
export type PlanOutput = z.infer<typeof planOutputSchema>;
export type ImplementationOutput = z.infer<typeof implementationOutputSchema>;
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;
export type ReconciliationOutput = z.infer<typeof reconciliationOutputSchema>;
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

export interface PlanInput {
  config: CodeCouncilConfig;
  repoRoot: string;
  session: TaskSession;
  task: string;
}

export interface ImplementationInput {
  approvedPlanMarkdown?: string;
  config: CodeCouncilConfig;
  plan?: PlanOutput;
  repoRoot: string;
  session: TaskSession;
  task: string;
  worktreePath: string;
}

export interface ReviewInput {
  approvedPlanMarkdown?: string;
  changedFiles: string[];
  config: CodeCouncilConfig;
  diff: string;
  diffMode?: "full" | "summary";
  repoRoot: string;
  session: TaskSession;
  safetyWarnings?: string[];
  targetAgentId: AgentId;
  targetDisplayName?: string;
  task: string;
  testSummary?: string;
}

export interface ReconciliationPlanInput {
  alias: string;
  plan: PlanOutput;
}

export interface ReconciliationInput {
  comparison: unknown;
  config: CodeCouncilConfig;
  plans: ReconciliationPlanInput[];
  repoRoot: string;
  session: TaskSession;
  task: string;
}

export interface CodeCouncilAgent {
  readonly capabilities: readonly AgentCapability[];
  readonly config: AgentConfig;
  readonly displayName: string;
  readonly id: AgentId;

  checkAvailability(): Promise<AgentAvailability>;
  generatePlan(input: PlanInput): Promise<PlanOutput>;
  implementTask(input: ImplementationInput): Promise<ImplementationOutput>;
  reconcilePlans(input: ReconciliationInput): Promise<ReconciliationOutput>;
  reviewDiff(input: ReviewInput): Promise<ReviewOutput>;
}
