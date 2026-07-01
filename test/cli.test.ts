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
});
