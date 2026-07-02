import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CodeCouncilConfig } from "../config/schema.js";
import type { AgentReportSummary, FinalReportData } from "../report/index.js";
import { buildFinalReportData } from "../report/index.js";
import { loadConfig } from "../config/loadConfig.js";
import { createDefaultConfig } from "../config/defaults.js";
import { CodeCouncilError, isErrnoException } from "../core/errors.js";
import { formatSessionTimestamp, loadTaskSession } from "../session/index.js";
import type { AgentConfig, AgentId } from "../config/schema.js";
import type { BenchmarkMetricResult } from "./output.js";
import type { BenchmarkStrategy, BenchmarkTask } from "./schema.js";
import { resolveTaskRepositoryPath } from "./schema.js";

interface BenchmarkRoles {
  claude: AgentId;
  codex: AgentId;
}

interface BenchmarkStrategyPlan {
  implement: "approved" | AgentId[];
  plan: AgentId[];
  review?: {
    reviewers: AgentId[];
    targets: AgentId[];
  };
}

export interface BenchmarkRunInput {
  agentIds: readonly AgentId[];
  outputDir: string;
  runId: string;
  strategies: readonly BenchmarkStrategy[];
  tasks: readonly BenchmarkTask[];
  tasksPath: string;
}

interface StageDurations {
  implementationDurationMs: number;
  reviewDurationMs: number;
}

interface CliJsonResult {
  durationMs: number;
  payload: Record<string, unknown>;
  stderr: string;
  stdout: string;
}

interface PlanPayload {
  comparison?: {
    suggestedImplementationAgent?: string;
  };
  sessionId?: string;
}

export async function runBenchmark(input: BenchmarkRunInput): Promise<BenchmarkMetricResult[]> {
  await mkdir(input.outputDir, { recursive: true });
  const roles = resolveBenchmarkRoles(input.agentIds);
  const strategies = input.strategies.filter((strategy) => isStrategyFeasible(strategy, roles));
  const results: BenchmarkMetricResult[] = [];

  if (strategies.length === 0) {
    throw new CodeCouncilError("No benchmark strategies are feasible for the selected agents.", {
      code: "NO_BENCHMARK_STRATEGIES",
      exitCode: 2
    });
  }

  for (const task of input.tasks) {
    for (const strategy of strategies) {
      const result = await runBenchmarkStrategy({
        agentIds: input.agentIds,
        roles,
        runId: input.runId,
        strategy,
        task,
        tasksPath: input.tasksPath
      });
      results.push(result);
    }
  }

  return results;
}

export function requiresRealBenchmarkConfirmation(agentIds: readonly AgentId[]): boolean {
  return agentIds.some((agentId) => !agentId.startsWith("mock-"));
}

function resolveBenchmarkRoles(agentIds: readonly AgentId[]): BenchmarkRoles {
  const codex = agentIds.find((agentId) => /codex/iu.test(agentId));
  const claude = agentIds.find((agentId) => /claude/iu.test(agentId));

  if (!codex || !claude) {
    throw new CodeCouncilError(
      "Benchmark mode needs one Codex-like agent and one Claude-like agent, for example --agents codex,claude or --agents mock-codex,mock-claude.",
      {
        code: "BENCHMARK_AGENTS_REQUIRED",
        exitCode: 2
      }
    );
  }

  return {
    claude,
    codex
  };
}

function isStrategyFeasible(strategy: BenchmarkStrategy, roles: BenchmarkRoles): boolean {
  switch (strategy) {
    case "codex_only":
    case "claude_only":
    case "codex_then_claude_review":
    case "claude_then_codex_review":
    case "both_independent_then_select":
    case "both_plan_then_one_implement":
    case "both_implement_then_review_and_select":
      return Boolean(roles.codex && roles.claude);
  }
}

