import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BenchmarkStrategy } from "./schema.js";

export interface BenchmarkMetricResult {
  acceptedByHuman?: boolean;
  agentIds: string[];
  changedFiles: string[];
  diffSizeBytes: number;
  error?: string;
  expectedFiles: string[];
  failureModes: string[];
  finalRecommendation?: {
    recommendedAgentIds: string[];
    recommendationType: string;
    summary: string;
  };
  humanNotes?: string;
  implementationDurationMs: number;
  repositoryPath: string;
  reviewDurationMs: number;
  reviewFindingCount: number;
  runId: string;
  safetyWarnings: string[];
  sessionId?: string;
  status: "success" | "failed";
  strategy: BenchmarkStrategy;
  taskId: string;
  taskSuccess: boolean;
  testsPassed: boolean;
  testsRun: boolean;
  title: string;
  totalDurationMs: number;
}

export interface BenchmarkSummary {
  averageDiffSizeBytes: number;
  averageTimeCostMs: number;
  collaborationMadeThingsWorse: string[];
  failureModes: Record<string, number>;
  generatedAt: string;
  humanAcceptedCount: number;
  reviewBenefit: string[];
  runId: string;
  singleAgent: BenchmarkSummaryBucket;
  taskCount: number;
  twoAgent: BenchmarkSummaryBucket;
  whereReviewCaughtIssues: string[];
  resultCount: number;
}

export interface BenchmarkSummaryBucket {
  averageDiffSizeBytes: number;
  averageTotalDurationMs: number;
  count: number;
  successRate: number;
}

export interface SavedBenchmarkOutputs {
  resultsJsonlPath: string;
  summaryJsonPath: string;
  summaryMarkdownPath: string;
  tableCsvPath: string;
}

const SINGLE_AGENT_STRATEGIES = new Set<BenchmarkStrategy>(["codex_only", "claude_only"]);

export async function writeBenchmarkOutputs(options: {
  outputDir: string;
  results: readonly BenchmarkMetricResult[];
  runId: string;
}): Promise<SavedBenchmarkOutputs> {
  await mkdir(options.outputDir, { recursive: true });

  const resultsJsonlPath = path.join(options.outputDir, "results.jsonl");
  const summaryJsonPath = path.join(options.outputDir, "summary.json");
  const summaryMarkdownPath = path.join(options.outputDir, "summary.md");
  const tableCsvPath = path.join(options.outputDir, "table.csv");
  const summary = summarizeBenchmarkResults(options.runId, options.results);

  await writeFile(
    resultsJsonlPath,
    options.results.map((result) => JSON.stringify(result)).join("\n") + "\n",
    "utf8"
  );
  await writeFile(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(summaryMarkdownPath, renderBenchmarkSummaryMarkdown(summary, options.results), "utf8");
  await writeFile(tableCsvPath, renderBenchmarkCsv(options.results), "utf8");

  return {
    resultsJsonlPath,
    summaryJsonPath,
    summaryMarkdownPath,
    tableCsvPath
  };
}

export async function readBenchmarkResults(resultsJsonlPath: string): Promise<BenchmarkMetricResult[]> {
  const source = await readFile(resultsJsonlPath, "utf8");

  return source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BenchmarkMetricResult);
}

export function summarizeBenchmarkResults(
  runId: string,
  results: readonly BenchmarkMetricResult[]
): BenchmarkSummary {
  const singleAgentResults = results.filter((result) => SINGLE_AGENT_STRATEGIES.has(result.strategy));
  const twoAgentResults = results.filter((result) => !SINGLE_AGENT_STRATEGIES.has(result.strategy));
  const failureModes: Record<string, number> = {};

  for (const result of results) {
    for (const mode of result.failureModes) {
      failureModes[mode] = (failureModes[mode] ?? 0) + 1;
    }
  }

  return {
    averageDiffSizeBytes: average(results.map((result) => result.diffSizeBytes)),
    averageTimeCostMs: average(results.map((result) => result.totalDurationMs)),
    collaborationMadeThingsWorse: findCollaborationRegressions(results),
    failureModes,
    generatedAt: new Date().toISOString(),
    humanAcceptedCount: results.filter((result) => result.acceptedByHuman === true).length,
    reviewBenefit: summarizeReviewBenefit(results),
    runId,
    singleAgent: summarizeBucket(singleAgentResults),
    taskCount: new Set(results.map((result) => result.taskId)).size,
    twoAgent: summarizeBucket(twoAgentResults),
    whereReviewCaughtIssues: results
      .filter((result) => isReviewStrategy(result.strategy) && result.reviewFindingCount > 0)
      .map((result) => `${result.taskId}/${result.strategy}: ${result.reviewFindingCount} finding(s)`),
    resultCount: results.length
  };
}

