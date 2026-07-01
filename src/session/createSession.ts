import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CodeCouncilConfig } from "../config/schema.js";
import { isErrnoException } from "../core/errors.js";
import { appendSessionEvent } from "./eventLog.js";
import { taskSessionSchema, type TaskSession } from "./schema.js";

const SESSION_SUBDIRECTORIES = [
  "plans",
  "worktrees",
  "diffs",
  "reviews",
  "tests",
  "reports"
] as const;

export interface CreateTaskSessionOptions {
  config: CodeCouncilConfig;
  rootDir: string;
  task: string;
  now?: Date;
  slug?: string;
}

export interface LoadTaskSessionOptions {
  rootDir: string;
  sessionId: string;
  workspaceDir: string;
}

export interface ListTaskSessionsOptions {
  rootDir: string;
  workspaceDir: string;
}

export async function createTaskSession(
  options: CreateTaskSessionOptions
): Promise<TaskSession> {
  const now = options.now ?? new Date();
  const task = options.task.trim();

  if (!task) {
    throw new Error("Task is required to create a CodeCouncil session.");
  }

  const workspaceRoot = path.resolve(options.rootDir, options.config.workspaceDir);
  const runsRoot = path.join(workspaceRoot, "runs");
  await mkdir(runsRoot, { recursive: true });

  const sessionSlug = slugify(options.slug ?? task);
  const timestamp = formatSessionTimestamp(now);
  const { id, sessionDir } = await createUniqueSessionDirectory(runsRoot, timestamp, sessionSlug);
  const paths = buildSessionPaths(workspaceRoot, sessionDir);

  for (const directoryName of SESSION_SUBDIRECTORIES) {
    await mkdir(path.join(sessionDir, directoryName), { recursive: true });
  }

  const session = taskSessionSchema.parse({
    id,
    slug: sessionSlug,
    task,
    projectName: options.config.projectName,
    baseBranch: options.config.baseBranch,
    workspaceDir: options.config.workspaceDir,
    createdAt: now.toISOString(),
    status: "created",
    paths
  });

  await writeFile(session.paths.taskFile, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  await appendSessionEvent(
    session,
    {
      type: "session.created",
      status: "created",
      message: "Created CodeCouncil task session.",
      metadata: {
        task
      }
    },
    now
  );

  return session;
}

export function previewTaskSession(options: CreateTaskSessionOptions): TaskSession {
  const now = options.now ?? new Date();
  const task = options.task.trim();

  if (!task) {
    throw new Error("Task is required to preview a CodeCouncil session.");
  }

  const workspaceRoot = path.resolve(options.rootDir, options.config.workspaceDir);
  const sessionSlug = slugify(options.slug ?? task);
  const timestamp = formatSessionTimestamp(now);
  const id = `${timestamp}-${sessionSlug}`;
  const sessionDir = path.join(workspaceRoot, "runs", id);

  return taskSessionSchema.parse({
    id,
    slug: sessionSlug,
    task,
    projectName: options.config.projectName,
    baseBranch: options.config.baseBranch,
    workspaceDir: options.config.workspaceDir,
    createdAt: now.toISOString(),
    status: "created",
    paths: buildSessionPaths(workspaceRoot, sessionDir)
  });
}

export async function loadTaskSession(options: LoadTaskSessionOptions): Promise<TaskSession> {
  const taskFilePath = path.join(
    path.resolve(options.rootDir, options.workspaceDir),
    "runs",
    options.sessionId,
    "task.json"
  );
  const source = await readFile(taskFilePath, "utf8");
  return taskSessionSchema.parse(JSON.parse(source) as unknown);
}

export async function listTaskSessions(
  options: ListTaskSessionsOptions
): Promise<TaskSession[]> {
  const runsRoot = path.join(path.resolve(options.rootDir, options.workspaceDir), "runs");

  let entries;

  try {
    entries = await readdir(runsRoot, {
      withFileTypes: true
    });
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const sessions = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      sessions.push(
        await loadTaskSession({
          rootDir: options.rootDir,
          sessionId: entry.name,
          workspaceDir: options.workspaceDir
        })
      );
    } catch {
      // Ignore incomplete or non-CodeCouncil directories under runs/.
    }
  }

  return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function buildSessionPaths(workspaceRoot: string, sessionDir: string): TaskSession["paths"] {
  return {
    rootDir: workspaceRoot,
    sessionDir,
    taskFile: path.join(sessionDir, "task.json"),
    eventsFile: path.join(sessionDir, "events.jsonl"),
    plansDir: path.join(sessionDir, "plans"),
    worktreesDir: path.join(sessionDir, "worktrees"),
    diffsDir: path.join(sessionDir, "diffs"),
    reviewsDir: path.join(sessionDir, "reviews"),
    testsDir: path.join(sessionDir, "tests"),
    reportsDir: path.join(sessionDir, "reports")
  };
}

async function createUniqueSessionDirectory(
  runsRoot: string,
  timestamp: string,
  slug: string
): Promise<{ id: string; sessionDir: string }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const id = `${timestamp}-${slug}${suffix}`;
    const sessionDir = path.join(runsRoot, id);

    try {
      await mkdir(sessionDir);
      return {
        id,
        sessionDir
      };
    } catch (error) {
      if (isErrnoException(error) && error.code === "EEXIST") {
        continue;
      }

      throw error;
    }
  }

  throw new Error("Could not create a unique CodeCouncil session directory.");
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");

  return slug || "task";
}

export function formatSessionTimestamp(date: Date): string {
  const iso = date.toISOString();
  const datePart = iso.slice(0, 10).replace(/-/g, "");
  const timePart = iso.slice(11, 19).replace(/:/g, "");
  return `${datePart}-${timePart}`;
}