async function runBenchmarkStrategy(input: {
  agentIds: readonly AgentId[];
  roles: BenchmarkRoles;
  runId: string;
  strategy: BenchmarkStrategy;
  task: BenchmarkTask;
  tasksPath: string;
}): Promise<BenchmarkMetricResult> {
  const started = Date.now();
  const repositoryPath = resolveTaskRepositoryPath(input.task, input.tasksPath);
  const workspaceDir = path.posix.join(
    ".codecouncil",
    "benchmarks",
    input.runId,
    sanitizePathSegment(input.task.id),
    input.strategy
  );
  const plan = buildStrategyPlan(input.strategy, input.roles);
  const benchmarkTaskText = [
    `Benchmark ${input.task.id} (${input.strategy}): ${input.task.title}`,
    "",
    input.task.description,
    input.task.evaluationNotes ? `\nEvaluation notes: ${input.task.evaluationNotes}` : ""
  ].join("\n");
  let generatedConfigPath: string | undefined;
  let sessionId: string | undefined;
  const durations: StageDurations = {
    implementationDurationMs: 0,
    reviewDurationMs: 0
  };

  try {
    generatedConfigPath = await writeGeneratedBenchmarkConfig({
      agentIds: input.agentIds,
      repositoryPath,
      runId: input.runId,
      strategy: input.strategy,
      task: input.task,
      workspaceDir
    });

    const baseArgs = [
      "--cwd",
      repositoryPath,
      "--config",
      generatedConfigPath,
      "--workspace-dir",
      workspaceDir,
      "--json"
    ];
    const planResult = await runInternalCliJson([
      ...baseArgs,
      "plan",
      "--agents",
      plan.plan.join(","),
      benchmarkTaskText
    ]);
    const planPayload = planResult.payload as PlanPayload;
    sessionId = planPayload.sessionId;

    if (!sessionId) {
      throw new CodeCouncilError("Benchmark plan command did not return a session id.", {
        code: "BENCHMARK_SESSION_MISSING"
      });
    }

    const approvedAgentId = resolveApprovedAgent(plan, planPayload);
    await runInternalCliJson([...baseArgs, "approve", "--session", sessionId, "--agent", approvedAgentId]);

    const implementationAgents = plan.implement === "approved" ? [approvedAgentId] : plan.implement;

    if (implementationAgents.length > 0) {
      const implementResult = await runInternalCliJson([
        ...baseArgs,
        "implement",
        "--session",
        sessionId,
        "--agents",
        implementationAgents.join(",")
      ]);
      durations.implementationDurationMs += implementResult.durationMs;

      const testArgs = [
        ...baseArgs,
        "test",
        "--session",
        sessionId,
        "--agents",
        implementationAgents.join(","),
        ...renderTestCommandArgs(input.task.testCommands)
      ];
      await runInternalCliJson(testArgs);
    }

    if (plan.review) {
      const reviewResult = await runInternalCliJson([
        ...baseArgs,
        "review",
        "--session",
        sessionId,
        "--reviewers",
        plan.review.reviewers.join(","),
        "--targets",
        plan.review.targets.join(",")
      ]);
      durations.reviewDurationMs += reviewResult.durationMs;
    }

    await runInternalCliJson([...baseArgs, "report", "--session", sessionId]);
    const session = await loadTaskSession({
      rootDir: repositoryPath,
      sessionId,
      workspaceDir
    });
    const reportData = await buildFinalReportData(session);

    return buildBenchmarkResult({
      agentIds: input.agentIds,
      durations,
      repositoryPath,
      reportData,
      runId: input.runId,
      sessionId,
      started,
      status: "success",
      strategy: input.strategy,
      task: input.task
    });
  } catch (error) {
    return buildFailedBenchmarkResult({
      agentIds: input.agentIds,
      durations,
      error,
      repositoryPath,
      runId: input.runId,
      ...(sessionId ? { sessionId } : {}),
      started,
      strategy: input.strategy,
      task: input.task
    });
  } finally {
    if (generatedConfigPath) {
      await removeGeneratedConfig(generatedConfigPath);
    }
  }
}

function buildStrategyPlan(strategy: BenchmarkStrategy, roles: BenchmarkRoles): BenchmarkStrategyPlan {
  switch (strategy) {
    case "codex_only":
      return {
        implement: [roles.codex],
        plan: [roles.codex]
      };
    case "claude_only":
      return {
        implement: [roles.claude],
        plan: [roles.claude]
      };
    case "codex_then_claude_review":
      return {
        implement: [roles.codex],
        plan: [roles.codex],
        review: {
          reviewers: [roles.claude],
          targets: [roles.codex]
        }
      };
    case "claude_then_codex_review":
      return {
        implement: [roles.claude],
        plan: [roles.claude],
        review: {
          reviewers: [roles.codex],
          targets: [roles.claude]
        }
      };
    case "both_independent_then_select":
      return {
        implement: [roles.codex, roles.claude],
        plan: [roles.codex, roles.claude]
      };
    case "both_plan_then_one_implement":
      return {
        implement: "approved",
        plan: [roles.codex, roles.claude]
      };
    case "both_implement_then_review_and_select":
      return {
        implement: [roles.codex, roles.claude],
        plan: [roles.codex, roles.claude],
        review: {
          reviewers: [roles.codex, roles.claude],
          targets: [roles.codex, roles.claude]
        }
      };
  }
}

