import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentId } from "../config/schema.js";
import type { TaskSession } from "../session/index.js";
import type { TestCommandSelection } from "./detection.js";
import type { TestCommandRun } from "./runner.js";

export interface PersistedTestCommandRun extends Omit<TestCommandRun, "stderr" | "stdout"> {
  resultPath: string;
  stderrPath: string;
  stdoutPath: string;
}

export interface AgentTestSummary {
  agentId: AgentId;
  commands: PersistedTestCommandRun[];
  completedAt: string;
  durationMs: number;
  setupCommands: PersistedTestCommandRun[];
  status: "passed" | "failed" | "skipped";
  summaryJsonPath: string;
  testsPassed: boolean;
  worktreePath: string;
}

export interface TestSessionSummary {
  commandSelection: TestCommandSelection;
  completedAt: string;
  markdownPath: string;
  sessionId: string;
  status: "passed" | "failed" | "skipped";
  summaries: AgentTestSummary[];
  summaryJsonPath: string;
}

export async function saveAgentTestSummary(options: {
  agentId: AgentId;
  runs: readonly TestCommandRun[];
  session: TaskSession;
  setupRuns?: readonly TestCommandRun[];
  worktreePath: string;
}): Promise<AgentTestSummary> {
  const testsDir = path.join(options.session.paths.testsDir, options.agentId);
  await mkdir(testsDir, { recursive: true });

  const setupCommands = await persistRuns({
    basename: "setup-command",
    runs: options.setupRuns ?? [],
    testsDir
  });
  const commands = await persistRuns({
    basename: "command",
    runs: options.runs,
    testsDir
  });

  const summaryJsonPath = path.join(testsDir, "summary.json");
  const allRuns = [...setupCommands, ...commands];
  const setupPassed = setupCommands.every((run) => run.status === "passed");
  const testCommandsPassed = commands.length > 0 && commands.every((run) => run.status === "passed");
  const durationMs = allRuns.reduce((total, run) => total + run.durationMs, 0);
  const testsPassed = setupPassed && testCommandsPassed;
  const status = allRuns.length === 0 ? "skipped" : testsPassed ? "passed" : "failed";
  const completedAt = new Date().toISOString();
  const summary: AgentTestSummary = {
    agentId: options.agentId,
    commands,
    completedAt,
    durationMs,
    setupCommands,
    status,
    summaryJsonPath,
    testsPassed,
    worktreePath: options.worktreePath
  };

  await writeFile(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

async function persistRuns(options: {
  basename: string;
  runs: readonly TestCommandRun[];
  testsDir: string;
}): Promise<PersistedTestCommandRun[]> {
  const persistedRuns: PersistedTestCommandRun[] = [];

  for (const [index, run] of options.runs.entries()) {
    const commandIndex = index + 1;
    const stdoutPath = path.join(options.testsDir, `${options.basename}-${commandIndex}.stdout.log`);
    const stderrPath = path.join(options.testsDir, `${options.basename}-${commandIndex}.stderr.log`);
    const resultPath = path.join(options.testsDir, `${options.basename}-${commandIndex}.json`);
    const { stdout, stderr, ...summary } = run;
    const persisted = {
      ...summary,
      resultPath,
      stderrPath,
      stdoutPath
    };

    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    await writeFile(resultPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    persistedRuns.push(persisted);
  }

  return persistedRuns;
}

export async function saveTestSessionSummary(options: {
  commandSelection: TestCommandSelection;
  session: TaskSession;
  summaries: readonly AgentTestSummary[];
}): Promise<TestSessionSummary> {
  await mkdir(options.session.paths.testsDir, { recursive: true });

  const summaryJsonPath = path.join(options.session.paths.testsDir, "summary.json");
  const markdownPath = path.join(options.session.paths.testsDir, "summary.md");
  const status =
    options.summaries.length === 0
      ? "skipped"
      : options.summaries.every((summary) => summary.status === "passed")
        ? "passed"
        : "failed";
  const summary: TestSessionSummary = {
    commandSelection: options.commandSelection,
    completedAt: new Date().toISOString(),
    markdownPath,
    sessionId: options.session.id,
    status,
    summaries: [...options.summaries],
    summaryJsonPath
  };

  await writeFile(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderTestSummaryMarkdown(summary), "utf8");
  return summary;
}

export function renderTestSummaryMarkdown(summary: TestSessionSummary): string {
  const lines = [
    `# Test Summary`,
    "",
    `Session: ${summary.sessionId}`,
    `Status: ${summary.status}`,
    `Command source: ${summary.commandSelection.source}`,
    "",
    "| Agent | Status | Mode | Setup | Commands | Duration |",
    "| --- | --- | --- | ---: | ---: | --- |"
  ];

  for (const agentSummary of summary.summaries) {
    const modes = unique(
      [...agentSummary.setupCommands, ...agentSummary.commands].map((command) => command.executionMode)
    );
    lines.push(
      `| ${agentSummary.agentId} | ${agentSummary.status} | ${modes.join(", ") || "n/a"} | ${agentSummary.setupCommands.length} | ${agentSummary.commands.length} | ${formatDuration(agentSummary.durationMs)} |`
    );
  }

  lines.push("", "## Setup Commands", "");

  for (const agentSummary of summary.summaries) {
    lines.push(`### ${agentSummary.agentId}`, "");

    for (const command of agentSummary.setupCommands) {
      lines.push(
        `- \`${command.commandLine}\`: ${command.status} (${command.executionMode}, ${formatDuration(command.durationMs)}, exit ${command.exitCode ?? "n/a"})`
      );
    }

    if (agentSummary.setupCommands.length === 0) {
      lines.push("- No setup commands were run.");
    }

    lines.push("");
  }

  lines.push("## Test Commands", "");

  for (const agentSummary of summary.summaries) {
    lines.push(`### ${agentSummary.agentId}`, "");

    for (const command of agentSummary.commands) {
      lines.push(
        `- \`${command.commandLine}\`: ${command.status} (${command.executionMode}, ${formatDuration(command.durationMs)}, exit ${command.exitCode ?? "n/a"})`
      );
    }

    if (agentSummary.commands.length === 0) {
      lines.push("- No commands were run.");
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
