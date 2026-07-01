import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PlanOutput, ReviewOutput } from "../agents/index.js";
import type { AgentId } from "../config/schema.js";
import { isErrnoException } from "../core/errors.js";
import type { TargetReviewAggregate } from "../review/index.js";
import type { ImplementationScore } from "../scoring/index.js";
import {
  loadApprovedPlan,
  loadApprovedPlanMarkdown,
  type ApprovedPlan,
  type TaskSession
} from "../session/index.js";
import type { AgentTestSummary } from "../testing/index.js";

export type RecommendationType =
  | "recommend_agent_solution"
  | "recommend_manual_review"
  | "recommend_no_solution"
  | "recommend_combine_solutions"
  | "recommend_rerun_with_more_context";

export interface ImplementationArtifact {
  agentId: AgentId;
  changedFiles: string[];
  diffPath: string;
  diffSizeBytes: number;
  safety: {
    blockedFiles: string[];
    ignoredFiles: string[];
    suspiciousFiles: string[];
    warnings: string[];
  };
  status: "success" | "failed" | "blocked";
  summary: string;
  worktreePath: string;
  branchName?: string;
}

export interface AgentReportSummary {
  agentId: AgentId;
  blockingReviewIssues: number;
  changedFiles: string[];
  diffPath?: string;
  diffSizeBytes: number;
  implementationStatus: "missing" | "success" | "failed" | "blocked";
  reviewApprovals: number;
  reviewConfidence: number | undefined;
  reviewRejections: number;
  reviewRequestChanges: number;
  safetyWarnings: string[];
  score: number | undefined;
  securityConcerns: number;
  testsPassed: boolean;
  testsRun: boolean;
  worktreePath?: string;
  branchName?: string;
}

export interface FinalRecommendation {
  createdAt: string;
  recommendedAgentIds: AgentId[];
  recommendedAgentId?: AgentId;
  reasons: string[];
  recommendationType: RecommendationType;
  risks: string[];
  summary: string;
}

export interface FinalReportData {
  agents: AgentReportSummary[];
  approvedPlan?: ApprovedPlan;
  approvedPlanMarkdown?: string;
  finalRecommendation: FinalRecommendation;
  implementationArtifacts: ImplementationArtifact[];
  plans: PlanOutput[];
  reviews: ReviewOutput[];
  reviewAggregates: TargetReviewAggregate[];
  scores: ImplementationScore[];
  session: TaskSession;
  testSummaries: AgentTestSummary[];
}

export interface SavedFinalReport {
  jsonPath: string;
  markdownPath: string;
  recommendation: FinalRecommendation;
}

export async function buildFinalReportData(session: TaskSession): Promise<FinalReportData> {
  const [
    plans,
    approvedPlan,
    approvedPlanMarkdown,
    implementationArtifacts,
    testSummaries,
    reviews,
    reviewAggregates,
    scores
  ] = await Promise.all([
    loadPlans(session),
    loadOptionalApprovedPlan(session),
    loadOptionalApprovedPlanMarkdown(session),
    loadImplementationArtifacts(session),
    loadTestSummaries(session),
    loadReviews(session),
    loadReviewAggregates(session),
    loadScores(session)
  ]);
  const agents = buildAgentSummaries({
    implementationArtifacts,
    reviewAggregates,
    reviews,
    scores,
    testSummaries
  });
  const finalRecommendation = recommendSolution(agents);

  return {
    agents,
    ...(approvedPlan ? { approvedPlan } : {}),
    ...(approvedPlanMarkdown ? { approvedPlanMarkdown } : {}),
    finalRecommendation,
    implementationArtifacts,
    plans,
    reviewAggregates,
    reviews,
    scores,
    session,
    testSummaries
  };
}

