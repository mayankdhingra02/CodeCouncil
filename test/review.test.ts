import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import {
  buildReviewOutputFromCommand,
  savePlanArtifacts,
  type AgentCommandResult,
  type PlanOutput,
  type ReviewOutput
} from "../src/agents/index.js";
import { createCli } from "../src/cli.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import { aggregateReviews, createReviewPairs } from "../src/review/index.js";
import { calculateImplementationScore } from "../src/scoring/index.js";
import {
  approveAgentPlan,
  createTaskSession,
  type TaskSession
} from "../src/session/index.js";

describe("cross-agent review pairing", () => {
  it("pairs reviewers and targets while skipping self-review by default", () => {
    expect(
      createReviewPairs({
        reviewers: ["mock-codex", "mock-claude"],
        selfReview: false,
        targets: ["mock-codex", "mock-claude"]
      })
    ).toEqual([
      {
        reviewerAgentId: "mock-codex",
        targetAgentId: "mock-claude"
      },
      {
        reviewerAgentId: "mock-claude",
        targetAgentId: "mock-codex"
      }
    ]);
  });
});

describe("review parsing and aggregation", () => {
  it("parses structured review JSON from agent stdout", () => {
    const review = buildReviewOutputFromCommand({
      agentId: "mock-codex",
      displayName: "Mock Codex",
      result: makeCommandResult(
        JSON.stringify({
          verdict: "reject",
          summary: "Unsafe change.",
          blockingIssues: ["Breaks login."],
          nonBlockingIssues: ["Naming can improve."],
          securityConcerns: ["Logs a token."],
          missingTests: ["No auth regression test."],
          edgeCases: ["Expired token path."],
          maintainabilityConcerns: ["Too much logic in one file."],
          suggestedFixes: ["Remove token logging."],
          recommendation: "Do not merge.",
          confidence: 0.91
        })
      ),
      targetAgentId: "mock-claude"
    });

    expect(review).toMatchObject({
      blockingIssues: ["Breaks login."],
      securityConcerns: ["Logs a token."],
      targetAgentId: "mock-claude",
      verdict: "reject"
    });
  });

  it("aggregates verdict and issue counts per implementation target", () => {
    const aggregates = aggregateReviews([
      makeReview("mock-codex", "mock-claude", "approve"),
      makeReview("mock-claude", "mock-codex", "request_changes", {
        blockingIssues: ["Bug"],
        missingTests: ["No test"],
        nonBlockingIssues: ["Style"],
        securityConcerns: ["Secret"]
      })
    ]);

    expect(aggregates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          approvals: 0,
          blockingIssueCount: 1,
          missingTestCount: 1,
          nonBlockingIssueCount: 1,
          requestChangesCount: 1,
          securityConcernCount: 1,
          targetAgentId: "mock-codex"
        }),
        expect.objectContaining({
          approvals: 1,
          targetAgentId: "mock-claude"
        })
      ])
    );
  });

  it("reduces scores for blocking review issues and security concerns", () => {
    const score = calculateImplementationScore({
      agentId: "mock-codex",
      blockedFiles: [],
      changedFiles: ["src/auth.ts"],
      diffSizeBytes: 1000,
      implementationSucceeded: true,
      reviewAggregate: {
        approvals: 0,
        blockingIssueCount: 1,
        missingTestCount: 1,
        nonBlockingIssueCount: 1,
        rejectionCount: 0,
        requestChangesCount: 1,
        reviewCount: 1,
        securityConcernCount: 1,
        targetAgentId: "mock-codex",
        verdicts: {
          approve: 0,
          reject: 0,
          request_changes: 1
        }
      },
      suspiciousFiles: [],
      testsPassed: true,
      testsRun: true
    });

    expect(score.score).toBeLessThan(90);
    expect(score.components.find((component) => component.name === "Reviews")?.points).toBe(0);
  });
});

