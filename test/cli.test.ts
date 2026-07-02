import { describe, expect, it } from "vitest";

import { createCli } from "../src/cli.js";

describe("createCli", () => {
  it("registers the initial command surface", () => {
    const commandNames = createCli()
      .commands.map((command) => command.name())
      .sort();

    expect(commandNames).toEqual([
      "apply",
      "approve",
      "benchmark",
      "doctor",
      "implement",
      "init",
      "models",
      "plan",
      "report",
      "resume",
      "review",
      "safety",
      "sessions",
      "solve",
      "test",
      "worktree"
    ]);
  });

  it("prints model guidance", async () => {
    const chunks: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await createCli().parseAsync(["node", "codecouncil", "models", "list"]);
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = chunks.join("");
    expect(output).toContain("OpenAI Codex");
    expect(output).toContain("Anthropic Claude Code");
    expect(output).toContain("--models codex=gpt-5.4-mini,claude=sonnet");
  });
});
