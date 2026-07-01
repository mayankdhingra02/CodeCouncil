import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentId } from "../config/schema.js";
import type { TargetReviewAggregate } from "../review/index.js";
import type { TaskSession } from "../session/index.js";

export interface ImplementationScoreInput {
  agentId: AgentId;
  blockedFiles: readonly string[];
  changedFiles: readonly string[];
  diffSizeBytes: number;
  implementationSucceeded: boolean;
  reviewAggregate?: TargetReviewAggregate;
  suspiciousFiles: readonly string[];
  testsPassed: boolean;
  testsRun: boolean;
}

export interface ScoreComponent {
  max: number;
  name: string;
  points: number;
  reason: string;
}

export interface ImplementationScore {
  agentId: AgentId;
  changedFileCount: number;
  components: ScoreComponent[];
  diffSizeBytes: number;
  reviewAggregate?: TargetReviewAggregate;
  score: number;
  testsPassed: boolean;
  testsRun: boolean;
}

export interface SavedImplementationScores {
  jsonPath: string;
  markdownPath: string;
  scores: ImplementationScore[];
}

export function calculateImplementationScore(input: ImplementationScoreInput): ImplementationScore {
  const components = [
    implementationComponent(input.implementationSucceeded),
    testComponent(input.testsRun, input.testsPassed),
    safetyComponent(input.blockedFiles, input.suspiciousFiles),
    reviewComponent(input.reviewAggregate),
    changedFilesComponent(input.changedFiles.length),
    diffSizeComponent(input.diffSizeBytes)
  ];
  const score = Math.max(0, Math.min(100, components.reduce((total, component) => total + component.points, 0)));

  return {
    agentId: input.agentId,
    changedFileCount: input.changedFiles.length,
    components,
    diffSizeBytes: input.diffSizeBytes,
    ...(input.reviewAggregate ? { reviewAggregate: input.reviewAggregate } : {}),
    score,
    testsPassed: input.testsPassed,
    testsRun: input.testsRun
  };
}

export async function saveImplementationScores(options: {
  scores: readonly ImplementationScore[];
  session: TaskSession;
}): Promise<SavedImplementationScores> {
  const scoresDir = path.join(options.session.paths.sessionDir, "scores");
  await mkdir(scoresDir, { recursive: true });

  const jsonPath = path.join(scoresDir, "implementation-scores.json");
  const markdownPath = path.join(scoresDir, "implementation-scores.md");
  const scores = [...options.scores].sort((a, b) => b.score - a.score || a.agentId.localeCompare(b.agentId));

  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        formula: "implementation 15, tests 40, safety 20, reviews 15, changed files 5, diff size 5",
        scores,
        sessionId: options.session.id
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(markdownPath, renderImplementationScoresMarkdown(options.session.id, scores), "utf8");

  return {
    jsonPath,
    markdownPath,
    scores
  };
}

