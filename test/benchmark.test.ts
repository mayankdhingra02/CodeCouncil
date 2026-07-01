import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import {
  loadBenchmarkTasks,
  renderBenchmarkCsv,
  renderBenchmarkSummaryMarkdown,
  summarizeBenchmarkResults,
  type BenchmarkMetricResult
} from "../src/benchmark/index.js";
import { createCli } from "../src/cli.js";

describe("benchmark mode", () => {
  it("validates benchmark task files", async () => {
    const root = await makeTempDir("codecouncil-benchmark-validation-");
    const tasksPath = path.join(root, "tasks.json");

    await writeFile(
      tasksPath,
      JSON.stringify([
        {
          id: "task-001",
          title: "Add input validation",
          description: "Add validation and tests.",
          repositoryPath: "../sample-app",
          baseBranch: "main",
          testCommands: ["node -e \"process.exit(0)\""],
          expectedFiles: ["src/signup.ts"],
          evaluationNotes: "Check invalid email and password cases."
        }
      ]),
      "utf8"
    );

    await expect(loadBenchmarkTasks(tasksPath)).resolves.toMatchObject([
      {
        id: "task-001",
        repositoryPath: "../sample-app"
      }
    ]);

    await writeFile(tasksPath, JSON.stringify([{ id: "" }]), "utf8");
    await expect(loadBenchmarkTasks(tasksPath)).rejects.toMatchObject({
      code: "CONFIG_ERROR"
    });
  });

  it("runs selected benchmark strategies with mock agents and writes research artifacts", async () => {
    const root = await makeTempDir("codecouncil-benchmark-run-");
    const repo = await createTempGitRepo(root);
    const tasksPath = path.join(root, "tasks.json");

    await writeFile(
      tasksPath,
      JSON.stringify(
        [
          {
            id: "task-001",
            title: "Add input validation",
            description: "Add validation to the signup endpoint.",
            repositoryPath: "sample-app",
            baseBranch: "main",
            testCommands: ["node -e \"process.exit(0)\""]
          }
        ],
        null,
        2
      ),
      "utf8"
    );

    const stdout = await runCli([
      "--cwd",
      root,
      "--json",
      "benchmark",
      "--tasks",
      tasksPath,
      "--agents",
      "mock-codex,mock-claude",
      "--strategies",
      "codex_only,codex_then_claude_review,both_implement_then_review_and_select"
    ]);
    const payload = JSON.parse(stdout) as {
      outputDir: string;
      outputs: {
        resultsJsonlPath: string;
        summaryJsonPath: string;
        summaryMarkdownPath: string;
        tableCsvPath: string;
      };
      resultCount: number;
      runId: string;
    };

    expect(payload.resultCount).toBe(3);
    await expect(readFile(payload.outputs.resultsJsonlPath, "utf8")).resolves.toContain(
      "codex_then_claude_review"
    );
    await expect(readFile(payload.outputs.summaryMarkdownPath, "utf8")).resolves.toContain(
      "Single-Agent vs Two-Agent Workflows"
    );
    await expect(readFile(payload.outputs.tableCsvPath, "utf8")).resolves.toContain(
      "reviewFindingCount"
    );
    await expect(readFile(path.join(root, "benchmark", "latest.json"), "utf8")).resolves.toContain(
      payload.runId
    );

    const labelOutput = await runCli([
      "--cwd",
      root,
      "--json",
      "benchmark",
      "label",
      "--run",
      payload.runId,
      "--accepted",
      "true",
      "--notes",
      "Accepted after inspection.",
      "--task",
      "task-001",
      "--strategy",
      "codex_only"
    ]);
    const labelPayload = JSON.parse(labelOutput) as { labeledResults: number };

    expect(labelPayload.labeledResults).toBe(1);
    await expect(readFile(payload.outputs.resultsJsonlPath, "utf8")).resolves.toContain(
      "\"acceptedByHuman\":true"
    );

    expect(repo).toContain("sample-app");
  });

  it("aggregates metrics and renders CSV plus markdown summaries", () => {
    const results = [
      makeResult({
        strategy: "codex_only",
        taskSuccess: true,
        testsPassed: true,
        totalDurationMs: 1000
      }),
      makeResult({
        strategy: "both_implement_then_review_and_select",
        taskSuccess: false,
        testsPassed: false,
        totalDurationMs: 2500,
        reviewFindingCount: 2,
        failureModes: ["tests_failed"]
      })
    ] satisfies BenchmarkMetricResult[];
    const summary = summarizeBenchmarkResults("run-1", results);
    const markdown = renderBenchmarkSummaryMarkdown(summary, results);
    const csv = renderBenchmarkCsv(results);

    expect(summary.singleAgent.successRate).toBe(1);
    expect(summary.twoAgent.successRate).toBe(0);
    expect(summary.failureModes).toMatchObject({
      tests_failed: 1
    });
    expect(summary.collaborationMadeThingsWorse).toHaveLength(1);
    expect(markdown).toContain("Review Benefit");
    expect(csv).toContain("both_implement_then_review_and_select");
  });
});

function makeResult(overrides: Partial<BenchmarkMetricResult>): BenchmarkMetricResult {
  return {
    agentIds: ["mock-codex", "mock-claude"],
    changedFiles: ["CODECOUNCIL_MOCK.md"],
    diffSizeBytes: 1200,
    expectedFiles: [],
    failureModes: [],
    finalRecommendation: {
      recommendedAgentIds: ["mock-codex"],
      recommendationType: "recommend_agent_solution",
      summary: "Inspect mock-codex first."
    },
    implementationDurationMs: 100,
    repositoryPath: "/tmp/repo",
    reviewDurationMs: 0,
    reviewFindingCount: 0,
    runId: "run-1",
    safetyWarnings: [],
    sessionId: "session-1",
    status: "success",
    strategy: "codex_only",
    taskId: "task-001",
    taskSuccess: false,
    testsPassed: false,
    testsRun: true,
    title: "Task",
    totalDurationMs: 1000,
    ...overrides
  };
}

async function createTempGitRepo(root: string): Promise<string> {
  const repo = path.join(root, "sample-app");

  await execa("git", ["init", repo]);
  await execa("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: repo
  });
  await writeFile(path.join(repo, ".gitignore"), ".codecouncil/\n.codecouncil.benchmark.*.json\n", "utf8");
  await writeFile(path.join(repo, "README.md"), "# Benchmark Test Repo\n", "utf8");
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
  return mkdtemp(path.join(os.tmpdir(), prefix));
}
