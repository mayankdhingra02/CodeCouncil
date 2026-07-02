import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createReviewPrompt } from "../src/agents/prompts.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import { createTaskSession } from "../src/session/index.js";

describe("agent prompts", () => {
  it("places review diff before the final JSON response instruction", async () => {
    const config = createDefaultConfig({
      projectName: "prompt-test"
    });
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "codecouncil-prompts-"));
    const session = await createTaskSession({
      config,
      rootDir,
      task: "Review prompt ordering",
      now: new Date("2026-07-01T12:34:56.000Z")
    });
    const prompt = createReviewPrompt({
      changedFiles: ["src/example.ts"],
      config,
      diff: "diff --git a/src/example.ts b/src/example.ts",
      repoRoot: rootDir,
      session,
      targetAgentId: "codex",
      task: session.task
    });

    expect(prompt.lastIndexOf("Diff:")).toBeLessThan(prompt.lastIndexOf("Return only JSON with this shape:"));
    expect(prompt.trim().endsWith("}")).toBe(true);
  });
});
