import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";

import { AgentRegistry, type CodeCouncilAgent, type ReviewOutput, reviewOutputSchema } from "../agents/index.js";
import type { AgentId, CodeCouncilConfig } from "../config/schema.js";
import { CodeCouncilError, isErrnoException } from "../core/errors.js";
import { resolveSelectedAgents, type SelectedAgentConfig } from "../core/agentSelection.js";
import {
  aggregateReviews,
  createReviewPairs,
  saveReviewArtifacts,
  saveReviewSummary,
  type ReviewPair,
  type TargetReviewAggregate
} from "../review/index.js";
import {
  calculateImplementationScore,
  saveImplementationScores,
  type ImplementationScore
} from "../scoring/index.js";
import {
  appendSessionEvent,
  loadApprovedPlanMarkdown,
  loadTaskSession,
  type TaskSession
} from "../session/index.js";
import { writeResult } from "./context.js";
import {
  collectRepeatableOption,
  formatConfigSource,
  loadRuntimeContext,
  relativeToCwd
} from "./shared.js";

interface ReviewOptions {
  reviewer?: string[];
  reviewers?: string;
  selfReview?: boolean;
  session?: string;
  target?: string[];
  targets?: string;
}

interface ImplementationMetadata {
  changedFiles: string[];
  diffPath: string;
  implementationSucceeded: boolean;
  safety: {
    blockedFiles: string[];
    ignoredFiles: string[];
    suspiciousFiles: string[];
    warnings: string[];
  };
}

interface TestMetadata {
  testsPassed: boolean;
  testsRun: boolean;
}

interface TargetReviewContext {
  approvedPlanMarkdown?: string;
  changedFiles: string[];
  diff: string;
  diffMode: "full" | "summary";
  diffPath: string;
  diffSizeBytes: number;
  implementation: ImplementationMetadata;
  safetyWarnings: string[];
  targetAgentId: AgentId;
  targetDisplayName: string;
  testSummary?: string;
  tests: TestMetadata;
}

interface ReviewCliSummary {
  blockingIssues: number;
  jsonPath: string;
  reviewerAgentId: AgentId;
  reviewScoreImpact: number;
  securityConcerns: number;
  targetAgentId: AgentId;
  verdict: ReviewOutput["verdict"];
}