export function renderImplementationScoresMarkdown(
  sessionId: string,
  scores: readonly ImplementationScore[]
): string {
  const lines = [
    "# Implementation Scores",
    "",
    `Session: ${sessionId}`,
    "",
    "| Agent | Score | Tests | Reviews | Changed Files | Diff Size |",
    "| --- | ---: | --- | --- | ---: | ---: |"
  ];

  for (const score of scores) {
    lines.push(
      `| ${score.agentId} | ${score.score} | ${formatTestStatus(score)} | ${formatReviewStatus(score)} | ${score.changedFileCount} | ${formatBytes(score.diffSizeBytes)} |`
    );
  }

  lines.push("", "## Formula", "");
  lines.push("- Implementation succeeded: 15 points.");
  lines.push("- Tests passed: 40 points; tests run but failing: 5 points; no tests: 0 points.");
  lines.push("- No blocked or suspicious files: 20 points; suspicious files only: 10 points; blocked files: 0 points.");
  lines.push("- Review results: up to 15 points.");
  lines.push("- Changed-file count: up to 5 points.");
  lines.push("- Diff size: up to 5 points.");
  lines.push("");

  for (const score of scores) {
    lines.push(`## ${score.agentId}`, "");

    for (const component of score.components) {
      lines.push(`- ${component.name}: ${component.points}/${component.max} - ${component.reason}`);
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function implementationComponent(succeeded: boolean): ScoreComponent {
  return {
    max: 15,
    name: "Implementation",
    points: succeeded ? 15 : 0,
    reason: succeeded ? "Implementation completed successfully." : "Implementation did not complete successfully."
  };
}

function testComponent(testsRun: boolean, testsPassed: boolean): ScoreComponent {
  if (!testsRun) {
    return {
      max: 40,
      name: "Tests",
      points: 0,
      reason: "No tests were run."
    };
  }

  return {
    max: 40,
    name: "Tests",
    points: testsPassed ? 40 : 5,
    reason: testsPassed ? "All selected test commands passed." : "At least one selected test command failed."
  };
}

function safetyComponent(
  blockedFiles: readonly string[],
  suspiciousFiles: readonly string[]
): ScoreComponent {
  if (blockedFiles.length > 0) {
    return {
      max: 20,
      name: "Safety",
      points: 0,
      reason: `Blocked files were touched: ${blockedFiles.join(", ")}.`
    };
  }

  if (suspiciousFiles.length > 0) {
    return {
      max: 20,
      name: "Safety",
      points: 10,
      reason: `Suspicious files were touched: ${suspiciousFiles.join(", ")}.`
    };
  }

  return {
    max: 20,
    name: "Safety",
    points: 20,
    reason: "No blocked or suspicious files were reported."
  };
}

function changedFilesComponent(changedFileCount: number): ScoreComponent {
  let points;

  if (changedFileCount <= 5) {
    points = 5;
  } else if (changedFileCount <= 15) {
    points = 4;
  } else if (changedFileCount <= 30) {
    points = 2;
  } else {
    points = 1;
  }

  return {
    max: 5,
    name: "Changed Files",
    points,
    reason: `${changedFileCount} changed file${changedFileCount === 1 ? "" : "s"}.`
  };
}

function diffSizeComponent(diffSizeBytes: number): ScoreComponent {
  let points;

  if (diffSizeBytes <= 10_000) {
    points = 5;
  } else if (diffSizeBytes <= 50_000) {
    points = 4;
  } else if (diffSizeBytes <= 200_000) {
    points = 2;
  } else {
    points = 1;
  }

  return {
    max: 5,
    name: "Diff Size",
    points,
    reason: `${formatBytes(diffSizeBytes)} patch size.`
  };
}

function reviewComponent(aggregate: TargetReviewAggregate | undefined): ScoreComponent {
  if (!aggregate || aggregate.reviewCount === 0) {
    return {
      max: 15,
      name: "Reviews",
      points: 15,
      reason: "No reviews have been recorded yet."
    };
  }

  const penalties =
    aggregate.requestChangesCount * 4 +
    aggregate.rejectionCount * 8 +
    aggregate.blockingIssueCount * 5 +
    aggregate.securityConcernCount * 8 +
    aggregate.missingTestCount * 2 +
    aggregate.nonBlockingIssueCount;
  const points = Math.max(0, Math.min(15, 13 + aggregate.approvals * 2 - penalties));

  return {
    max: 15,
    name: "Reviews",
    points,
    reason: `${aggregate.approvals} approval(s), ${aggregate.requestChangesCount} request-change review(s), ${aggregate.rejectionCount} rejection(s), ${aggregate.blockingIssueCount} blocking issue(s), ${aggregate.securityConcernCount} security concern(s).`
  };
}

function formatTestStatus(score: ImplementationScore): string {
  if (!score.testsRun) {
    return "not run";
  }

  return score.testsPassed ? "passed" : "failed";
}

function formatReviewStatus(score: ImplementationScore): string {
  if (!score.reviewAggregate) {
    return "not run";
  }

  return `${score.reviewAggregate.approvals}/${score.reviewAggregate.reviewCount} approve`;
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
