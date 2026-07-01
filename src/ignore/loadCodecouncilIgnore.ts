import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Ignore } from "ignore";

import { CodeCouncilError, isErrnoException } from "../core/errors.js";

type IgnoreFactory = () => Ignore;

const require = createRequire(import.meta.url);
const createIgnore = require("ignore") as IgnoreFactory;

export interface LoadedCodecouncilIgnore {
  patterns: string[];
  ignores(filePath: string): boolean;
  path?: string;
}

export function parseCodecouncilIgnore(
  source: string,
  extraPatterns: readonly string[] = []
): string[] {
  return [
    ...extraPatterns,
    ...source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
  ];
}

export async function loadCodecouncilIgnore(
  cwd: string,
  ignoreFileName = ".codecouncilignore",
  extraPatterns: readonly string[] = []
): Promise<LoadedCodecouncilIgnore> {
  const ignorePath = path.resolve(cwd, ignoreFileName);

  try {
    const source = await readFile(ignorePath, "utf8");
    const patterns = parseCodecouncilIgnore(source, extraPatterns);
    const matcher = createIgnore().add(patterns);

    return {
      patterns,
      path: ignorePath,
      ignores(filePath: string): boolean {
        return matcher.ignores(toRelativePosixPath(cwd, filePath));
      }
    };
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      const matcher = createIgnore().add(extraPatterns);

      return {
        patterns: [...extraPatterns],
        ignores(filePath: string): boolean {
          return matcher.ignores(toRelativePosixPath(cwd, filePath));
        }
      };
    }

    throw new CodeCouncilError(`Could not read ignore file at ${ignorePath}.`, {
      cause: error,
      code: "IGNORE_READ_ERROR",
      exitCode: 2
    });
  }
}

function toRelativePosixPath(cwd: string, filePath: string): string {
  const relativePath = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath;
  return relativePath.split(path.sep).join("/");
}