export async function saveFinalReport(data: FinalReportData): Promise<SavedFinalReport> {
  await mkdir(data.session.paths.reportsDir, { recursive: true });

  const markdownPath = path.join(data.session.paths.reportsDir, "final-report.md");
  const jsonPath = path.join(data.session.paths.reportsDir, "final-recommendation.json");

  await writeFile(markdownPath, renderFinalReportMarkdown(data), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        agents: data.agents,
        createdAt: data.finalRecommendation.createdAt,
        finalRecommendation: data.finalRecommendation,
        sessionId: data.session.id
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return {
    jsonPath,
    markdownPath,
    recommendation: data.finalRecommendation
  };
}

export function recommendSolution(agents: readonly AgentReportSummary[]): FinalRecommendation {
  const createdAt = new Date().toISOString();

  if (agents.length === 0) {
    return {
      createdAt,
      recommendedAgentIds: [],
      recommendationType: "recommend_no_solution",
      reasons: ["No implementation artifacts were found for this session."],
      risks: ["Run implementation before asking for a final recommendation."],
      summary: "No agent solution is available to recommend."
    };
  }

  const implemented = agents.filter((agent) => agent.implementationStatus === "success");

  if (implemented.length === 0) {
    return {
      createdAt,
      recommendedAgentIds: [],
      recommendationType: "recommend_no_solution",
      reasons: ["No agent implementation completed successfully."],
      risks: agents.flatMap((agent) => agent.safetyWarnings),
      summary: "No successful implementation is available."
    };
  }

  const criticalSafetyAgents = implemented.filter(
    (agent) => agent.safetyWarnings.length > 0 || agent.securityConcerns > 0
  );

  if (criticalSafetyAgents.length === implemented.length) {
    return {
      createdAt,
      recommendedAgentIds: [],
      recommendationType: "recommend_no_solution",
      reasons: ["Every successful implementation has safety warnings or security review concerns."],
      risks: criticalSafetyAgents.flatMap((agent) => [
        ...agent.safetyWarnings,
        ...(agent.securityConcerns > 0
          ? [`${agent.agentId} has ${agent.securityConcerns} security review concern(s).`]
          : [])
      ]),
      summary: "No implementation is safe enough to recommend."
    };
  }

  const safeImplemented = implemented.filter(
    (agent) => agent.safetyWarnings.length === 0 && agent.securityConcerns === 0
  );
  const testsRun = safeImplemented.some((agent) => agent.testsRun);

  if (!testsRun) {
    return {
      createdAt,
      recommendedAgentIds: safeImplemented.map((agent) => agent.agentId),
      recommendationType: "recommend_rerun_with_more_context",
      reasons: ["No safe implementation has test results yet."],
      risks: ["Run `codecouncil test` before choosing a branch to apply."],
      summary: "Run tests before making a final implementation choice."
    };
  }

  const passing = safeImplemented.filter((agent) => agent.testsRun && agent.testsPassed);

  if (passing.length === 0) {
    return {
      createdAt,
      recommendedAgentIds: safeImplemented.map((agent) => agent.agentId),
      recommendationType: "recommend_manual_review",
      reasons: ["No safe implementation passed tests."],
      risks: ["Inspect failing test logs before applying any branch."],
      summary: "Manual review is needed because tests did not pass."
    };
  }

  const withoutBlockingReviews = passing.filter((agent) => agent.blockingReviewIssues === 0);

  if (withoutBlockingReviews.length === 0) {
    return {
      createdAt,
      recommendedAgentIds: passing.map((agent) => agent.agentId),
      recommendationType: "recommend_manual_review",
      reasons: ["All test-passing implementations have blocking review issues."],
      risks: ["Resolve blocking review issues before applying a branch."],
      summary: "Manual review is required before choosing an implementation."
    };
  }

  const sorted = [...withoutBlockingReviews].sort(compareAgentsForRecommendation);
  const best = sorted[0];
  const second = sorted[1];

  if (!best) {
    return {
      createdAt,
      recommendedAgentIds: [],
      recommendationType: "recommend_manual_review",
      reasons: ["CodeCouncil could not identify a clear best candidate."],
      risks: ["Inspect worktrees manually."],
      summary: "Manual review is required."
    };
  }

  if (second && shouldCombine(best, second)) {
    return {
      createdAt,
      recommendedAgentIds: [best.agentId, second.agentId],
      recommendationType: "recommend_combine_solutions",
      reasons: [
        `${best.agentId} and ${second.agentId} both passed tests and have close scores.`,
        "Their changed file sets differ enough that combining ideas may be useful."
      ],
      risks: ["Combining solutions must be done manually and re-tested."],
      summary: `Consider combining ${best.agentId} and ${second.agentId} after manual inspection.`
    };
  }

  return {
    createdAt,
    recommendedAgentId: best.agentId,
    recommendedAgentIds: [best.agentId],
    recommendationType: "recommend_agent_solution",
    reasons: [
      `${best.agentId} passed tests.`,
      "No critical safety warnings were reported.",
      `${best.agentId} has ${best.blockingReviewIssues} blocking review issue(s) and ${best.securityConcerns} security concern(s).`,
      `Score: ${best.score ?? "not available"}.`
    ],
    risks: best.reviewRequestChanges > 0
      ? [`${best.agentId} still has ${best.reviewRequestChanges} request-change review(s).`]
      : [],
    summary: `Inspect ${best.agentId}'s worktree first.`
  };
}

export function renderFinalReportMarkdown(data: FinalReportData): string {
  const lines = [
    "# CodeCouncil Final Report",
    "",
    `Session: ${data.session.id}`,
    `Project: ${data.session.projectName}`,
    `Created: ${data.finalRecommendation.createdAt}`,
    "",
    "## Task Summary",
    "",
    data.session.task,
    "",
    "## Agents Used",
    "",
    ...(data.agents.length > 0 ? data.agents.map((agent) => `- ${agent.agentId}`) : ["- None"]),
    "",
    "## Approved Plan",
    "",
    data.approvedPlanMarkdown?.trim() || data.approvedPlan?.summary || "No approved plan artifact was found.",
    "",
    "## Implementation Summary",
    "",
    "| Agent | Status | Score | Tests | Reviews | Diff Size | Worktree |",
    "| --- | --- | ---: | --- | --- | ---: | --- |",
    ...data.agents.map(
      (agent) =>
        `| ${agent.agentId} | ${agent.implementationStatus} | ${agent.score ?? "n/a"} | ${formatTestStatus(agent)} | ${formatReviewStatus(agent)} | ${formatBytes(agent.diffSizeBytes)} | ${agent.worktreePath ?? "n/a"} |`
    ),
    "",
    "## Changed Files",
    "",
    ...data.agents.flatMap((agent) => [
      `### ${agent.agentId}`,
      "",
      ...(agent.changedFiles.length > 0 ? agent.changedFiles.map((file) => `- ${file}`) : ["- None"]),
      ""
    ]),
    "## Test Results",
    "",
    ...renderTestResults(data),
    "## Review Results",
    "",
    ...renderReviewResults(data),
    "## Safety Warnings",
    "",
    ...renderSafetyWarnings(data),
    "## Score Table",
    "",
    "| Agent | Score | Tests Passed | Blocking Reviews | Security Concerns | Changed Files |",
    "| --- | ---: | --- | ---: | ---: | ---: |",
    ...data.agents.map(
      (agent) =>
        `| ${agent.agentId} | ${agent.score ?? "n/a"} | ${agent.testsPassed ? "yes" : "no"} | ${agent.blockingReviewIssues} | ${agent.securityConcerns} | ${agent.changedFiles.length} |`
    ),
    "",
    "## Final Recommendation",
    "",
    `Type: ${data.finalRecommendation.recommendationType}`,
    "",
    data.finalRecommendation.summary,
    "",
    "## Why This Was Recommended",
    "",
    ...renderListItems(data.finalRecommendation.reasons),
    "## Commands To Inspect Worktrees",
    "",
    ...renderInspectCommands(data),
    "## Manual Apply Or Merge Commands",
    "",
    ...renderManualApplyCommands(data),
    "## Known Limitations",
    "",
    ...renderListItems([
      "CodeCouncil does not merge, cherry-pick, push, or delete worktrees automatically.",
      "Scores are heuristics for prioritizing manual inspection, not proof of correctness.",
      "Large diffs may have received high-level review context instead of full patch review.",
      "Real agent output parsing is best-effort when an adapter does not return structured JSON."
    ])
  ];

  return `${lines.join("\n")}\n`;
}

function buildAgentSummaries(input: {
  implementationArtifacts: readonly ImplementationArtifact[];
  reviewAggregates: readonly TargetReviewAggregate[];
  reviews: readonly ReviewOutput[];
  scores: readonly ImplementationScore[];
  testSummaries: readonly AgentTestSummary[];
}): AgentReportSummary[] {
  const ids = new Set<AgentId>([
    ...input.implementationArtifacts.map((artifact) => artifact.agentId),
    ...input.scores.map((score) => score.agentId),
    ...input.testSummaries.map((summary) => summary.agentId),
    ...input.reviewAggregates.map((aggregate) => aggregate.targetAgentId)
  ]);

  return [...ids].sort().map((agentId) => {
    const implementation = input.implementationArtifacts.find((artifact) => artifact.agentId === agentId);
    const score = input.scores.find((candidate) => candidate.agentId === agentId);
    const tests = input.testSummaries.find((summary) => summary.agentId === agentId);
    const aggregate = input.reviewAggregates.find((candidate) => candidate.targetAgentId === agentId);
    const targetReviews = input.reviews.filter((review) => review.targetAgentId === agentId);
    const confidenceValues = targetReviews
      .map((review) => review.confidence)
      .filter((confidence) => Number.isFinite(confidence));

    return {
      agentId,
      blockingReviewIssues: aggregate?.blockingIssueCount ?? 0,
      changedFiles: implementation?.changedFiles ?? [],
      ...(implementation?.diffPath ? { diffPath: implementation.diffPath } : {}),
      diffSizeBytes: implementation?.diffSizeBytes ?? score?.diffSizeBytes ?? 0,
      implementationStatus: implementation?.status ?? "missing",
      reviewApprovals: aggregate?.approvals ?? 0,
      reviewConfidence:
        confidenceValues.length > 0
          ? confidenceValues.reduce((total, value) => total + value, 0) / confidenceValues.length
          : undefined,
      reviewRejections: aggregate?.rejectionCount ?? 0,
      reviewRequestChanges: aggregate?.requestChangesCount ?? 0,
      safetyWarnings: [
        ...(implementation?.safety.warnings ?? []),
        ...(implementation?.safety.blockedFiles.map((file) => `Blocked file: ${file}`) ?? []),
        ...(implementation?.safety.suspiciousFiles.map((file) => `Suspicious file: ${file}`) ?? [])
      ],
      score: score?.score,
      securityConcerns: aggregate?.securityConcernCount ?? 0,
      testsPassed: tests?.testsPassed ?? score?.testsPassed ?? false,
      testsRun: tests ? tests.commands.length > 0 : score?.testsRun ?? false,
      ...(implementation?.worktreePath ? { worktreePath: implementation.worktreePath } : {}),
      ...(implementation?.branchName ? { branchName: implementation.branchName } : {})
    };
  });
}

async function loadPlans(session: TaskSession): Promise<PlanOutput[]> {
  const entries = await readJsonFiles(session.paths.plansDir);
  return entries
    .filter((entry) => !entry.fileName.startsWith("comparison"))
    .map((entry) => entry.value)
    .filter(isPlanOutput)
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

async function loadImplementationArtifacts(session: TaskSession): Promise<ImplementationArtifact[]> {
  let entries;

  try {
    entries = await readdir(path.join(session.paths.sessionDir, "runs"), {
      withFileTypes: true
    });
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const artifacts: ImplementationArtifact[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const source = await readOptionalJson(path.join(session.paths.sessionDir, "runs", entry.name, "implementation.json"));

    if (!isRecord(source)) {
      continue;
    }

    const agentId = getString(source, "agentId") || entry.name;
    const diffPath = getString(source, "diffPath") || path.join(session.paths.diffsDir, `${agentId}.patch`);
    const output = isRecord(source["output"]) ? source["output"] : {};
    const safety = isRecord(source["safety"]) ? source["safety"] : {};
    const worktree = isRecord(source["worktree"]) ? source["worktree"] : {};
    const branchName = getString(worktree, "branchName");

    artifacts.push({
      agentId,
      changedFiles: getStringArray(source, "changedFiles"),
      diffPath,
      diffSizeBytes: await getFileSize(diffPath),
      safety: {
        blockedFiles: getStringArray(safety, "blockedFiles"),
        ignoredFiles: getStringArray(safety, "ignoredFiles"),
        suspiciousFiles: getStringArray(safety, "suspiciousFiles"),
        warnings: getStringArray(safety, "warnings")
      },
      status: normalizeImplementationStatus(getString(source, "status")),
      summary: getString(output, "summary") || "No implementation summary was recorded.",
      worktreePath: getString(worktree, "worktreePath") || path.join(session.paths.worktreesDir, agentId),
      ...(branchName ? { branchName } : {})
    });
  }

  return artifacts.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

async function loadTestSummaries(session: TaskSession): Promise<AgentTestSummary[]> {
  const source = await readOptionalJson(path.join(session.paths.testsDir, "summary.json"));

  if (!isRecord(source) || !Array.isArray(source["summaries"])) {
    return [];
  }

  return source["summaries"].filter(isAgentTestSummary);
}

async function loadReviews(session: TaskSession): Promise<ReviewOutput[]> {
  const entries = await readJsonFiles(session.paths.reviewsDir);
  return entries
    .filter((entry) => entry.fileName !== "summary.json")
    .map((entry) => entry.value)
    .filter(isReviewOutput)
    .sort((a, b) =>
      `${a.targetAgentId}:${a.reviewerAgentId}`.localeCompare(`${b.targetAgentId}:${b.reviewerAgentId}`)
    );
}

async function loadReviewAggregates(session: TaskSession): Promise<TargetReviewAggregate[]> {
  const source = await readOptionalJson(path.join(session.paths.reviewsDir, "summary.json"));

  if (!isRecord(source) || !Array.isArray(source["aggregates"])) {
    return [];
  }

  return source["aggregates"].filter(isTargetReviewAggregate);
}

async function loadScores(session: TaskSession): Promise<ImplementationScore[]> {
  const source = await readOptionalJson(path.join(session.paths.sessionDir, "scores", "implementation-scores.json"));

  if (!isRecord(source) || !Array.isArray(source["scores"])) {
    return [];
  }

  return source["scores"].filter(isImplementationScore);
}

async function loadOptionalApprovedPlan(session: TaskSession): Promise<ApprovedPlan | undefined> {
  try {
    return await loadApprovedPlan(session);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function loadOptionalApprovedPlanMarkdown(session: TaskSession): Promise<string | undefined> {
  try {
    return await loadApprovedPlanMarkdown(session);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function readJsonFiles(directoryPath: string): Promise<Array<{ fileName: string; value: unknown }>> {
  let entries;

  try {
    entries = await readdir(directoryPath, {
      withFileTypes: true
    });
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const values = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const value = await readOptionalJson(path.join(directoryPath, entry.name));

    if (value !== undefined) {
      values.push({
        fileName: entry.name,
        value
      });
    }
  }

  return values;
}

async function readOptionalJson(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function getFileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return 0;
    }

    throw error;
  }
}

function compareAgentsForRecommendation(a: AgentReportSummary, b: AgentReportSummary): number {
  return (
    Number(b.testsPassed) - Number(a.testsPassed) ||
    a.securityConcerns - b.securityConcerns ||
    a.blockingReviewIssues - b.blockingReviewIssues ||
    (b.score ?? -1) - (a.score ?? -1) ||
    a.diffSizeBytes - b.diffSizeBytes ||
    b.reviewApprovals - a.reviewApprovals ||
    (b.reviewConfidence ?? 0) - (a.reviewConfidence ?? 0) ||
    a.agentId.localeCompare(b.agentId)
  );
}

function shouldCombine(best: AgentReportSummary, second: AgentReportSummary): boolean {
  const scoreDelta = Math.abs((best.score ?? 0) - (second.score ?? 0));
  const bothClean =
    best.blockingReviewIssues === 0 &&
    second.blockingReviewIssues === 0 &&
    best.securityConcerns === 0 &&
    second.securityConcerns === 0;
  const fileSetsDiffer = normalizeFileSet(best.changedFiles) !== normalizeFileSet(second.changedFiles);

  return scoreDelta <= 5 && bothClean && fileSetsDiffer;
}

function normalizeFileSet(files: readonly string[]): string {
  return [...files].sort().join("\n");
}

function renderTestResults(data: FinalReportData): string[] {
  if (data.testSummaries.length === 0) {
    return ["No test results were found.", ""];
  }

  return data.testSummaries.flatMap((summary) => [
    `### ${summary.agentId}`,
    "",
    `Status: ${summary.status}`,
    `Commands: ${summary.commands.length}`,
    ...summary.commands.map((command) => `- \`${command.commandLine}\`: ${command.status}`),
    ""
  ]);
}

function renderReviewResults(data: FinalReportData): string[] {
  if (data.reviewAggregates.length === 0) {
    return ["No review results were found.", ""];
  }

  return data.reviewAggregates.flatMap((aggregate) => [
    `### ${aggregate.targetAgentId}`,
    "",
    `Approvals: ${aggregate.approvals}`,
    `Request changes: ${aggregate.requestChangesCount}`,
    `Rejections: ${aggregate.rejectionCount}`,
    `Blocking issues: ${aggregate.blockingIssueCount}`,
    `Security concerns: ${aggregate.securityConcernCount}`,
    `Missing tests: ${aggregate.missingTestCount}`,
    ""
  ]);
}

function renderSafetyWarnings(data: FinalReportData): string[] {
  const warnings = data.agents.flatMap((agent) =>
    agent.safetyWarnings.map((warning) => `${agent.agentId}: ${warning}`)
  );

  return warnings.length > 0 ? renderListItems(warnings) : ["- None reported.", ""];
}

function renderInspectCommands(data: FinalReportData): string[] {
  const agentsToInspect =
    data.finalRecommendation.recommendedAgentIds.length > 0
      ? data.agents.filter((agent) => data.finalRecommendation.recommendedAgentIds.includes(agent.agentId))
      : data.agents;

  return agentsToInspect.flatMap((agent) => [
    `- Inspect ${agent.agentId}:`,
    `  - \`cd ${agent.worktreePath ?? path.join(data.session.paths.worktreesDir, agent.agentId)}\``,
    `  - \`git status\``,
    `  - \`git diff ${data.session.baseBranch} --\``
  ]);
}

function renderManualApplyCommands(data: FinalReportData): string[] {
  const agentsToApply = data.finalRecommendation.recommendedAgentIds.length > 0
    ? data.agents.filter((agent) => data.finalRecommendation.recommendedAgentIds.includes(agent.agentId))
    : data.agents;

  if (agentsToApply.length === 0) {
    return ["- No implementation branch is available to apply.", ""];
  }

  return agentsToApply.flatMap((agent) => [
    `- Dry-run helper for ${agent.agentId}: \`codecouncil apply --session ${data.session.id} --agent ${agent.agentId} --dry-run\``,
    `- Manual merge after inspection: \`git merge --no-ff ${agent.branchName ?? `<${agent.agentId}-branch>`}\``,
    `- Manual patch apply alternative: \`git apply --check ${agent.diffPath ?? path.join(data.session.paths.diffsDir, `${agent.agentId}.patch`)}\``,
    ""
  ]);
}

function renderListItems(items: readonly string[]): string[] {
  return items.length > 0 ? [...items.map((item) => `- ${item}`), ""] : ["- None.", ""];
}

function formatTestStatus(agent: AgentReportSummary): string {
  if (!agent.testsRun) {
    return "not run";
  }

  return agent.testsPassed ? "passed" : "failed";
}

function formatReviewStatus(agent: AgentReportSummary): string {
  const reviewCount = agent.reviewApprovals + agent.reviewRequestChanges + agent.reviewRejections;

  if (reviewCount === 0) {
    return "not run";
  }

  return `${agent.reviewApprovals}/${reviewCount} approve`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function normalizeImplementationStatus(value: string | undefined): ImplementationArtifact["status"] {
  if (value === "success" || value === "failed" || value === "blocked") {
    return value;
  }

  return "failed";
}

function isPlanOutput(value: unknown): value is PlanOutput {
  return isRecord(value) && typeof value["agentId"] === "string" && typeof value["summary"] === "string";
}

function isAgentTestSummary(value: unknown): value is AgentTestSummary {
  return isRecord(value) && typeof value["agentId"] === "string" && Array.isArray(value["commands"]);
}

function isReviewOutput(value: unknown): value is ReviewOutput {
  return isRecord(value) && typeof value["reviewerAgentId"] === "string" && typeof value["targetAgentId"] === "string";
}

function isTargetReviewAggregate(value: unknown): value is TargetReviewAggregate {
  return isRecord(value) && typeof value["targetAgentId"] === "string" && typeof value["reviewCount"] === "number";
}

function isImplementationScore(value: unknown): value is ImplementationScore {
  return isRecord(value) && typeof value["agentId"] === "string" && typeof value["score"] === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function getStringArray(value: Record<string, unknown>, key: string): string[] {
  const raw = value[key];

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter((item): item is string => typeof item === "string");
}