export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description("Run cross-agent reviews for implementation diffs.")
    .option("--reviewer <agent>", "reviewer agent id; repeat for multiple reviewers", collectRepeatableOption)
    .option("--reviewers <agents>", "comma-separated reviewer agent ids")
    .option("--target <agent>", "target agent id; repeat for multiple targets", collectRepeatableOption)
    .option("--targets <agents>", "comma-separated target agent ids")
    .option("--session <id>", "session id containing implementation diffs")
    .option("--self-review", "allow an agent to review its own diff")
    .action(async (options: ReviewOptions, command: Command) => {
      const runtime = await loadRuntimeContext(command);

      if (!options.session) {
        throw new CodeCouncilError("Review requires --session so CodeCouncil can find implementation diffs.", {
          code: "MISSING_SESSION",
          exitCode: 2
        });
      }

      const session = await loadTaskSession({
        rootDir: runtime.loadedConfig.rootDir,
        sessionId: options.session,
        workspaceDir: runtime.loadedConfig.config.workspaceDir
      });
      const registry = AgentRegistry.fromConfig(runtime.loadedConfig.config);
      const reviewerAgents = selectAgents(runtime.loadedConfig.config, [
        ...(options.reviewer ?? []),
        ...parseAgentsOption(options.reviewers)
      ]);
      const targetAgents = selectAgents(runtime.loadedConfig.config, [
        ...(options.target ?? []),
        ...parseAgentsOption(options.targets)
      ]);
      const pairs = createReviewPairs({
        reviewers: reviewerAgents.map((agent) => agent.id),
        selfReview: options.selfReview === true,
        targets: targetAgents.map((agent) => agent.id)
      });

      if (pairs.length === 0) {
        throw new CodeCouncilError("No review pairs were created. Pass --self-review to allow self-review.", {
          code: "NO_REVIEW_PAIRS",
          exitCode: 2
        });
      }

      const approvedPlanMarkdown = await loadOptionalApprovedPlanMarkdown(session);
      const targetContexts = new Map<AgentId, TargetReviewContext>();

      for (const target of targetAgents) {
        targetContexts.set(
          target.id,
          await buildTargetReviewContext({
            ...(approvedPlanMarkdown ? { approvedPlanMarkdown } : {}),
            config: runtime.loadedConfig.config,
            session,
            target,
            rootDir: runtime.loadedConfig.rootDir
          })
        );
      }

      await appendSessionEvent(session, {
        type: "reviews.started",
        status: "running",
        message: "Started cross-agent review phase.",
        metadata: {
          pairs,
          selfReview: options.selfReview === true
        }
      });

      const reviews: ReviewOutput[] = [];
      const cliSummaries: ReviewCliSummary[] = [];

      for (const pair of pairs) {
        const reviewer = registry.get(pair.reviewerAgentId);
        const targetContext = targetContexts.get(pair.targetAgentId);

        if (!targetContext) {
          throw new CodeCouncilError(`Missing review context for target "${pair.targetAgentId}".`, {
            code: "REVIEW_TARGET_CONTEXT_MISSING",
            exitCode: 2
          });
        }

        const review = await runReviewPair({
          config: runtime.loadedConfig.config,
          pair,
          repoRoot: runtime.loadedConfig.rootDir,
          reviewer,
          session,
          targetContext
        });
        const artifacts = await saveReviewArtifacts({
          review,
          session
        });

        reviews.push(review);
        cliSummaries.push({
          blockingIssues: review.blockingIssues.length,
          jsonPath: artifacts.jsonPath,
          reviewerAgentId: review.reviewerAgentId,
          reviewScoreImpact: 0,
          securityConcerns: review.securityConcerns.length,
          targetAgentId: review.targetAgentId,
          verdict: review.verdict
        });
      }

      const aggregates = aggregateReviews(reviews);
      const aggregateByTarget = new Map(aggregates.map((aggregate) => [aggregate.targetAgentId, aggregate]));
      const savedReviewSummary = await saveReviewSummary({
        aggregates,
        reviews,
        session
      });
      const scores = await calculateReviewAwareScores({
        aggregateByTarget,
        session,
        targets: targetContexts
      });
      const savedScores = await saveImplementationScores({
        scores,
        session
      });

      for (const summary of cliSummaries) {
        const score = scores.find((candidate) => candidate.agentId === summary.targetAgentId);
        const reviewComponent = score?.components.find((component) => component.name === "Reviews");
        summary.reviewScoreImpact = (reviewComponent?.points ?? 15) - 15;
      }

      await appendSessionEvent(session, {
        type: "reviews.completed",
        status: "success",
        message: "Completed cross-agent review phase.",
        metadata: {
          reviewSummaryPath: savedReviewSummary.jsonPath,
          scoresPath: savedScores.jsonPath
        }
      });

      writeResult(
        runtime.commandContext,
        {
          command: "review",
          config: formatConfigSource(runtime.loadedConfig),
          pairs,
          reviewSummaryPath: savedReviewSummary.jsonPath,
          scores,
          scoresPath: savedScores.jsonPath,
          sessionId: session.id,
          status: "success",
          summaries: cliSummaries
        },
        [
          "Review phase complete.",
          `Session: ${session.id}`,
          "",
          ...renderCliTable(cliSummaries),
          "",
          `Review summary: ${relativeToCwd(runtime.commandContext, savedReviewSummary.markdownPath)}`,
          `Scores: ${relativeToCwd(runtime.commandContext, savedScores.markdownPath)}`
        ]
      );
    });
}

