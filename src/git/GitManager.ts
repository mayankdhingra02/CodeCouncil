import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

import { CodeCouncilError } from "../core/errors.js";
import type { AgentId } from "../config/schema.js";
import type { TaskSession } from "../session/schema.js";

export interface GitCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface GitWorktreeInfo {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
}

export interface GitRepositoryStatus {
  insideWorkTree: boolean;
  repoRoot?: string;
  currentBranch?: string;
  clean?: boolean;
  changedFiles: string[];
}

export interface WorktreeOperationResult {
  agentId: AgentId;
  baseBranch: string;
  branchName: string;
  dryRun: boolean;
  reused: boolean;
  worktreePath: string;
}

export interface CreateWorktreeOptions {
  agentId: AgentId;
  baseBranch?: string;
  dryRun?: boolean;
  session: TaskSession;
}

export interface RemoveWorktreeOptions {
  agentId: AgentId;
  deleteBranch?: boolean;
  dryRun?: boolean;
  force?: boolean;
  session: TaskSession;
}

export interface CreatePatchFileOptions {
  baseBranch: string;
  dryRun?: boolean;
  outputPath: string;
  worktreePath: string;
}

export interface CreatePatchFileResult {
  dryRun: boolean;
  outputPath: string;
  bytesWritten: number;
}

export interface CommitAgentChangesOptions {
  dryRun?: boolean;
  message: string;
  worktreePath: string;
}

export interface CommitAgentChangesResult {
  commitSha?: string;
  dryRun: boolean;
}

export class GitCommandError extends CodeCouncilError {
  public constructor(args: readonly string[], cwd: string, result: GitCommandResult) {
    const details = result.stderr || result.stdout || `exit code ${result.exitCode}`;
    super(`Git command failed in ${cwd}: git ${args.join(" ")}\n${details}`, {
      code: "GIT_COMMAND_FAILED",
      exitCode: 2
    });
  }
}

export class GitManager {
  public constructor(private readonly cwd: string) {}

  public async isInsideGitRepository(): Promise<boolean> {
    const result = await this.runGit(["rev-parse", "--is-inside-work-tree"], {
      allowFailure: true
    });

    return result.exitCode === 0 && result.stdout.trim() === "true";
  }

  public async getRepoRoot(): Promise<string> {
    const result = await this.runGit(["rev-parse", "--show-toplevel"]);
    return result.stdout.trim();
  }

  public async getCurrentBranch(): Promise<string> {
    const result = await this.runGit(["branch", "--show-current"]);
    const branch = result.stdout.trim();

    if (!branch) {
      throw new CodeCouncilError("The current git checkout is detached; a branch is required.", {
        code: "GIT_DETACHED_HEAD",
        exitCode: 2
      });
    }

    return branch;
  }

  public async resolveBaseBranch(baseBranch: string): Promise<string> {
    if (await this.refExists(baseBranch)) {
      return baseBranch;
    }

    throw new CodeCouncilError(
      `Configured base branch "${baseBranch}" was not found. Update codecouncil.config.json or pass --base.`,
      {
        code: "BASE_BRANCH_NOT_FOUND",
        exitCode: 2
      }
    );
  }

  public async isWorkingTreeClean(cwd = this.cwd): Promise<boolean> {
    const files = await this.getDirtyFiles(cwd);
    return files.length === 0;
  }