function resolveApprovedAgent(plan: BenchmarkStrategyPlan, payload: PlanPayload): AgentId {
  if (plan.implement !== "approved") {
    const firstAgent = plan.implement[0] ?? plan.plan[0];

    if (!firstAgent) {
      throw new CodeCouncilError("Benchmark strategy has no agent to approve.", {
        code: "BENCHMARK_APPROVAL_AGENT_MISSING"
      });
    }

    return firstAgent;
  }

  const suggestedAgent = payload.comparison?.suggestedImplementationAgent;

  if (suggestedAgent && plan.plan.includes(suggestedAgent)) {
    return suggestedAgent;
  }

  const fallbackAgent = plan.plan[0];

  if (!fallbackAgent) {
    throw new CodeCouncilError("Benchmark strategy has no planned agent to approve.", {
      code: "BENCHMARK_APPROVAL_AGENT_MISSING"
    });
  }

  return fallbackAgent;
}

async function writeGeneratedBenchmarkConfig(input: {
  agentIds: readonly AgentId[];
  repositoryPath: string;
  runId: string;
  strategy: BenchmarkStrategy;
  task: BenchmarkTask;
  workspaceDir: string;
}): Promise<string> {
  const loadedConfig = await loadConfig({ cwd: input.repositoryPath });
  const baseConfig = loadedConfig.config;
  const defaultConfig = createDefaultConfig({
    projectName: path.basename(input.repositoryPath)
  });
  const agents = Object.fromEntries(
    input.agentIds.map((agentId) => [
      agentId,
      {
        ...(baseConfig.agents[agentId] ?? defaultConfig.agents[agentId] ?? defaultAgentConfig(agentId)),
        enabled: true
      }
    ])
  );
  const config: CodeCouncilConfig = {
    ...baseConfig,
    agents,
    baseBranch: input.task.baseBranch,
    projectName: baseConfig.projectName || path.basename(input.repositoryPath),
    testCommands: input.task.testCommands ?? baseConfig.testCommands,
    workspaceDir: input.workspaceDir
  };
  const configPath = path.join(
    input.repositoryPath,
    `.codecouncil.benchmark.${sanitizePathSegment(input.runId)}.${sanitizePathSegment(input.task.id)}.${input.strategy}.config.json`
  );

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

function defaultAgentConfig(agentId: AgentId): AgentConfig {
  if (agentId === "codex") {
    return {
      enabled: true,
      command: "codex",
      models: {},
      planArgs: ["exec", "--json"],
      implementArgs: ["exec", "--json", "--sandbox", "workspace-write"],
      reviewArgs: ["exec", "--json"],
      maxRuntimeSeconds: 900
    };
  }

  if (agentId === "claude") {
    return {
      enabled: true,
      command: "claude",
      models: {},
      planArgs: ["-p", "--output-format", "stream-json"],
      implementArgs: ["-p", "--output-format", "stream-json", "--permission-mode", "acceptEdits"],
      reviewArgs: ["-p", "--output-format", "stream-json"],
      maxRuntimeSeconds: 900
    };
  }

  return {
    enabled: true,
    command: agentId,
    models: {},
    planArgs: [],
    implementArgs: [],
    reviewArgs: [],
    maxRuntimeSeconds: 900
  };
}

async function runInternalCliJson(argv: readonly string[]): Promise<CliJsonResult> {
  const { createCli } = await import("../cli.js");
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const started = Date.now();

  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await createCli().parseAsync(["node", "codecouncil", ...argv]);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");

  return {
    durationMs: Date.now() - started,
    payload: JSON.parse(stdout) as Record<string, unknown>,
    stderr,
    stdout
  };
}

function buildBenchmarkResult(input: {
  agentIds: readonly AgentId[];
  durations: StageDurations;
  repositoryPath: string;
  reportData: FinalReportData;
  runId: string;
  sessionId: string;
  started: number;
  status: "success";
  strategy: BenchmarkStrategy;
  task: BenchmarkTask;
}): BenchmarkMetricResult {
  const agents = input.reportData.agents;
  const changedFiles = unique(agents.flatMap((agent) => agent.changedFiles));
  const safetyWarnings = agents.flatMap((agent) => agent.safetyWarnings);
  const testsRun = agents.some((agent) => agent.testsRun);
  const testsPassed = agents.some((agent) => agent.testsRun && agent.testsPassed);
  const taskSuccess =
    testsPassed &&
    input.reportData.finalRecommendation.recommendationType !== "recommend_no_solution" &&
    agents.some((agent) => agent.implementationStatus === "success");

  return {
    agentIds: [...input.agentIds],
    changedFiles,
    diffSizeBytes: agents.reduce((sum, agent) => sum + agent.diffSizeBytes, 0),
    expectedFiles: input.task.expectedFiles ?? [],
    failureModes: inferFailureModes(agents, testsRun, testsPassed, safetyWarnings, input.reportData.finalRecommendation.recommendationType),
    finalRecommendation: {
      recommendedAgentIds: input.reportData.finalRecommendation.recommendedAgentIds,
      recommendationType: input.reportData.finalRecommendation.recommendationType,
      summary: input.reportData.finalRecommendation.summary
    },
    implementationDurationMs: input.durations.implementationDurationMs,
    repositoryPath: input.repositoryPath,
    reviewDurationMs: input.durations.reviewDurationMs,
    reviewFindingCount: countReviewFindings(agents, input.reportData.reviews),
    runId: input.runId,
    safetyWarnings,
    sessionId: input.sessionId,
    status: input.status,
    strategy: input.strategy,
    taskId: input.task.id,
    taskSuccess,
    testsPassed,
    testsRun,
    title: input.task.title,
    totalDurationMs: Date.now() - input.started
  };
}

function buildFailedBenchmarkResult(input: {
  agentIds: readonly AgentId[];
  durations: StageDurations;
  error: unknown;
  repositoryPath: string;
  runId: string;
  sessionId?: string;
  started: number;
  strategy: BenchmarkStrategy;
  task: BenchmarkTask;
}): BenchmarkMetricResult {
  const message = input.error instanceof Error ? input.error.message : "Benchmark strategy failed.";

  return {
    agentIds: [...input.agentIds],
    changedFiles: [],
    diffSizeBytes: 0,
    error: message,
    expectedFiles: input.task.expectedFiles ?? [],
    failureModes: ["command_failed"],
    implementationDurationMs: input.durations.implementationDurationMs,
    repositoryPath: input.repositoryPath,
    reviewDurationMs: input.durations.reviewDurationMs,
    reviewFindingCount: 0,
    runId: input.runId,
    safetyWarnings: [],
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    status: "failed",
    strategy: input.strategy,
    taskId: input.task.id,
    taskSuccess: false,
    testsPassed: false,
    testsRun: false,
    title: input.task.title,
    totalDurationMs: Date.now() - input.started
  };
}

function inferFailureModes(
  agents: readonly AgentReportSummary[],
  testsRun: boolean,
  testsPassed: boolean,
  safetyWarnings: readonly string[],
  recommendationType: string
): string[] {
  const modes = [];

  if (agents.some((agent) => agent.implementationStatus !== "success")) {
    modes.push("implementation_failed");
  }

  if (!testsRun) {
    modes.push("tests_not_run");
  } else if (!testsPassed) {
    modes.push("tests_failed");
  }

  if (safetyWarnings.length > 0) {
    modes.push("safety_warnings");
  }

  if (recommendationType === "recommend_no_solution") {
    modes.push("no_solution");
  }

  return modes;
}

function countReviewFindings(
  agents: readonly AgentReportSummary[],
  reviews: readonly FinalReportData["reviews"][number][]
): number {
  const aggregateCount = agents.reduce(
    (sum, agent) =>
      sum +
      agent.blockingReviewIssues +
      agent.reviewRequestChanges +
      agent.reviewRejections +
      agent.securityConcerns,
    0
  );
  const detailedCount = reviews.reduce(
    (sum, review) =>
      sum +
      review.blockingIssues.length +
      review.nonBlockingIssues.length +
      review.securityConcerns.length +
      review.missingTests.length +
      review.edgeCases.length +
      review.maintainabilityConcerns.length,
    0
  );

  return Math.max(aggregateCount, detailedCount);
}

function renderTestCommandArgs(commands: readonly string[] | undefined): string[] {
  return (commands ?? []).flatMap((command) => ["--command", command]);
}

async function removeGeneratedConfig(configPath: string): Promise<void> {
  try {
    await unlink(configPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return;
    }

    throw error;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sanitizePathSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64) || "benchmark";
}

export function createBenchmarkRunId(now = new Date()): string {
  return formatSessionTimestamp(now);
}