export function renderBenchmarkSummaryMarkdown(
  summary: BenchmarkSummary,
  results: readonly BenchmarkMetricResult[]
): string {
  const lines = [
    "# CodeCouncil Benchmark Summary",
    "",
    `Run: ${summary.runId}`,
    `Generated: ${summary.generatedAt}`,
    `Tasks: ${summary.taskCount}`,
    `Results: ${summary.resultCount}`,
    "",
    "## Single-Agent vs Two-Agent Workflows",
    "",
    "| Group | Count | Success Rate | Avg Time | Avg Diff |",
    "| --- | ---: | ---: | ---: | ---: |",
    `| Single-agent | ${summary.singleAgent.count} | ${formatPercent(summary.singleAgent.successRate)} | ${formatDuration(summary.singleAgent.averageTotalDurationMs)} | ${formatBytes(summary.singleAgent.averageDiffSizeBytes)} |`,
    `| Two-agent | ${summary.twoAgent.count} | ${formatPercent(summary.twoAgent.successRate)} | ${formatDuration(summary.twoAgent.averageTotalDurationMs)} | ${formatBytes(summary.twoAgent.averageDiffSizeBytes)} |`,
    "",
    "## Review Benefit",
    "",
    ...renderList(summary.reviewBenefit),
    "## Failure Modes",
    "",
    ...renderFailureModes(summary.failureModes),
    "## Cases Where Review Caught Issues",
    "",
    ...renderList(summary.whereReviewCaughtIssues),
    "## Cases Where Collaboration Made Things Worse",
    "",
    ...renderList(summary.collaborationMadeThingsWorse),
    "## Results",
    "",
    "| Task | Strategy | Success | Tests | Findings | Safety Warnings | Recommendation |",
    "| --- | --- | --- | --- | ---: | ---: | --- |",
    ...results.map(
      (result) =>
        `| ${result.taskId} | ${result.strategy} | ${result.taskSuccess ? "yes" : "no"} | ${formatTestCell(result)} | ${result.reviewFindingCount} | ${result.safetyWarnings.length} | ${result.finalRecommendation?.recommendationType ?? "n/a"} |`
    ),
    ""
  ];

  return `${lines.join("\n")}\n`;
}

export function renderBenchmarkCsv(results: readonly BenchmarkMetricResult[]): string {
  const header = [
    "runId",
    "taskId",
    "strategy",
    "sessionId",
    "taskSuccess",
    "testsPassed",
    "testsRun",
    "totalDurationMs",
    "implementationDurationMs",
    "reviewDurationMs",
    "changedFileCount",
    "diffSizeBytes",
    "reviewFindingCount",
    "safetyWarningCount",
    "finalRecommendationType",
    "recommendedAgents",
    "acceptedByHuman"
  ];
  const rows = results.map((result) => [
    result.runId,
    result.taskId,
    result.strategy,
    result.sessionId ?? "",
    String(result.taskSuccess),
    String(result.testsPassed),
    String(result.testsRun),
    String(result.totalDurationMs),
    String(result.implementationDurationMs),
    String(result.reviewDurationMs),
    String(result.changedFiles.length),
    String(result.diffSizeBytes),
    String(result.reviewFindingCount),
    String(result.safetyWarnings.length),
    result.finalRecommendation?.recommendationType ?? "",
    result.finalRecommendation?.recommendedAgentIds.join(";") ?? "",
    result.acceptedByHuman === undefined ? "" : String(result.acceptedByHuman)
  ]);

  return `${[header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

function summarizeBucket(results: readonly BenchmarkMetricResult[]): BenchmarkSummaryBucket {
  return {
    averageDiffSizeBytes: average(results.map((result) => result.diffSizeBytes)),
    averageTotalDurationMs: average(results.map((result) => result.totalDurationMs)),
    count: results.length,
    successRate:
      results.length === 0
        ? 0
        : results.filter((result) => result.taskSuccess).length / results.length
  };
}

function summarizeReviewBenefit(results: readonly BenchmarkMetricResult[]): string[] {
  const reviewResults = results.filter((result) => isReviewStrategy(result.strategy));
  const withFindings = reviewResults.filter((result) => result.reviewFindingCount > 0);

  if (reviewResults.length === 0) {
    return ["No review strategies were run."];
  }

  return [
    `${withFindings.length}/${reviewResults.length} review-enabled result(s) produced findings.`,
    `Review strategies succeeded ${formatPercent(
      reviewResults.filter((result) => result.taskSuccess).length / reviewResults.length
    )} of the time.`,
    `Average review duration was ${formatDuration(
      average(reviewResults.map((result) => result.reviewDurationMs))
    )}.`
  ];
}

function findCollaborationRegressions(results: readonly BenchmarkMetricResult[]): string[] {
  const regressions = [];
  const taskIds = [...new Set(results.map((result) => result.taskId))];

  for (const taskId of taskIds) {
    const taskResults = results.filter((result) => result.taskId === taskId);
    const singleSucceeded = taskResults.some(
      (result) => SINGLE_AGENT_STRATEGIES.has(result.strategy) && result.taskSuccess
    );
    const worseCollaborative = taskResults.filter(
      (result) => !SINGLE_AGENT_STRATEGIES.has(result.strategy) && !result.taskSuccess
    );

    if (singleSucceeded && worseCollaborative.length > 0) {
      regressions.push(
        `${taskId}: ${worseCollaborative.map((result) => result.strategy).join(", ")} failed while a single-agent strategy succeeded.`
      );
    }
  }

  return regressions;
}

function isReviewStrategy(strategy: BenchmarkStrategy): boolean {
  return strategy.includes("review");
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function renderFailureModes(failureModes: Record<string, number>): string[] {
  const entries = Object.entries(failureModes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  if (entries.length === 0) {
    return ["- None observed."];
  }

  return entries.map(([mode, count]) => `- ${mode}: ${count}`);
}

function renderList(items: readonly string[]): string[] {
  if (items.length === 0) {
    return ["- None observed."];
  }

  return items.map((item) => `- ${item}`);
}

function formatTestCell(result: BenchmarkMetricResult): string {
  if (!result.testsRun) {
    return "not run";
  }

  return result.testsPassed ? "passed" : "failed";
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  return `${(value / 1024).toFixed(1)} KiB`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function csvEscape(value: string): string {
  if (!/[",\n\r]/u.test(value)) {
    return value;
  }

  return `"${value.replace(/"/gu, "\"\"")}"`;
}
