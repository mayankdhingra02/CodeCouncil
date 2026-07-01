import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentId } from "../config/schema.js";
import type { WorktreeOperationResult } from "../git/index.js";
import type { FileChangeSafetyResult } from "../safety/fileChanges.js";
import type { ImplementationOutput } from "../agents/index.js";
import type { TaskSession } from "../session/index.js";

export interface ImplementationArtifacts {
  implementationJsonPath: string;
  rawOutputPath?: string;
}

export interface SaveImplementationArtifactsOptions {
  agentId: AgentId;
  changedFiles: readonly string[];
  commitSha?: string;
  diffPath: string;
  output: ImplementationOutput;
  safety: FileChangeSafetyResult;
  session: TaskSession;
  status: "success" | "failed" | "blocked";
  worktree: WorktreeOperationResult;
}

export async function saveImplementationArtifacts(
  options: SaveImplementationArtifactsOptions
): Promise<ImplementationArtifacts> {
  const agentRunDir = path.join(options.session.paths.sessionDir, "runs", options.agentId);
  await mkdir(agentRunDir, { recursive: true });

  const implementationJsonPath = path.join(agentRunDir, "implementation.json");
  const rawOutputPath = path.join(agentRunDir, "implementation.raw.txt");

  await writeFile(
    implementationJsonPath,
    `${JSON.stringify(
      {
        agentId: options.agentId,
        changedFiles: options.changedFiles,
        commitSha: options.commitSha,
        diffPath: options.diffPath,
        output: options.output,
        safety: options.safety,
        status: options.status,
        worktree: options.worktree
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  if (options.output.rawOutput) {
    await writeFile(
      rawOutputPath,
      [
        "STDOUT",
        options.output.rawOutput.stdout,
        "",
        "STDERR",
        options.output.rawOutput.stderr,
        ""
      ].join("\n"),
      "utf8"
    );

    return {
      implementationJsonPath,
      rawOutputPath
    };
  }

  return {
    implementationJsonPath
  };
}

