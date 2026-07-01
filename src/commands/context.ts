import path from "node:path";
import type { Command } from "commander";

export interface OutputStream {
  write(chunk: string): boolean;
}

export interface CommandContext {
  cwd: string;
  json: boolean;
  stderr: OutputStream;
  stdout: OutputStream;
  configPath?: string;
  workspaceDir?: string;
}

interface GlobalCliOptions {
  config?: string;
  cwd?: string;
  json?: boolean;
  workspaceDir?: string;
}

export function getCommandContext(command: Command): CommandContext {
  const options = command.optsWithGlobals<GlobalCliOptions>();
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const context: CommandContext = {
    cwd,
    json: options.json === true,
    stderr: process.stderr,
    stdout: process.stdout
  };

  if (options.config) {
    context.configPath = path.resolve(cwd, options.config);
  }

  if (options.workspaceDir) {
    context.workspaceDir = options.workspaceDir;
  }

  return context;
}

export function writeLines(context: CommandContext, lines: readonly string[]): void {
  for (const line of lines) {
    context.stdout.write(`${line}\n`);
  }
}

export function writeResult(
  context: CommandContext,
  payload: Record<string, unknown>,
  lines: readonly string[]
): void {
  if (context.json) {
    context.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  writeLines(context, lines);
}