async function runReviewPair(options: {
  config: CodeCouncilConfig;
  pair: ReviewPair;
  repoRoot: string;
  reviewer: CodeCouncilAgent;
  session: TaskSession;
  targetContext: TargetReviewContext;
}): Promise<ReviewOutput> {
  await appendSessionEvent(options.session, {
    type: "agent.review.started",
    agentId: options.pair.reviewerAgentId,
    status: "running",
    message: `${options.pair.reviewerAgentId} started reviewing ${options.pair.targetAgentId}.`,
    metadata: {
      targetAgentId: options.pair.targetAgentId
    }
  });

  const availability = await options.reviewer.checkAvailability();

  if (!availability.available) {
    throw new CodeCouncilError(
      `Reviewer "${options.reviewer.id}" is not available: ${availability.reason ?? "unknown reason"}`,
      {
        code: "AGENT_NOT_AVAILABLE",
        exitCode: 2
      }
    );
  }

  let review: ReviewOutput;

  try {
    review = await options.reviewer.reviewDiff({
      ...(options.targetContext.approvedPlanMarkdown
        ? { approvedPlanMarkdown: options.targetContext.approvedPlanMarkdown }
        : {}),
      changedFiles: options.targetContext.changedFiles,
      config: options.config,
      diff: options.targetContext.diff,
      diffMode: options.targetContext.diffMode,
      repoRoot: options.repoRoot,
      safetyWarnings: options.targetContext.safetyWarnings,
      session: options.session,
      targetAgentId: options.pair.targetAgentId,
      targetDisplayName: options.targetContext.targetDisplayName,
      task: options.session.task,
      ...(options.targetContext.testSummary ? { testSummary: options.targetContext.testSummary } : {})
    });
  } catch (error) {
    review = reviewOutputSchema.parse({
      reviewerAgentId: options.pair.reviewerAgentId,
      targetAgentId: options.pair.targetAgentId,
      displayName: options.reviewer.displayName,
      generatedAt: new Date().toISOString(),
      verdict: "request_changes",
      summary: error instanceof Error ? error.message : "Reviewer failed.",
      blockingIssues: ["Review command failed; inspect raw execution context before proceeding."],
      nonBlockingIssues: [],
      securityConcerns: [],
      missingTests: [],
      edgeCases: [],
      maintainabilityConcerns: [],
      suggestedFixes: ["Rerun review after resolving the reviewer failure."],
      findings: [],
      riskyAreas: ["Review output is unavailable."],
      recommendation: "Do not proceed on this review alone.",
      confidence: 0.2,
      error: error instanceof Error ? error.message : "Reviewer failed.",
      metadata: {
        failed: true
      }
    });
  }

  await appendSessionEvent(options.session, {
    type: "agent.review.completed",
    agentId: options.pair.reviewerAgentId,
    status: review.error ? "failed" : "success",
    message: `${options.pair.reviewerAgentId} reviewed ${options.pair.targetAgentId}: ${review.verdict}.`,
    metadata: {
      blockingIssues: review.blockingIssues.length,
      securityConcerns: review.securityConcerns.length,
      targetAgentId: options.pair.targetAgentId,
      verdict: review.verdict
    }
  });

  return review;
}

async function buildTargetReviewContext(options: {
  approvedPlanMarkdown?: string;
  config: CodeCouncilConfig;
  rootDir: string;
  session: TaskSession;
  target: SelectedAgentConfig;
}): Promise<TargetReviewContext> {
  const implementation = await loadImplementationMetadata(options.session, options.target.id);
  const diffStat = await stat(implementation.diffPath);
  const diffSizeBytes = diffStat.size;
  const fullDiff = await readFile(implementation.diffPath, "utf8");
  const hasSensitiveOrIgnoredChanges =
    implementation.safety.blockedFiles.length > 0 ||
    implementation.safety.ignoredFiles.length > 0 ||
    implementation.safety.suspiciousFiles.length > 0;
  const diffMode =
    diffSizeBytes > options.config.review.maxDiffBytes || hasSensitiveOrIgnoredChanges
      ? "summary"
      : "full";
  const tests = await loadTestMetadata(options.session, options.target.id);
  const testSummary = await loadOptionalText(path.join(options.session.paths.testsDir, options.target.id, "summary.json"));
  const safetyWarnings = [
    ...implementation.safety.warnings,
    ...implementation.safety.blockedFiles.map((filePath) => `Blocked changed file: ${filePath}`),
    ...implementation.safety.suspiciousFiles.map((filePath) => `Suspicious changed file: ${filePath}`)
  ];

  return {
    ...(options.approvedPlanMarkdown ? { approvedPlanMarkdown: options.approvedPlanMarkdown } : {}),
    changedFiles: implementation.changedFiles,
    diff:
      diffMode === "full"
        ? fullDiff
        : [
            hasSensitiveOrIgnoredChanges
              ? "Patch omitted because sensitive, suspicious, or ignored files were touched."
              : `Patch omitted because it is ${diffSizeBytes} bytes, above configured review.maxDiffBytes=${options.config.review.maxDiffBytes}.`,
            "Perform a high-level review using the changed file list, tests, and safety metadata.",
            "",
            `Changed files: ${implementation.changedFiles.join(", ") || "none"}`
          ].join("\n"),
    diffMode,
    diffPath: implementation.diffPath,
    diffSizeBytes,
    implementation,
    safetyWarnings,
    targetAgentId: options.target.id,
    targetDisplayName: `${options.target.id} (${options.target.command})`,
    ...(testSummary ? { testSummary } : {}),
    tests
  };
}

