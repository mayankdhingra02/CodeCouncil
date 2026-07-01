import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";

import type { AgentId } from "../config/schema.js";
import { CodeCouncilError, isErrnoException } from "../core/errors.js";
import { resolveSelectedAgents, type SelectedAgentConfig } from "../core/agentSelection.js";
import {
  calculateImplementationScore,
  saveImplementationScores,
  type ImplementationScore
} from "../scoring/index.js";
import { appendSessionEvent, loadTaskSession, type TaskSession } from "../session/index.js";
import {
  runTestCommand,
  saveAgentTestSummary,
  saveTestSessionSummary,
  selectTestCommands,
  type AgentTestSummary,
  type TestCommandSelection
} from "../testing/index.js";
import { writeResult } from "./context.js";
import {
  collectRepeatableOption,
  formatConfigSource,
  loadRuntimeContext,
  relativeToCwd
} from "./shared.js";

interface TestOptions {
  agent?: string[];
  agents?: string;
  command?: string[];
  session?: string;
  timeoutSeconds?: string;
}

interface AgentTestCliSummary {
  agentId: AgentId;
  changedFiles: string[];
  commands: string[];
  diffSizeBytes: number;
  durationMs: number;
  preliminaryScore: number;
  summaryJsonPath: string;
  testsPassed: boolean;
  testsRun: boolean;
  worktreePath: string;
}

interface ImplementationMetadata {
  changedFiles: string[];
  diffPath: string;
  implementationSucceeded: boolean;
  safety: {
    blockedFiles: string[];
    suspiciousFiles: string[];
  };
}

const DEFAULT_TEST_TIMEOUT_SECONDS = 600;

