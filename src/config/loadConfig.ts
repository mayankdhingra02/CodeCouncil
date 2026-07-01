import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { ZodError } from "zod";

import { ConfigError, isErrnoException } from "../core/errors.js";
import { createDefaultConfig } from "./defaults.js";
import {
  CONFIG_FILE_NAMES,
  codeCouncilConfigSchema,
  type CodeCouncilConfig
} from "./schema.js";

export interface LoadConfigOptions {
  cwd: string;
  configPath?: string;
}

export interface LoadedConfig {
  config: CodeCouncilConfig;
  fromDefaults: boolean;
  rootDir: string;
  path?: string;
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const resolvedPath = options.configPath
    ? path.resolve(options.cwd, options.configPath)
    : await findConfigPath(options.cwd);

  if (!resolvedPath) {
    return {
      config: createDefaultConfig({
        projectName: path.basename(options.cwd)
      }),
      fromDefaults: true,
      rootDir: options.cwd
    };
  }

  try {
    const source = await readFile(resolvedPath, "utf8");
    const parsedJson = JSON.parse(source) as unknown;

    return {
      config: codeCouncilConfigSchema.parse(parsedJson),
      fromDefaults: false,
      path: resolvedPath,
      rootDir: path.dirname(resolvedPath)
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ConfigError(`Invalid JSON in ${resolvedPath}: ${error.message}`, error);
    }

    if (error instanceof ZodError) {
      throw new ConfigError(
        `Invalid CodeCouncil config in ${resolvedPath}: ${formatZodError(error)}`,
        error
      );
    }

    throw new ConfigError(`Could not read CodeCouncil config at ${resolvedPath}.`, error);
  }
}

async function findConfigPath(cwd: string): Promise<string | undefined> {
  let currentDir = path.resolve(cwd);

  while (true) {
    for (const configFileName of CONFIG_FILE_NAMES) {
      const candidate = path.join(currentDir, configFileName);

      if (await pathExists(candidate)) {
        return candidate;
      }
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return undefined;
    }

    currentDir = parentDir;
  }
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

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${location}: ${issue.message}`;
    })
    .join("; ");
}
