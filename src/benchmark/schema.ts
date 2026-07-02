import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { ConfigError } from "../core/errors.js";

export const benchmarkStrategySchema = z.enum([
  "codex_only",
  "claude_only",
  "codex_then_claude_review",
  "claude_then_codex_review",
  "both_independent_then_select",
  "both_plan_then_one_implement",
  "both_implement_then_review_and_select"
]);

export const benchmarkTaskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    repositoryPath: z.string().min(1),
    baseBranch: z.string().min(1).default("main"),
    testCommands: z.array(z.string().min(1)).optional(),
    expectedFiles: z.array(z.string().min(1)).optional(),
    evaluationNotes: z.string().optional()
  })
  .strict();

export const benchmarkTaskFileSchema = z.array(benchmarkTaskSchema).min(1);

export type BenchmarkStrategy = z.infer<typeof benchmarkStrategySchema>;
export type BenchmarkTask = z.infer<typeof benchmarkTaskSchema>;

export const DEFAULT_BENCHMARK_STRATEGIES: readonly BenchmarkStrategy[] = benchmarkStrategySchema.options;

export async function loadBenchmarkTasks(tasksPath: string): Promise<BenchmarkTask[]> {
  try {
    const source = await readFile(tasksPath, "utf8");
    return benchmarkTaskFileSchema.parse(JSON.parse(source) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ConfigError(`Invalid benchmark task JSON in ${tasksPath}: ${error.message}`, error);
    }

    if (error instanceof z.ZodError) {
      throw new ConfigError(
        `Invalid benchmark task file in ${tasksPath}: ${error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; ")}`,
        error
      );
    }

    throw error;
  }
}

export function resolveTaskRepositoryPath(task: BenchmarkTask, tasksPath: string): string {
  return path.resolve(path.dirname(tasksPath), task.repositoryPath);
}

export function parseBenchmarkStrategies(value: string | undefined): BenchmarkStrategy[] {
  if (!value) {
    return [...DEFAULT_BENCHMARK_STRATEGIES];
  }

  return value
    .split(",")
    .map((strategy) => strategy.trim())
    .filter(Boolean)
    .map((strategy) => benchmarkStrategySchema.parse(strategy));
}
