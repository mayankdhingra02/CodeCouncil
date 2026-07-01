import { z } from "zod";

import { agentIdSchema } from "../config/schema.js";

export const timestampSchema = z.string().datetime({ offset: true });

export const runStatusSchema = z.enum([
  "created",
  "pending",
  "running",
  "success",
  "failed",
  "skipped",
  "cancelled"
]);

export const taskSessionPathsSchema = z
  .object({
    rootDir: z.string().min(1),
    sessionDir: z.string().min(1),
    taskFile: z.string().min(1),
    eventsFile: z.string().min(1),
    plansDir: z.string().min(1),
    worktreesDir: z.string().min(1),
    diffsDir: z.string().min(1),
    reviewsDir: z.string().min(1),
    testsDir: z.string().min(1),
    reportsDir: z.string().min(1)
  })
  .strict();

export const taskSessionSchema = z
  .object({
    id: z.string().min(1),
    slug: z.string().min(1),
    task: z.string().min(1),
    projectName: z.string().min(1),
    baseBranch: z.string().min(1),
    workspaceDir: z.string().min(1),
    createdAt: timestampSchema,
    status: runStatusSchema.default("created"),
    paths: taskSessionPathsSchema
  })
  .strict();

export const agentPlanSchema = z
  .object({
    sessionId: z.string().min(1),
    agentId: agentIdSchema,
    createdAt: timestampSchema,
    status: runStatusSchema,
    plan: z.string().default(""),
    summary: z.string().optional(),
    metadata: z.record(z.unknown()).default({})
  })
  .strict();

export const agentRunSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    agentId: agentIdSchema,
    phase: z.enum(["plan", "implement", "review"]),
    status: runStatusSchema,
    startedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    exitCode: z.number().int().optional(),
    worktreePath: z.string().optional(),
    outputPath: z.string().optional(),
    error: z.string().optional(),
    metadata: z.record(z.unknown()).default({})
  })
  .strict();

export const diffReviewSchema = z
  .object({
    sessionId: z.string().min(1),
    reviewerAgentId: agentIdSchema,
    targetAgentId: agentIdSchema,
    createdAt: timestampSchema,
    status: runStatusSchema,
    diffPath: z.string().optional(),
    summary: z.string().default(""),
    findings: z.array(z.string()).default([]),
    metadata: z.record(z.unknown()).default({})
  })
  .strict();

export const testResultSchema = z
  .object({
    sessionId: z.string().min(1),
    command: z.string().min(1),
    status: z.enum(["passed", "failed", "skipped", "error"]),
    startedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    exitCode: z.number().int().optional(),
    stdoutPath: z.string().optional(),
    stderrPath: z.string().optional(),
    metadata: z.record(z.unknown()).default({})
  })
  .strict();

export const finalRecommendationSchema = z
  .object({
    sessionId: z.string().min(1),
    createdAt: timestampSchema,
    status: runStatusSchema,
    recommendedAgentId: agentIdSchema.optional(),
    summary: z.string().default(""),
    reasons: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
    nextSteps: z.array(z.string()).default([]),
    metadata: z.record(z.unknown()).default({})
  })
  .strict();

export const eventLogEntrySchema = z
  .object({
    timestamp: timestampSchema,
    type: z.string().min(1),
    agentId: agentIdSchema.optional(),
    status: runStatusSchema.optional(),
    message: z.string().min(1),
    metadata: z.record(z.unknown()).default({})
  })
  .strict();

export type TaskSession = z.infer<typeof taskSessionSchema>;
export type AgentPlan = z.infer<typeof agentPlanSchema>;
export type AgentRun = z.infer<typeof agentRunSchema>;
export type DiffReview = z.infer<typeof diffReviewSchema>;
export type TestResult = z.infer<typeof testResultSchema>;
export type FinalRecommendation = z.infer<typeof finalRecommendationSchema>;
export type EventLogEntry = z.infer<typeof eventLogEntrySchema>;

