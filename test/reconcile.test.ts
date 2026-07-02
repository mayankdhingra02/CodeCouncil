import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createCli } from "../src/cli.js";
import type { EventLogEntry } from "../src/session/index.js";

describe("reconcile CLI", () => {
  it("creates reconciled plan artifacts and allows explicit reconciled approval", async () => {
    const cwd = await makeTempDir();
    const planStdout = await runCli([
      "--cwd",
      cwd,
      "--json",
      "plan",
      "Add a small retry helper",
      "--agents",
      "mock-codex,mock-claude"
    ]);
    const planPayload = JSON.parse(planStdout) as {
      sessionDir: string;
      sessionId: string;
    };

    const reconcileStdout = await runCli([
      "--cwd",
      cwd,
      "--json",
      "reconcile",
      "--session",
      planPayload.sessionId,
      "--reconciler",
      "mock-codex"
    ]);
    const reconcilePayload = JSON.parse(reconcileStdout) as {
      artifacts: {
        jsonPath: string;
        markdownPath: string;
      };
      reconciliation: {
        mergedPlan: {
          summary: string;
        };
        metadata: {
          planAliases?: Record<string, string>;
        };
        reconcilerAgentId: string;
        resolutions: unknown[];
      };
      status: string;
    };

    expect(reconcilePayload).toMatchObject({
      reconciliation: {
        reconcilerAgentId: "mock-codex"
      },
      status: "success"
    });
    expect(reconcilePayload.reconciliation.resolutions.length).toBeGreaterThan(0);
    expect(Object.values(reconcilePayload.reconciliation.metadata.planAliases ?? {})).toEqual(
      expect.arrayContaining(["mock-codex", "mock-claude"])
    );
    await expect(readFile(reconcilePayload.artifacts.jsonPath, "utf8")).resolves.toContain("mergedPlan");
    await expect(readFile(reconcilePayload.artifacts.markdownPath, "utf8")).resolves.toContain(
      "codecouncil approve"
    );

    await runCli([
      "--cwd",
      cwd,
      "--json",
      "approve",
      "--session",
      planPayload.sessionId,
      "--reconciled"
    ]);
    const approved = JSON.parse(
      await readFile(path.join(planPayload.sessionDir, "approved-plan.json"), "utf8")
    ) as { approvedBy: string; summary: string };

    expect(approved.approvedBy).toBe("reconciled");
    expect(approved.summary).toContain("Synthesize");

    const events = await readEvents(path.join(planPayload.sessionDir, "events.jsonl"));
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["reconciliation.started", "reconciliation.completed", "plan.approved"])
    );
  });
});

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

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "codecouncil-reconcile-"));
}