  public async getDirtyFiles(cwd = this.cwd): Promise<string[]> {
    const result = await this.runGit(["status", "--porcelain=v1"], {
      cwd
    });

    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  public async getRepositoryStatus(): Promise<GitRepositoryStatus> {
    if (!(await this.isInsideGitRepository())) {
      return {
        insideWorkTree: false,
        changedFiles: []
      };
    }

    const repoRoot = await this.getRepoRoot();
    const [currentBranch, changedFiles] = await Promise.all([
      this.getCurrentBranch(),
      this.getDirtyFiles(repoRoot)
    ]);

    return {
      insideWorkTree: true,
      repoRoot,
      currentBranch,
      clean: changedFiles.length === 0,
      changedFiles
    };
  }

  public async createWorktree(options: CreateWorktreeOptions): Promise<WorktreeOperationResult> {
    const baseBranch = await this.resolveBaseBranch(options.baseBranch ?? options.session.baseBranch);
    const branchName = createAgentBranchName(options.session.slug, options.agentId);
    const worktreePath = getAgentWorktreePath(options.session, options.agentId);
    assertSafeWorktreeRemovalPath(worktreePath, options.session);

    const result = {
      agentId: options.agentId,
      baseBranch,
      branchName,
      dryRun: options.dryRun === true,
      reused: false,
      worktreePath
    };

    if (options.dryRun === true) {
      return result;
    }

    await mkdir(options.session.paths.worktreesDir, { recursive: true });
    await this.runGit(["worktree", "add", "-b", branchName, worktreePath, baseBranch]);
    return result;
  }

  public async ensureWorktree(options: CreateWorktreeOptions): Promise<WorktreeOperationResult> {
    const baseBranch = await this.resolveBaseBranch(options.baseBranch ?? options.session.baseBranch);
    const branchName = createAgentBranchName(options.session.slug, options.agentId);
    const worktreePath = getAgentWorktreePath(options.session, options.agentId);
    assertSafeWorktreeRemovalPath(worktreePath, options.session);
    const existingWorktree = (await this.listWorktrees()).find(
      (worktree) => path.resolve(worktree.path) === path.resolve(worktreePath)
    );

    if (existingWorktree) {
      if (existingWorktree.branch && existingWorktree.branch !== branchName) {
        throw new CodeCouncilError(
          `Existing worktree for ${options.agentId} is on branch "${existingWorktree.branch}", expected "${branchName}".`,
          {
            code: "WORKTREE_BRANCH_MISMATCH",
            exitCode: 2
          }
        );
      }

      return {
        agentId: options.agentId,
        baseBranch,
        branchName,
        dryRun: options.dryRun === true,
        reused: true,
        worktreePath
      };
    }

    if (options.dryRun === true) {
      return {
        agentId: options.agentId,
        baseBranch,
        branchName,
        dryRun: true,
        reused: false,
        worktreePath
      };
    }

    await mkdir(options.session.paths.worktreesDir, { recursive: true });

    if (await this.refExists(branchName)) {
      await this.runGit(["worktree", "add", worktreePath, branchName]);
    } else {
      await this.runGit(["worktree", "add", "-b", branchName, worktreePath, baseBranch]);
    }

    return {
      agentId: options.agentId,
      baseBranch,
      branchName,
      dryRun: false,
      reused: false,
      worktreePath
    };
  }

  public async removeWorktree(options: RemoveWorktreeOptions): Promise<WorktreeOperationResult> {
    const baseBranch = options.session.baseBranch;
    const branchName = createAgentBranchName(options.session.slug, options.agentId);
    const worktreePath = getAgentWorktreePath(options.session, options.agentId);
    assertSafeWorktreeRemovalPath(worktreePath, options.session);

    const result = {
      agentId: options.agentId,
      baseBranch,
      branchName,
      dryRun: options.dryRun === true,
      reused: false,
      worktreePath
    };

    if (options.dryRun === true) {
      return result;
    }

    const args = ["worktree", "remove"];

    if (options.force === true) {
      args.push("--force");
    }

    args.push(worktreePath);
    await this.runGit(args);

    if (options.deleteBranch === true && (await this.refExists(branchName))) {
      await this.runGit(["branch", "-D", branchName]);
    }

    return result;
  }

  public async listWorktrees(): Promise<GitWorktreeInfo[]> {
    const result = await this.runGit(["worktree", "list", "--porcelain"]);
    return parseWorktreeList(result.stdout);
  }

  public async getDiffAgainstBase(worktreePath: string, baseBranch: string): Promise<string> {
    const resolvedBaseBranch = await this.resolveBaseBranch(baseBranch);
    const result = await this.runGit(["diff", "--binary", resolvedBaseBranch, "--"], {
      cwd: worktreePath
    });
    const untrackedDiffs = await this.getUntrackedFileDiffs(worktreePath);

    return [result.stdout, ...untrackedDiffs].filter((diff) => diff.trim().length > 0).join("\n");
  }

  public async getChangedFiles(worktreePath: string, baseBranch: string): Promise<string[]> {
    const resolvedBaseBranch = await this.resolveBaseBranch(baseBranch);
    const [diffResult, untrackedResult] = await Promise.all([
      this.runGit(["diff", "--name-only", resolvedBaseBranch, "--"], {
        cwd: worktreePath
      }),
      this.runGit(["ls-files", "--others", "--exclude-standard"], {
        cwd: worktreePath
      })
    ]);

    return [...diffResult.stdout.split("\n"), ...untrackedResult.stdout.split("\n")]
      .map((line) => line.trim())
      .filter(Boolean);
  }

  public async getUntrackedFiles(worktreePath: string): Promise<string[]> {
    const result = await this.runGit(["ls-files", "--others", "--exclude-standard"], {
      cwd: worktreePath
    });

    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  public async createPatchFile(options: CreatePatchFileOptions): Promise<CreatePatchFileResult> {
    const diff = await this.getDiffAgainstBase(options.worktreePath, options.baseBranch);

    if (options.dryRun === true) {
      return {
        dryRun: true,
        outputPath: options.outputPath,
        bytesWritten: Buffer.byteLength(diff)
      };
    }

    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, diff, "utf8");

    return {
      dryRun: false,
      outputPath: options.outputPath,
      bytesWritten: Buffer.byteLength(diff)
    };
  }

  public async commitAgentChanges(
    options: CommitAgentChangesOptions
  ): Promise<CommitAgentChangesResult> {
    if (options.dryRun === true) {
      return {
        dryRun: true
      };
    }

    await this.runGit(["add", "-A"], {
      cwd: options.worktreePath
    });
    await this.runGit(["commit", "-m", options.message], {
      cwd: options.worktreePath
    });
    const commit = await this.runGit(["rev-parse", "HEAD"], {
      cwd: options.worktreePath
    });

    return {
      commitSha: commit.stdout.trim(),
      dryRun: false
    };
  }

  private async refExists(ref: string): Promise<boolean> {
    const result = await this.runGit(["rev-parse", "--verify", "--quiet", ref], {
      allowFailure: true
    });

    return result.exitCode === 0;
  }

  private async getUntrackedFileDiffs(worktreePath: string): Promise<string[]> {
    const untrackedFiles = await this.getUntrackedFiles(worktreePath);
    const diffs = [];

    for (const filePath of untrackedFiles) {
      const result = await this.runGit(["diff", "--binary", "--no-index", "--", "/dev/null", filePath], {
        allowFailure: true,
        cwd: worktreePath
      });

      if (result.stdout.trim().length > 0) {
        diffs.push(result.stdout);
      }
    }

    return diffs;
  }

  private async runGit(
    args: readonly string[],
    options: {
      allowFailure?: boolean;
      cwd?: string;
    } = {}
  ): Promise<GitCommandResult> {
    const cwd = options.cwd ?? this.cwd;
    const result = await execa("git", args, {
      cwd,
      reject: false,
      shell: false
    });
    const commandResult = {
      exitCode: result.exitCode ?? 1,
      stderr: result.stderr,
      stdout: result.stdout
    };

    if (commandResult.exitCode !== 0 && options.allowFailure !== true) {
      throw new GitCommandError(args, cwd, commandResult);
    }

    return commandResult;
  }
}

export function getAgentWorktreePath(session: TaskSession, agentId: AgentId): string {
  return path.join(session.paths.worktreesDir, sanitizeGitPathSegment(agentId));
}

export function createAgentBranchName(sessionSlug: string, agentId: AgentId): string {
  return `codecouncil/${sanitizeGitPathSegment(sessionSlug)}/${sanitizeGitPathSegment(agentId)}`;
}

export function sanitizeGitPathSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 64)
    .replace(/[.-]+$/g, "")
    .replace(/\.lock$/u, "");

  if (!sanitized || sanitized === "@") {
    return "item";
  }

  return sanitized;
}

