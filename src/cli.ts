#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Command } from "commander";

import { registerCommands } from "./commands/index.js";
import { handleCliError } from "./core/errors.js";

export function createCli(): Command {
  const program = new Command();

  program
    .name("codecouncil")
    .description("Coordinate multiple AI coding agents through isolated git worktrees.")
    .version("0.1.0")
    .option("-C, --cwd <path>", "repository path to operate on")
    .option("-c, --config <path>", "path to a CodeCouncil JSON config file")
    .option("--workspace-dir <path>", "override the CodeCouncil workspace directory")
    .option("--json", "print machine-readable JSON output")
    .showHelpAfterError();

  registerCommands(program);
  return program;
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  await createCli().parseAsync([...argv]);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;

if (import.meta.url === entrypoint) {
  main().catch(handleCliError);
}
