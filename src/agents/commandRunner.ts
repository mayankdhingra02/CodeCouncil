import { access } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { execa } from "execa";

import { redactSecrets } from "../core/redact.js";

export interface AgentCommandRunOptions {
  args: readonly string[];
  command: string;
  cwd: string;
  input?: string;
  timeoutMs: number;
}

export interface AgentCommandResult {
  args: string[];
  command: string;
  completedAt: string;
  cwd: string;
  durationMs: number;
  error?: string;
  exitCode?: number;
  stderr: string;
  stdout: string;
  timedOut: boolean;
  startedAt: string;
}

export interface AgentCommandRunner {
  isCommandAvailable(command: string): Promise<boolean>;
  run(options: AgentCommandRunOptions): Promise<AgentCommandResult>;
}

export class ExecaAgentCommandRunner implements AgentCommandRunner {
  public async isCommandAvailable(command: string): Promise<boolean> {
    return findExecutable(command);
  }

  public async run(options: AgentCommandRunOptions): Promise<AgentCommandResult> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();

    try {
      const execaOptions = {
        cwd: options.cwd,
        reject: false,
        shell: false,
        timeout: options.timeoutMs,
        ...(options.input === undefined ? { stdin: "ignore" as const } : { input: options.input })
      };
      const result = await execa(options.command, [...options.args], {
        ...execaOptions
      });
      const completed = Date.now();

      const commandResult: AgentCommandResult = {
        args: [...options.args],
        command: options.command,
        completedAt: new Date(completed).toISOString(),
        cwd: options.cwd,
        durationMs: completed - started,
        exitCode: result.exitCode ?? 1,
        stderr: redactSecrets(result.stderr),
        stdout: redactSecrets(result.stdout),
        timedOut: false,
        startedAt
      };

      return commandResult;
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

      const commandResult: AgentCommandResult = {
        args: [...options.args],
        command: options.command,
        completedAt: new Date(completed).toISOString(),
        cwd: options.cwd,
        durationMs: completed - started,
        error: redactSecrets(maybeError.shortMessage ?? "Agent command failed."),
        stderr: redactSecrets(maybeError.stderr ?? ""),
        stdout: redactSecrets(maybeError.stdout ?? ""),
        timedOut: maybeError.timedOut === true || maybeError.isTerminated === true,
        startedAt
      };

      if (maybeError.exitCode !== undefined) {
        commandResult.exitCode = maybeError.exitCode;
      }

      return commandResult;
    }
  }
}

async function findExecutable(command: string): Promise<boolean> {
  if (command.includes("/") || command.includes("\\")) {
    return canExecute(command);
  }

  const pathValue = process.env["PATH"] ?? "";
  const extensions = process.platform === "win32"
    ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];

  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) {
      continue;
    }

    for (const extension of extensions) {
      if (await canExecute(path.join(directory, `${command}${extension}`))) {
        return true;
      }
    }
  }

  return false;
}

async function canExecute(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
