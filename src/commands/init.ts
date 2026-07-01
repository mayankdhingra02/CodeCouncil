import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";

import {
  createDefaultConfig,
  DEFAULT_CODEC_COUNCIL_IGNORE,
  serializeDefaultConfig
} from "../config/defaults.js";
import { isErrnoException } from "../core/errors.js";
import { getCommandContext, writeResult } from "./context.js";
import { relativeToCwd } from "./shared.js";

interface InitOptions {
  force?: boolean;
}

interface FileWriteResult {
  path: string;
  status: "created" | "overwritten" | "skipped";
  type: "directory" | "file";
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Create starter CodeCouncil config files in the current repository.")
    .option("-f, --force", "overwrite existing CodeCouncil files")
    .action(async (options: InitOptions, command: Command) => {
      const context = getCommandContext(command);
      const force = options.force === true;
      const defaultConfig = createDefaultConfig({
        projectName: path.basename(context.cwd)
      });
      const configPath = context.configPath ?? path.join(context.cwd, "codecouncil.config.json");
      const ignorePath = path.join(context.cwd, ".codecouncilignore");
      const workspacePath = path.resolve(context.cwd, defaultConfig.workspaceDir);

      const results = [
        await writeIfAllowed(
          configPath,
          serializeDefaultConfig({
            projectName: defaultConfig.projectName
          }),
          force
        ),
        await writeIfAllowed(ignorePath, DEFAULT_CODEC_COUNCIL_IGNORE, force),
        await createDirectoryIfMissing(workspacePath)
      ];

      writeResult(
        context,
        {
          command: "init",
          files: results.map((result) => ({
            path: result.path,
            status: result.status,
            type: result.type
          }))
        },
        [
          "Initialized CodeCouncil files.",
          ...results.map(
            (result) => `${relativeToCwd(context, result.path)}: ${result.status}`
          ),
          "Next: pnpm dev -- plan \"describe the task\""
        ]
      );
    });
}

async function writeIfAllowed(
  filePath: string,
  contents: string,
  force: boolean
): Promise<FileWriteResult> {
  const exists = await pathExists(filePath);

  if (exists && !force) {
    return {
      path: filePath,
      status: "skipped",
      type: "file"
    };
  }

  await writeFile(filePath, contents, "utf8");

  return {
    path: filePath,
    status: exists ? "overwritten" : "created",
    type: "file"
  };
}

async function createDirectoryIfMissing(directoryPath: string): Promise<FileWriteResult> {
  const exists = await pathExists(directoryPath);

  if (exists) {
    return {
      path: directoryPath,
      status: "skipped",
      type: "directory"
    };
  }

  await mkdir(directoryPath, { recursive: true });

  return {
    path: directoryPath,
    status: "created",
    type: "directory"
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}
