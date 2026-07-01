import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/config/defaults.js";
import {
  GitManager,
  assertSafeWorktreeRemovalPath,
  createAgentBranchName
} from "../src/git/index.js";
import { createTaskSession, previewTaskSession } from "../src/session/index.js";

describe("GitManager", () => {
  it("detects repository root, current branch, and dirty state", async () => {
    const repo = await createTempGitRepo();
    const nestedDir = path.join(repo, "src", "nested");
    await mkdir(nestedDir, { recursive: true });
    const manager = new GitManager(nestedDir);

    await writeFile(path.join(repo, "dirty.txt"), "not committed\n", "utf8");

    await expect(manager.isInsideGitRepository()).resolves.toBe(true);
    await expect(manager.getRepoRoot()).resolves.toBe(repo);
    await expect(manager.getCurrentBranch()).resolves.toBe("main");

    const status = await manager.getRepositoryStatus();

    expect(status).toMatchObject({
      insideWorkTree: true,
      repoRoot: repo,
      currentBranch: "main",
      clean: false
    });
    expect(status.changedFiles).toContain("?? dirty.txt");
  });

  it("creates an agent worktree in the session worktree directory", async () => {
    const repo = await createTempGitRepo();
    const config = createDefaultConfig({
      projectName: "git-test"
    });
    const session = await createTaskSession({
      config,
      rootDir: repo,
      task: "Add payments cache",
      now: new Date("2026-07-01T12:34:56.000Z")
    });
    const manager = new GitManager(repo);

    const result = await manager.createWorktree({
      agentId: "codex",
      session
    });

    expect(result).toMatchObject({
      agentId: "codex",
      baseBranch: "main",
      branchName: "codecouncil/add-payments-cache/codex",
      dryRun: false,
      worktreePath: path.join(session.paths.worktreesDir, "codex")
    });

    const worktreeStat = await stat(result.worktreePath);
    expect(worktreeStat.isDirectory()).toBe(true);

    const worktrees = await manager.listWorktrees();
    expect(worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branch: "codecouncil/add-payments-cache/codex",
          path: result.worktreePath
        })
      ])
    );
  });

  it("detects changed files in an agent worktree", async () => {
    const repo = await createTempGitRepo();
    const config = createDefaultConfig({
      projectName: "git-test"
    });
    const session = await createTaskSession({
      config,
      rootDir: repo,
      task: "Add agent output",
      now: new Date("2026-07-01T12:34:56.000Z")
    });
    const manager = new GitManager(repo);
    const result = await manager.createWorktree({
      agentId: "claude",
      session
    });

    await writeFile(path.join(result.worktreePath, "agent-output.txt"), "hello\n", "utf8");

    await expect(manager.getChangedFiles(result.worktreePath, "main")).resolves.toContain(
      "agent-output.txt"
    );
  });

  it("sanitizes agent branch names", () => {
    expect(createAgentBranchName("Feature: AMAZING!!", "Codex Agent!")).toBe(
      "codecouncil/feature-amazing/codex-agent"
    );
  });

  it("rejects unsafe worktree removal paths", async () => {
    const repo = await makeTempDir("codecouncil-unsafe-");
    const config = createDefaultConfig({
      projectName: "git-test"
    });
    const session = previewTaskSession({
      config,
      rootDir: repo,
      task: "Unsafe cleanup check",
      now: new Date("2026-07-01T12:34:56.000Z")
    });

    expect(() =>
      assertSafeWorktreeRemovalPath(path.join(session.paths.rootDir, "runs", "outside"), session)
    ).toThrow(
      "outside this session's worktrees directory"
    );
    expect(() => assertSafeWorktreeRemovalPath(session.paths.worktreesDir, session)).toThrow(
      "workspace root"
    );
    expect(() => assertSafeWorktreeRemovalPath(path.join(os.tmpdir(), "elsewhere"), session)).toThrow(
      "outside CodeCouncil workspace"
    );
  });
});

async function createTempGitRepo(): Promise<string> {
  const repo = await makeTempDir("codecouncil-git-");

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

async function makeTempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}