export function registerTestCommand(program: Command): void {
  program
    .command("test")
    .description("Run configured or detected tests against agent worktrees.")
    .option("-a, --agent <agent>", "agent id to include; repeat for multiple agents", collectRepeatableOption)
    .option("--agents <agents>", "comma-separated agent ids to include")
    .option("--command <command>", "test command to run; repeat for multiple commands", collectRepeatableOption)
    .option("--session <id>", "session id containing implementation worktrees")
    .option("--timeout-seconds <seconds>", "timeout per test command", String(DEFAULT_TEST_TIMEOUT_SECONDS))
    .action(async (options: TestOptions, command: Command) => {
      const runtime = await loadRuntimeContext(command);

      if (!options.session) {
        throw new CodeCouncilError("Testing requires --session so CodeCouncil can find agent worktrees.", {
          code: "MISSING_SESSION",
          exitCode: 2
        });
      }

      const timeoutSeconds = parseTimeoutSeconds(options.timeoutSeconds);
      const session = await loadTaskSession({
        rootDir: runtime.loadedConfig.rootDir,
        sessionId: options.session,
        workspaceDir: runtime.loadedConfig.config.workspaceDir
      });
      const selectedAgents = resolveSelectedAgents(runtime.loadedConfig.config, [
        ...(options.agent ?? []),
        ...parseAgentsOption(options.agents)
      ]);
      const worktrees = await resolveAgentWorktrees({
        agents: selectedAgents,
        repoRoot: runtime.loadedConfig.rootDir,
        session
      });
      const commandSelection = await selectTestCommands({
        configuredCommands: runtime.loadedConfig.config.testCommands,
        explicitCommands: options.command ?? [],
        rootDir: worktrees[0]?.worktreePath ?? runtime.loadedConfig.rootDir
      });

      await appendSessionEvent(session, {
        type: "tests.started",
        status: "running",
        message: "Started test phase.",
        metadata: {
          agents: selectedAgents.map((agent) => agent.id),
          commandSource: commandSelection.source,
          commands: commandSelection.commands
        }
      });

      const testSummaries: AgentTestSummary[] = [];
      const scores: ImplementationScore[] = [];
      const cliSummaries: AgentTestCliSummary[] = [];

      for (const worktree of worktrees) {
        const agentSummary = await runTestsForAgent({
          agentId: worktree.agentId,
          commandSelection,
          session,
          timeoutSeconds,
          worktreePath: worktree.worktreePath
        });
        const implementation = await loadImplementationMetadata(session, worktree.agentId);
        const diffSizeBytes = await getFileSize(implementation.diffPath);
        const score = calculateImplementationScore({
          agentId: worktree.agentId,
          blockedFiles: implementation.safety.blockedFiles,
          changedFiles: implementation.changedFiles,
          diffSizeBytes,
          implementationSucceeded: implementation.implementationSucceeded,
          suspiciousFiles: implementation.safety.suspiciousFiles,
          testsPassed: agentSummary.testsPassed,
          testsRun: agentSummary.commands.length > 0
        });

        testSummaries.push(agentSummary);
        scores.push(score);
        cliSummaries.push({
          agentId: worktree.agentId,
          changedFiles: implementation.changedFiles,
          commands: commandSelection.commands,
          diffSizeBytes,
          durationMs: agentSummary.durationMs,
          preliminaryScore: score.score,
          summaryJsonPath: agentSummary.summaryJsonPath,
          testsPassed: agentSummary.testsPassed,
          testsRun: agentSummary.commands.length > 0,
          worktreePath: worktree.worktreePath
        });
      }

      const testSessionSummary = await saveTestSessionSummary({
        commandSelection,
        session,
        summaries: testSummaries
      });
      const savedScores = await saveImplementationScores({
        scores,
        session
      });
      const status =
        testSummaries.length === 0
          ? "skipped"
          : testSummaries.every((summary) => summary.status === "passed")
            ? "success"
            : "failed";

      await appendSessionEvent(session, {
        type: "tests.completed",
        status,
        message: "Completed test phase.",
        metadata: {
          scoresPath: savedScores.jsonPath,
          summaryPath: testSessionSummary.summaryJsonPath
        }
      });

      writeResult(
        runtime.commandContext,
        {
          command: "test",
          commandSelection,
          config: formatConfigSource(runtime.loadedConfig),
          scores,
          scoresPath: savedScores.jsonPath,
          sessionId: session.id,
          status,
          summaries: cliSummaries,
          testsSummaryPath: testSessionSummary.summaryJsonPath
        },
        [
          "Test phase complete.",
          `Session: ${session.id}`,
          `Command source: ${commandSelection.source}`,
          "",
          ...renderCliTable(cliSummaries),
          "",
          `Tests summary: ${relativeToCwd(runtime.commandContext, testSessionSummary.markdownPath)}`,
          `Scores: ${relativeToCwd(runtime.commandContext, savedScores.markdownPath)}`
        ]
      );
    });
}

async function runTestsForAgent(options: {
  agentId: AgentId;
  commandSelection: TestCommandSelection;
  session: TaskSession;
  timeoutSeconds: number;
  worktreePath: string;
}): Promise<AgentTestSummary> {
  await appendSessionEvent(options.session, {
    type: "agent.tests.started",
    agentId: options.agentId,
    status: "running",
    message: `Started tests for ${options.agentId}.`,
    metadata: {
      commands: options.commandSelection.commands,
      worktreePath: options.worktreePath
    }
  });

  const runs = [];

  for (const commandLine of options.commandSelection.commands) {
    runs.push(
      await runTestCommand({
        commandLine,
        cwd: options.worktreePath,
        timeoutMs: options.timeoutSeconds * 1000
      })
    );
  }

  const summary = await saveAgentTestSummary({
    agentId: options.agentId,
    runs,
    session: options.session,
    worktreePath: options.worktreePath
  });

  await appendSessionEvent(options.session, {
    type: "agent.tests.completed",
    agentId: options.agentId,
    status: summary.status === "passed" ? "success" : summary.status,
    message:
      summary.status === "passed"
        ? `Tests passed for ${options.agentId}.`
        : summary.status === "skipped"
          ? `No tests were available for ${options.agentId}.`
          : `Tests failed for ${options.agentId}.`,
    metadata: {
      durationMs: summary.durationMs,
      summaryJsonPath: summary.summaryJsonPath
    }
  });

  return summary;
}

