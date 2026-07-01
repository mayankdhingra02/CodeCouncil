import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { savePlanArtifacts, type PlanOutput } from "../src/agents/index.js";
import { createCli } from "../src/cli.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import {
  recommendSolution,
  type AgentReportSummary
} from "../src/report/index.js";
import {
  approveAgentPlan,
  createTaskSession,
  type TaskSession
} from "../src/session/index.js";

describe("final recommendation algorithm", () => {
  it("recommends a single agent when it passes tests and is clearly strongest", () => {
    const recommendation = recommendSolution([
      makeAgentSummary("mock-codex", {
        changedFiles: ["src/auth.ts"],
        score: 95,
        testsPassed: true,
        testsRun: true
      }),
      makeAgentSummary("mock-claude", {
        changedFiles: ["src/auth.ts", "src/email.ts"],
        reviewRequestChanges: 1,
        score: 75,
        testsPassed: true,
        testsRun: true
      })
    ]);

    expect(recommendation).toMatchObject({
      recommendedAgentId: "mock-codex",
      recommendationType: "recommend_agent_solution"
    });
  });

  it("recommends no solution when all implementations are unsafe", () => {
    const recommendation = recommendSolution([
      makeAgentSummary("mock-codex", {
        safetyWarnings: ["Blocked file: .env"],
        score: 70,
        testsPassed: true,
        testsRun: true
      })
    ]);

    expect(recommendation).toMatchObject({
      recommendedAgentIds: [],
      recommendationType: "recommend_no_solution"
    });
  });

  it("recommends combining close clean solutions with different changed files", () => {
    const recommendation = recommendSolution([
      makeAgentSummary("mock-codex", {
        changedFiles: ["src/auth.ts"],
        score: 96,
        testsPassed: true,
        testsRun: true
      }),
      makeAgentSummary("mock-claude", {
        changedFiles: ["src/email.ts"],
        score: 94,
        testsPassed: true,
        testsRun: true
      })
    ]);

    expect(recommendation).toMatchObject({
      recommendedAgentIds: ["mock-codex", "mock-claude"],
      recommendationType: "recommend_combine_solutions"
    });
  });
});

describe("report and apply CLI", () => {
  it("generates final report artifacts and markdown contents", async () => {
    const repo = await createTempGitRepo();
    const session = await createApprovedSession(repo, "Generate a final recommendation");

    await runCli([
      "--cwd",
      repo,
      "implement",
      "--session",
      session.id,
      "--agents",
      "mock-codex,mock-claude"
    ]);
    await runCli([
      "--cwd",
      repo,
      "test",
      "--session",
      session.id,
      "--agents",
      "mock-codex,mock-claude",
      "--command",
      "node pass-test.mjs"
    ]);
    await runCli([
      "--cwd",
      repo,
      "review",
      "--session",
      session.id
    ]);

    const stdout = await runCli([
      "--cwd",
      repo,
      "--json",
      "report",
      "--session",
      session.id
    ]);
    const payload = JSON.parse(stdout) as {
      recommendation: {
        recommendationType: string;
        recommendedAgentIds: string[];
      };
      reportPath: string;
      recommendationPath: string;
    };

    expect(payload.recommendation.recommendationType).toBe("recommend_combine_solutions");
    expect(payload.recommendation.recommendedAgentIds).toEqual(
      expect.arrayContaining(["mock-codex", "mock-claude"])
    );

    const markdown = await readFile(payload.reportPath, "utf8");
    expect(markdown).toContain("# CodeCouncil Final Report");
    expect(markdown).toContain("## Final Recommendation");
    expect(markdown).toContain("## Commands To Inspect Worktrees");
    expect(markdown).toContain("codecouncil apply --session");

    await expect(readFile(payload.recommendationPath, "utf8")).resolves.toContain(
      '"recommendationType": "recommend_combine_solutions"'
    );
  });

  it("prints dry-run apply guidance without modifying files", async () => {
    const repo = await createTempGitRepo();
    const session = await createApprovedSession(repo, "Preview applying a solution");

    await runCli([
      "--cwd",
      repo,
      "implement",
      "--session",
      session.id,
      "--agents",
      "mock-codex"
    ]);

    const stdout = await runCli([
      "--cwd",
      repo,
      "--json",
      "apply",
      "--session",
      session.id,
      "--agent",
      "mock-codex",
      "--dry-run"
    ]);
    const payload = JSON.parse(stdout) as {
      agentId: string;
      changedFiles: string[];
      dryRun: boolean;
      status: string;
    };

    expect(payload).toMatchObject({
      agentId: "mock-codex",
      dryRun: true,
      status: "dry-run"
    });
    expect(payload.changedFiles).toEqual(["CODECOUNCIL_MOCK_MOCK_CODEX.md"]);
  });
});

function makeAgentSummary(
  agentId: string,
  overrides: Partial<AgentReportSummary> = {}
): AgentReportSummary {
  return {
    agentId,
    blockingReviewIssues: 0,
    changedFiles: ["src/app.ts"],
    diffSizeBytes: 1000,
    implementationStatus: "success",
    reviewApprovals: 1,
    reviewConfidence: 0.8,
    reviewRejections: 0,
    reviewRequestChanges: 0,
    safetyWarnings: [],
    score: 90,
    securityConcerns: 0,
    testsPassed: true,
    testsRun: true,
    worktreePath: `/tmp/${agentId}`,
    ...overrides
  };
}

async function createApprovedSession(repo: string, task: string): Promise<TaskSession> {
  const config = createDefaultConfig({
    projectName: "report-test"
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
    testsToRun: ["node pass-test.mjs"],
    estimatedComplexity: "low",
    confidence: 0.9,
    metadata: {}
  };
}

async function createTempGitRepo(): Promise<string> {
  const repo = await makeTempDir("codecouncil-report-");

  await execa("git", ["init"], {
    cwd: repo
  });
  await execa("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: repo
  });
  await writeFile(path.join(repo, ".gitignore"), ".codecouncil/\n", "utf8");
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n", "utf8");
  await writeFile(path.join(repo, "pass-test.mjs"), "console.log('pass ok');\n", "utf8");
  await execa("git", ["add", "."], {
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