export function assertSafeWorktreeRemovalPath(worktreePath: string, session: TaskSession): void {
  const resolvedWorktreePath = path.resolve(worktreePath);
  const workspaceRoot = path.resolve(session.paths.rootDir);
  const sessionWorktreesRoot = path.resolve(session.paths.worktreesDir);

  if (resolvedWorktreePath === workspaceRoot || resolvedWorktreePath === sessionWorktreesRoot) {
    throw new CodeCouncilError(`Refusing to remove CodeCouncil workspace root: ${resolvedWorktreePath}`, {
      code: "UNSAFE_WORKTREE_PATH",
      exitCode: 2
    });
  }

  if (!isPathInside(resolvedWorktreePath, workspaceRoot)) {
    throw new CodeCouncilError(
      `Refusing to remove worktree outside CodeCouncil workspace: ${resolvedWorktreePath}`,
      {
        code: "UNSAFE_WORKTREE_PATH",
        exitCode: 2
      }
    );
  }

  if (!isPathInside(resolvedWorktreePath, sessionWorktreesRoot)) {
    throw new CodeCouncilError(
      `Refusing to remove worktree outside this session's worktrees directory: ${resolvedWorktreePath}`,
      {
        code: "UNSAFE_WORKTREE_PATH",
        exitCode: 2
      }
    );
  }
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function parseWorktreeList(output: string): GitWorktreeInfo[] {
  const entries: GitWorktreeInfo[] = [];
  let current: GitWorktreeInfo | undefined;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();

    if (!line) {
      if (current) {
        entries.push(current);
        current = undefined;
      }

      continue;
    }

    const [key, ...valueParts] = line.split(" ");
    const value = valueParts.join(" ");

    if (key === "worktree") {
      if (current) {
        entries.push(current);
      }

      current = {
        path: value
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (key === "HEAD") {
      current.head = value;
    } else if (key === "branch") {
      current.branch = value.replace(/^refs\/heads\//u, "");
    } else if (key === "bare") {
      current.bare = true;
    } else if (key === "detached") {
      current.detached = true;
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries;
}