describe("review CLI", () => {
  it("runs default cross-reviews, saves artifacts, and avoids self-review", async () => {
    const repo = await createTempGitRepo();
    const session = await createApprovedSession(repo, "Cross review mock implementations");

    await runCli([
      "--cwd",
      repo,
      "implement",
      "--session",
      session.id,
      "--agents",
      "mock-codex,mock-claude"
    ]);

    const stdout = await runCli([
      "--cwd",
      repo,
      "--json",
      "review",
      "--session",
      session.id
    ]);
    const payload = JSON.parse(stdout) as {
      pairs: Array<{ reviewerAgentId: string; targetAgentId: string }>;
      summaries: Array<{ reviewerAgentId: string; targetAgentId: string; verdict: string }>;
    };

    expect(payload.pairs).toEqual([
      {
        reviewerAgentId: "mock-codex",
        targetAgentId: "mock-claude"
      },
      {
        reviewerAgentId: "mock-claude",
        targetAgentId: "mock-codex"
      }
    ]);
    expect(payload.pairs.some((pair) => pair.reviewerAgentId === pair.targetAgentId)).toBe(false);
    expect(payload.summaries.map((summary) => summary.verdict)).toEqual(["approve", "approve"]);

    await expect(
      readFile(path.join(session.paths.reviewsDir, "mock-codex-reviews-mock-claude.json"), "utf8")
    ).resolves.toContain('"verdict": "approve"');
    await expect(readFile(path.join(session.paths.reviewsDir, "summary.md"), "utf8")).resolves.toContain(
      "mock-claude"
    );
    await expect(
      readFile(path.join(session.paths.sessionDir, "scores", "implementation-scores.md"), "utf8")
    ).resolves.toContain("Reviews");
  });
});

async function createApprovedSession(repo: string, task: string): Promise<TaskSession> {
  const config = createDefaultConfig({
    projectName: "review-test"
  });
  const session = await createTaskSession({
    config,
    rootDir: repo,
    task,
    now: new Date("2026-07-01T12:34:56.000Z")
  });

  await savePlanArtifacts(session, makePlan("mock-codex"));
  await approveAgentPlan(session, "mock-codex", new Date("2026-07-01T12:40:00.000Z"));

  return session;
}

function makePlan(agentId: string): PlanOutput {
  return {
    agentId,
    displayName: agentId,
    generatedAt: "2026-07-01T12:34:56.000Z",
    summary: "Approved mock implementation plan.",
    assumptions: ["The mock test repo is small."],
    proposedFilesToChange: ["CODECOUNCIL_MOCK_MOCK_CODEX.md"],
    stepByStepPlan: ["Create a harmless mock implementation artifact."],
    risks: ["None for mock implementation."],
    testsToRun: [],
    estimatedComplexity: "low",
    confidence: 0.9,
    metadata: {}
  };
}

function makeReview(
  reviewerAgentId: string,
  targetAgentId: string,
  verdict: ReviewOutput["verdict"],
  overrides: Partial<ReviewOutput> = {}
): ReviewOutput {
  return {
    reviewerAgentId,
    targetAgentId,
    displayName: reviewerAgentId,
    generatedAt: "2026-07-01T12:34:56.000Z",
    verdict,
    summary: "Review summary.",
    blockingIssues: [],
    nonBlockingIssues: [],
    securityConcerns: [],
    missingTests: [],
    edgeCases: [],
    maintainabilityConcerns: [],
    suggestedFixes: [],
    findings: [],
    riskyAreas: [],
    recommendation: "Proceed.",
    confidence: 0.8,
    metadata: {},
    ...overrides
  };
}

function makeCommandResult(stdout: string): AgentCommandResult {
  return {
    args: ["review"],
    command: "mock",
    completedAt: "2026-07-01T12:34:57.000Z",
    cwd: "/tmp/repo",
    durationMs: 10,
    exitCode: 0,
    stderr: "",
    stdout,
    timedOut: false,
    startedAt: "2026-07-01T12:34:56.000Z"
  };
}

async function createTempGitRepo(): Promise<string> {
  const repo = await makeTempDir("codecouncil-review-");

  await execa("git", ["init"], {
    cwd: repo
  });
  await execa("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: repo
  });
  await writeFile(path.join(repo, ".gitignore"), ".codecouncil/\n", "utf8");
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n", "utf8");
  await execa("git", ["add", ".gitignore", "README.md"], {
    cwd: repo
  });
  await execa(
    "git",
    [
      "-c",
      "user.name=CodeCouncil Test",
      "-c",
      "user.email=codecouncil@example.test",
      "commit",
      "-m",
      "initial"
    ],
    {
      cwd: repo
    }
  );

  return repo;
}

async function runCli(argv: readonly string[]): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    await createCli().parseAsync(["node", "codecouncil", ...argv]);
  } finally {
    process.stdout.write = originalWrite;
  }

  return chunks.join("");
}

async function makeTempDir(prefix: string): Promise<string> {
  await mkdir(os.tmpdir(), { recursive: true });
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}
