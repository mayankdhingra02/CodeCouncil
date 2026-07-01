import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/config/defaults.js";
import { appendSessionEvent, createTaskSession } from "../src/session/index.js";
import type { EventLogEntry, TaskSession } from "../src/session/index.js";

describe("task sessions", () => {
  it("creates the durable session directory layout", async () => {
    const rootDir = await makeTempDir();
    const config = createDefaultConfig({
      projectName: "my-app"
    });

    const session = await createTaskSession({
      config,
      rootDir,
      task: "Add caching to receipt parsing",
      now: new Date("2026-07-01T12:34:56.000Z")
    });

    expect(session.id).toBe("20260701-123456-add-caching-to-receipt-parsing");
    expect(session.paths.sessionDir).toBe(
      path.join(rootDir, ".codecouncil", "runs", session.id)
    );

    await expectDirectory(session.paths.plansDir);
    await expectDirectory(session.paths.worktreesDir);
    await expectDirectory(session.paths.diffsDir);
    await expectDirectory(session.paths.reviewsDir);
    await expectDirectory(session.paths.testsDir);
    await expectDirectory(session.paths.reportsDir);

    const storedTask = JSON.parse(await readFile(session.paths.taskFile, "utf8")) as TaskSession;

    expect(storedTask).toMatchObject({
      id: session.id,
      task: "Add caching to receipt parsing",
      projectName: "my-app",
      baseBranch: "main",
      workspaceDir: ".codecouncil",
      status: "created"
    });
  });

  it("appends JSONL events to a session event log", async () => {
    const rootDir = await makeTempDir();
    const config = createDefaultConfig({
      projectName: "my-app"
    });
    const session = await createTaskSession({
      config,
      rootDir,
      task: "Review checkout flow",
      now: new Date("2026-07-01T12:34:56.000Z")
    });

    await appendSessionEvent(
      session,
      {
        type: "plan.stubbed",
        agentId: "codex",
        status: "skipped",
        message: "Plan command parsed, but agent planning is not implemented yet.",
        metadata: {
          selectedAgents: ["codex", "claude"]
        }
      },
      new Date("2026-07-01T12:35:00.000Z")
    );

    const events = (await readFile(session.paths.eventsFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as EventLogEntry);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      timestamp: "2026-07-01T12:34:56.000Z",
      type: "session.created",
      status: "created"
    });
    expect(events[1]).toMatchObject({
      timestamp: "2026-07-01T12:35:00.000Z",
      type: "plan.stubbed",
      agentId: "codex",
      status: "skipped",
      metadata: {
        selectedAgents: ["codex", "claude"]
      }
    });
  });
});

async function expectDirectory(directoryPath: string): Promise<void> {
  const result = await stat(directoryPath);
  expect(result.isDirectory()).toBe(true);
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "codecouncil-session-"));
}