async function calculateReviewAwareScores(options: {
  aggregateByTarget: Map<AgentId, TargetReviewAggregate>;
  session: TaskSession;
  targets: Map<AgentId, TargetReviewContext>;
}): Promise<ImplementationScore[]> {
  const scores: ImplementationScore[] = [];

  for (const [targetAgentId, context] of options.targets.entries()) {
    const reviewAggregate = options.aggregateByTarget.get(targetAgentId);
    const scoreInput = {
      agentId: targetAgentId,
      blockedFiles: context.implementation.safety.blockedFiles,
      changedFiles: context.implementation.changedFiles,
      diffSizeBytes: context.diffSizeBytes,
      implementationSucceeded: context.implementation.implementationSucceeded,
      suspiciousFiles: context.implementation.safety.suspiciousFiles,
      testsPassed: context.tests.testsPassed,
      testsRun: context.tests.testsRun
    };

    scores.push(
      calculateImplementationScore(
        reviewAggregate
          ? {
              ...scoreInput,
              reviewAggregate
            }
          : scoreInput
      )
    );
  }

  return scores;
}

function selectAgents(config: CodeCouncilConfig, requestedAgentIds: readonly string[]): SelectedAgentConfig[] {
  return resolveSelectedAgents(config, requestedAgentIds);
}

async function loadImplementationMetadata(
  session: TaskSession,
  agentId: AgentId
): Promise<ImplementationMetadata> {
  const implementationPath = path.join(session.paths.sessionDir, "runs", agentId, "implementation.json");
  const fallbackDiffPath = path.join(session.paths.diffsDir, `${agentId}.patch`);
  const source = await readFile(implementationPath, "utf8");
  const parsed = JSON.parse(source) as {
    changedFiles?: unknown;
    diffPath?: unknown;
    safety?: {
      blockedFiles?: unknown;
      ignoredFiles?: unknown;
      suspiciousFiles?: unknown;
      warnings?: unknown;
    };
    status?: unknown;
  };
  const diffPath = typeof parsed.diffPath === "string" ? parsed.diffPath : fallbackDiffPath;

  try {
    await access(diffPath);
  } catch {
    throw new CodeCouncilError(`No diff patch exists for agent "${agentId}". Run codecouncil implement first.`, {
      code: "DIFF_NOT_FOUND",
      exitCode: 2
    });
  }

  return {
    changedFiles: asStringArray(parsed.changedFiles),
    diffPath,
    implementationSucceeded: parsed.status === "success",
    safety: {
      blockedFiles: asStringArray(parsed.safety?.blockedFiles),
      ignoredFiles: asStringArray(parsed.safety?.ignoredFiles),
      suspiciousFiles: asStringArray(parsed.safety?.suspiciousFiles),
      warnings: asStringArray(parsed.safety?.warnings)
    }
  };
}

async function loadTestMetadata(session: TaskSession, agentId: AgentId): Promise<TestMetadata> {
  const summaryPath = path.join(session.paths.testsDir, agentId, "summary.json");

  try {
    const source = await readFile(summaryPath, "utf8");
    const parsed = JSON.parse(source) as {
      commands?: unknown;
      testsPassed?: unknown;
    };
    const commands = Array.isArray(parsed.commands) ? parsed.commands : [];

    return {
      testsPassed: parsed.testsPassed === true,
      testsRun: commands.length > 0
    };
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return {
        testsPassed: false,
        testsRun: false
      };
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

async function loadOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function parseAgentsOption(value: string | undefined): AgentId[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((agentId) => agentId.trim())
    .filter(Boolean);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function renderCliTable(summaries: readonly ReviewCliSummary[]): string[] {
  const rows = [
    ["reviewer", "target", "verdict", "blocking", "security", "review score impact"],
    ...summaries.map((summary) => [
      summary.reviewerAgentId,
      summary.targetAgentId,
      summary.verdict,
      String(summary.blockingIssues),
      String(summary.securityConcerns),
      formatScoreImpact(summary.reviewScoreImpact)
    ])
  ];
  const widths = rows[0]?.map((_, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex]?.length ?? 0))
  ) ?? [];

  return rows.map((row) =>
    row
      .map((cell, columnIndex) => cell.padEnd(widths[columnIndex] ?? cell.length))
      .join("  ")
  );
}

function formatScoreImpact(value: number): string {
  if (value > 0) {
    return `+${value}`;
  }

  return String(value);
}
