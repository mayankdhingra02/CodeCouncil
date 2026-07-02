import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { savePlanArtifacts, type PlanOutput } from "../src/agents/index.js";
import { createCli } from "../src/cli.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import { GitManager } from "../src/git/index.js";
import { classifyChangedFiles } from "../src/safety/index.js";
import {
  approveAgentPlan,
  createTaskSession,
  type EventLogEntry,
  type TaskSession
} from "../src/session/index.js";

describe("implementation phase", () => {
  it("runs mock implementation in an isolated worktree and saves diff artifacts", async () => {
    const repo = await createTempGitRepo();
    const session = await createApprovedSession(repo, "Add mock implementation");

    const stdout = await runCli([
      "--cwd",
      repo,
      "--json",
      "implement",
      "--session",
      session.id,
      "--agents",
      "mock-codex"
    ]);
    const payload = JSON.parse(stdout) as {
      summaries: Array<{
        agentId: string;
        changedFiles: string[];
        diffPath: string;
        implementationJsonPath: string;
        status: string;
        worktreePath: string;
      }>;
    };
    const summary = payload.summaries[0];

    expect(summary).toMatchObject({
      agentId: "mock-codex",
      changedFiles: ["CODECOUNCIL_MOCK_MOCK_CODEX.md"],
      status: "success",
      worktreePath: path.join(session.paths.worktreesDir, "mock-codex")
    });

    await expectDirectory(summary?.worktreePath ?? "");
    await expect(readFile(summary?.diffPath ?? "", "utf8")).resolves.toContain(
      "CODECOUNCIL_MOCK_MOCK_CODEX.md"
    );
    await expect(readFile(summary?.implementationJsonPath ?? "", "utf8")).resolves.toContain(
      '"status": "success"'
    );

    const events = await readEvents(session.paths.eventsFile);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "implementation.started",
        "agent.implementation.started",
        "agent.implementation.completed",
        "implementation.completed"
      ])
    );
  });

  it("blocks implementation when the session has no approved plan", async () => {
    const repo = await createTempGitRepo();
    const config = createDefaultConfig({
      projectName: "implementation-test"
    });
    const session = await createTaskSession({
      config,
      rootDir: repo,
      task: "Unapproved task",
      now: new Date("2026-07-01T12:34:56.000Z")
    });

    await expect(
      runCli(["--cwd", repo, "implement", "--session", session.id, "--agents", "mock-codex"])
    ).rejects.toMatchObject({
      code: "IMPLEMENTATION_APPROVAL_REQUIRED"
    });
  });

  it("rejects the unimplemented from-plan option instead of silently ignoring it", async () => {
    const repo = await createTempGitRepo();
    const session = await createApprovedSession(repo, "Reject from-plan");

    await expect(
      runCli([
        "--cwd",
        repo,
        "implement",
        "--session",
        session.id,
        "--agents",
        "mock-codex",
        "--from-plan",
        path.join(session.paths.plansDir, "mock-codex.json")
      ])
    ).rejects.toMatchObject({
      code: "FROM_PLAN_NOT_IMPLEMENTED"
    });
  });

  it("blocks implementation results that touch secret files", async () => {
    const repo = await createTempGitRepo();
    const session = await createApprovedSession(repo, "Avoid secret changes");
    const git = new GitManager(repo);
    const worktree = await git.ensureWorktree({
      agentId: "mock-codex",
      session
    });

    await writeFile(path.join(worktree.worktreePath, ".env"), "SECRET=value\n", "utf8");

    await expect(
      runCli(["--cwd", repo, "implement", "--session", session.id, "--agents", "mock-codex"])
    ).rejects.toMatchObject({
      code: "BLOCKED_FILE_CHANGE"
    });

    await expect(
      readFile(path.join(session.paths.sessionDir, "runs", "mock-codex", "implementation.json"), "utf8")
    ).resolves.toContain('"status": "blocked"');

    const events = await readEvents(session.paths.eventsFile);
    expect(events.map((event) => event.type)).toContain("agent.implementation.blocked");
  });

  it("classifies secret and ignored file modifications as blocked", () => {
    const safety = classifyChangedFiles([".env", "node_modules/pkg/index.js", "src/app.ts"]);

    expect(safety.blockedFiles).toEqual([".env", "node_modules/pkg/index.js"]);
    expect(safety.safeFiles).toEqual(["src/app.ts"]);
  });
});

async function createApprovedSession(repo: string, task: string): Promise<TaskSession> {
  const config = createDefaultConfig({
    projectName: "implementation-test"
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
    testsToRun: ["pnpm test"],
    estimatedComplexity: "low",
    confidence: 0.9,
    metadata: {}
  };
}

async function createTempGitRepo(): Promise<string> {
  const repo = await makeTempDir("codecouncil-implementation-");

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

async function readEvents(eventsPath: string): Promise<EventLogEntry[]> {
  return (await readFile(eventsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as EventLogEntry);
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

async function expectDirectory(directoryPath: string): Promise<void> {
  const result = await stat(directoryPath);
  expect(result.isDirectory()).toBe(true);
}

async function makeTempDir(prefix: string): Promise<string> {
  await mkdir(os.tmpdir(), { recursive: true });
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}