async function resolveAgentWorktrees(options: {
  agents: readonly SelectedAgentConfig[];
  repoRoot: string;
  session: TaskSession;
}): Promise<Array<{ agentId: AgentId; worktreePath: string }>> {
  const worktrees = [];

  for (const agent of options.agents) {
    const worktreePath = path.join(options.session.paths.worktreesDir, agent.id);

    if (path.resolve(worktreePath) === path.resolve(options.repoRoot)) {
      throw new CodeCouncilError("Refusing to run tests in the original working tree.", {
        code: "TEST_REQUIRES_WORKTREE",
        exitCode: 2
      });
    }

    try {
      await access(worktreePath);
    } catch {
      throw new CodeCouncilError(
        `No worktree exists for agent "${agent.id}" in session "${options.session.id}". Run codecouncil implement first.`,
        {
          code: "WORKTREE_NOT_FOUND",
          exitCode: 2
        }
      );
    }

    worktrees.push({
      agentId: agent.id,
      worktreePath
    });
  }

  return worktrees;
}

async function loadImplementationMetadata(
  session: TaskSession,
  agentId: AgentId
): Promise<ImplementationMetadata> {
  const implementationPath = path.join(session.paths.sessionDir, "runs", agentId, "implementation.json");
  const fallbackDiffPath = path.join(session.paths.diffsDir, `${agentId}.patch`);

  try {
    const source = await readFile(implementationPath, "utf8");
    const parsed = JSON.parse(source) as {
      changedFiles?: unknown;
      diffPath?: unknown;
      safety?: {
        blockedFiles?: unknown;
        suspiciousFiles?: unknown;
      };
      status?: unknown;
    };

    return {
      changedFiles: asStringArray(parsed.changedFiles),
      diffPath: typeof parsed.diffPath === "string" ? parsed.diffPath : fallbackDiffPath,
      implementationSucceeded: parsed.status === "success",
      safety: {
        blockedFiles: asStringArray(parsed.safety?.blockedFiles),
        suspiciousFiles: asStringArray(parsed.safety?.suspiciousFiles)
      }
    };
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }

    return {
      changedFiles: [],
      diffPath: fallbackDiffPath,
      implementationSucceeded: false,
      safety: {
        blockedFiles: [],
        suspiciousFiles: []
      }
    };
  }
}

async function getFileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return 0;
    }

    throw error;
  }
}

function parseAgentsOption(value: string | undefined): AgentId[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((agentId) => agentId.trim())
    .filter(Boolean);
}

function parseTimeoutSeconds(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_TEST_TIMEOUT_SECONDS);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CodeCouncilError("--timeout-seconds must be a positive integer.", {
      code: "INVALID_TIMEOUT",
      exitCode: 2
    });
  }

  return parsed;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function renderCliTable(summaries: readonly AgentTestCliSummary[]): string[] {
  const rows = [
    ["agent", "tests", "command", "duration", "changed", "diff", "score"],
    ...summaries.map((summary) => [
      summary.agentId,
      summary.testsRun ? (summary.testsPassed ? "passed" : "failed") : "skipped",
      summary.commands.join("; ") || "(none)",
      formatDuration(summary.durationMs),
      String(summary.changedFiles.length),
      formatBytes(summary.diffSizeBytes),
      String(summary.preliminaryScore)
    ])
  ];
  const widths = rows[0]?.map((_, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex]?.length ?? 0))
  ) ?? [];

  return rows.map((row, rowIndex) => {
    const line = row
      .map((cell, columnIndex) => cell.padEnd(widths[columnIndex] ?? cell.length))
      .join("  ");

    if (rowIndex === 0) {
      return line;
    }

    return line;
  });
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
