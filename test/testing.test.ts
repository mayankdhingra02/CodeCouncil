import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { savePlanArtifacts, type PlanOutput } from "../src/agents/index.js";
import { createCli } from "../src/cli.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import { calculateImplementationScore } from "../src/scoring/index.js";
import {
  approveAgentPlan,
  createTaskSession,
  type TaskSession
} from "../src/session/index.js";
import { detectProjectTypes, selectTestCommands } from "../src/testing/index.js";

describe("test detection", () => {
  it("detects supported project types and default test commands", async () => {
    const rootDir = await makeTempDir("codecouncil-detect-");

    await writeFile(path.join(rootDir, "package.json"), "{}\n", "utf8");
    await writeFile(path.join(rootDir, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");
    await writeFile(path.join(rootDir, "pyproject.toml"), "[project]\nname = 'x'\n", "utf8");
    await writeFile(path.join(rootDir, "go.mod"), "module example.test/app\n", "utf8");
    await writeFile(path.join(rootDir, "Cargo.toml"), "[package]\nname='x'\n", "utf8");
    await writeFile(path.join(rootDir, "pom.xml"), "<project />\n", "utf8");
    await writeFile(path.join(rootDir, "build.gradle"), "plugins {}\n", "utf8");
    await writeFile(path.join(rootDir, "App.csproj"), "<Project />\n", "utf8");

    const detections = await detectProjectTypes(rootDir);

    expect(detections.map((detection) => detection.type)).toEqual([
      "node",
      "python",
      "go",
      "rust",
      "maven",
      "gradle",
      "dotnet"
    ]);
    expect(detections.flatMap((detection) => detection.commands)).toEqual(
      expect.arrayContaining([
        "pnpm test",
        "pytest",
        "go test ./...",
        "cargo test",
        "mvn test",
        "./gradlew test",
        "dotnet test"
      ])
    );
  });

  it("prefers explicit and configured test commands before detection", async () => {
    const rootDir = await makeTempDir("codecouncil-select-tests-");
    await writeFile(path.join(rootDir, "package.json"), "{}\n", "utf8");

    await expect(
      selectTestCommands({
        configuredCommands: ["npm test"],
        explicitCommands: ["node custom-test.mjs"],
        rootDir
      })
    ).resolves.toMatchObject({
      commands: ["node custom-test.mjs"],
      source: "cli"
    });

    await expect(
      selectTestCommands({
        configuredCommands: ["npm test"],
        rootDir
      })
    ).resolves.toMatchObject({
      commands: ["npm test"],
      source: "config"
    });
  });
});

describe("test runner CLI", () => {
  it("runs successful tests in an implementation worktree and saves scores", async () => {
    const repo = await createTempGitRepo({
      "pass-test.mjs": "console.log('pass ok');\n"
    });
    const session = await createApprovedSession(repo, "Score passing implementation");

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
      "test",
      "--session",
      session.id,
      "--agents",
      "mock-codex",
      "--command",
      "node pass-test.mjs"
    ]);
    const payload = JSON.parse(stdout) as {
      scores: Array<{ agentId: string; score: number; testsPassed: boolean }>;
      status: string;
      summaries: Array<{ testsPassed: boolean; testsRun: boolean }>;
    };

    expect(payload.status).toBe("success");
    expect(payload.summaries[0]).toMatchObject({
      testsPassed: true,
      testsRun: true
    });
    expect(payload.scores[0]).toMatchObject({
      agentId: "mock-codex",
      score: 100,
      testsPassed: true
    });

    await expect(
      readFile(path.join(session.paths.testsDir, "mock-codex", "command-1.stdout.log"), "utf8")
    ).resolves.toContain("pass ok");
    await expect(readFile(path.join(session.paths.testsDir, "summary.md"), "utf8")).resolves.toContain(
      "mock-codex"
    );
    await expect(
      readFile(path.join(session.paths.sessionDir, "scores", "implementation-scores.json"), "utf8")
    ).resolves.toContain('"score": 100');
  });

  it("records failing tests without throwing and lowers the score", async () => {
    const repo = await createTempGitRepo({
      "fail-test.mjs": "console.error('fail expected');\nprocess.exit(3);\n"
    });
    const session = await createApprovedSession(repo, "Score failing implementation");

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
      "test",
      "--session",
      session.id,
      "--agents",
      "mock-codex",
      "--command",
      "node fail-test.mjs"
    ]);
    const payload = JSON.parse(stdout) as {
      scores: Array<{ score: number; testsPassed: boolean }>;
      status: string;
      summaries: Array<{ testsPassed: boolean }>;
    };

    expect(payload.status).toBe("failed");
    expect(payload.summaries[0]?.testsPassed).toBe(false);
    expect(payload.scores[0]).toMatchObject({
      score: 65,
      testsPassed: false
    });
    await expect(
      readFile(path.join(session.paths.testsDir, "mock-codex", "command-1.stderr.log"), "utf8")
    ).resolves.toContain("fail expected");
  });
});

describe("implementation scoring", () => {
  it("scores implementation quality from tests, diff size, and safety", () => {
    const score = calculateImplementationScore({
      agentId: "mock-codex",
      blockedFiles: [],
      changedFiles: ["src/a.ts", "test/a.test.ts"],
      diffSizeBytes: 2048,
      implementationSucceeded: true,
      suspiciousFiles: [],
      testsPassed: true,
      testsRun: true
    });

    expect(score.score).toBe(100);
    expect(score.components.map((component) => component.name)).toEqual([
      "Implementation",
      "Tests",
      "Safety",
      "Reviews",
      "Changed Files",
      "Diff Size"
    ]);
  });
});

async function createApprovedSession(repo: string, task: string): Promise<TaskSession> {
  const config = createDefaultConfig({
    projectName: "testing-test"
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

async function createTempGitRepo(files: Record<string, string>): Promise<string> {
  const repo = await makeTempDir("codecouncil-test-runner-");

  await execa("git", ["init"], {
    cwd: repo
  });
  await execa("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: repo
  });
  await writeFile(path.join(repo, ".gitignore"), ".codecouncil/\n", "utf8");
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n", "utf8");

  for (const [filePath, source] of Object.entries(files)) {
    await writeFile(path.join(repo, filePath), source, "utf8");
  }

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
