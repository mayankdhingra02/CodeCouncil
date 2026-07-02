import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
      "reconcile",
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
    const output = await runCli(["models", "list"]);

    expect(output).toContain("OpenAI Codex");
    expect(output).toContain("Anthropic Claude Code");
    expect(output).toContain("--models codex=gpt-5.4-mini,claude=sonnet");
  });

  it("maps model catalogs through configured adapter ids", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "codecouncil-models-"));
    await writeFile(
      path.join(cwd, "codecouncil.config.json"),
      `${JSON.stringify(
        {
          projectName: "models-test",
          agents: {
            "codex-mini": {
              adapter: "codex",
              command: "codex"
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const output = await runCli(["--cwd", cwd, "--json", "models", "list"]);
    const payload = JSON.parse(output) as {
      catalogs: Array<{ adapterId: string; agentId: string; provider: string }>;
    };

    expect(payload.catalogs).toEqual([
      expect.objectContaining({
        adapterId: "codex",
        agentId: "codex-mini",
        provider: "OpenAI Codex"
      })
    ]);
  });
});

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
