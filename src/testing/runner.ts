import { execa } from "execa";

import { redactSecrets } from "../core/redact.js";
import { classifyDangerousCommand } from "../safety/index.js";
import { parseCommandLine } from "./commandLine.js";

export type TestCommandStatus = "passed" | "failed" | "error";

export interface TestCommandRun {
  args: string[];
  command: string;
  commandLine: string;
  completedAt: string;
  cwd: string;
  durationMs: number;
  error?: string;
  exitCode?: number;
  startedAt: string;
  status: TestCommandStatus;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export interface RunTestCommandOptions {
  commandLine: string;
  cwd: string;
  timeoutMs: number;
}

export async function runTestCommand(options: RunTestCommandOptions): Promise<TestCommandRun> {
  const riskyCommands = classifyDangerousCommand(options.commandLine).filter(
    (finding) => finding.severity === "high" || finding.severity === "critical"
  );

  if (riskyCommands.length > 0) {
    const startedAt = new Date().toISOString();
    return {
      args: [],
      command: "",
      commandLine: options.commandLine,
      completedAt: startedAt,
      cwd: options.cwd,
      durationMs: 0,
      error: `Refused risky test command: ${riskyCommands.map((finding) => finding.reason).join(", ")}`,
      startedAt,
      status: "error",
      stderr: "",
      stdout: "",
      timedOut: false
    };
  }

  const parsed = parseCommandLine(options.commandLine);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  try {
    const result = await execa(parsed.command, parsed.args, {
      cwd: options.cwd,
      reject: false,
      shell: false,
      timeout: options.timeoutMs
    });
    const completed = Date.now();
    const exitCode = result.exitCode ?? 1;

    return {
      args: parsed.args,
      command: parsed.command,
      commandLine: options.commandLine,
      completedAt: new Date(completed).toISOString(),
      cwd: options.cwd,
      durationMs: completed - started,
      exitCode,
      startedAt,
      status: exitCode === 0 ? "passed" : "failed",
      stderr: redactSecrets(result.stderr),
      stdout: redactSecrets(result.stdout),
      timedOut: false
    };
  } catch (error) {
    const completed = Date.now();
    const maybeError = error as {
      exitCode?: number;
      isTerminated?: boolean;
      shortMessage?: string;
      stderr?: string;
      stdout?: string;
      timedOut?: boolean;
    };
    const timedOut = maybeError.timedOut === true || maybeError.isTerminated === true;
    const run: TestCommandRun = {
      args: parsed.args,
      command: parsed.command,
      commandLine: options.commandLine,
      completedAt: new Date(completed).toISOString(),
      cwd: options.cwd,
      durationMs: completed - started,
      error: redactSecrets(maybeError.shortMessage ?? "Test command failed."),
      startedAt,
      status: "error",
      stderr: redactSecrets(maybeError.stderr ?? ""),
      stdout: redactSecrets(maybeError.stdout ?? ""),
      timedOut
    };

    if (maybeError.exitCode !== undefined) {
      run.exitCode = maybeError.exitCode;
      run.status = maybeError.exitCode === 0 ? "passed" : "failed";
    }

    return run;
  }
}
