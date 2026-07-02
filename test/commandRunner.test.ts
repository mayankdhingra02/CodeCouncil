import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ExecaAgentCommandRunner } from "../src/agents/index.js";

describe("ExecaAgentCommandRunner", () => {
  it("closes stdin when no input is provided", async () => {
    const runner = new ExecaAgentCommandRunner();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "codecouncil-runner-"));

    const result = await runner.run({
      args: ["-e", stdinProbeScript],
      command: process.execPath,
      cwd,
      timeoutMs: 1000
    });

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false
    });
    expect(result.stdout).toContain("STDIN_CLOSED_EMPTY");
  });

  it("passes explicit input when provided", async () => {
    const runner = new ExecaAgentCommandRunner();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "codecouncil-runner-"));

    const result = await runner.run({
      args: ["-e", stdinProbeScript],
      command: process.execPath,
      cwd,
      input: "hello from codecouncil",
      timeoutMs: 1000
    });

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false
    });
    expect(result.stdout).toContain("STDIN_INPUT:hello from codecouncil");
  });
});

const stdinProbeScript = `
let data = "";
const timer = setTimeout(() => {
  console.error("STDIN_STILL_OPEN");
  process.exit(3);
}, 250);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  clearTimeout(timer);
  console.log(data.length === 0 ? "STDIN_CLOSED_EMPTY" : \`STDIN_INPUT:\${data}\`);
});
process.stdin.resume();
`;
