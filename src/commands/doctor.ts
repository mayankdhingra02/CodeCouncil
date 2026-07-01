import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";

import { AgentRegistry, ExecaAgentCommandRunner } from "../agents/index.js";
import { GitManager } from "../git/index.js";
import { selectTestCommands } from "../testing/index.js";
import { writeResult } from "./context.js";
import { formatConfigSource, loadRuntimeContext, relativeToCwd } from "./shared.js";

export interface DoctorCheck {
  details?: Record<string, unknown>;
  message: string;
  name: string;
  status: "ok" | "warning" | "error";
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check local CodeCouncil environment, git, agents, tests, and workspace access.")
    .action(async (_options: Record<string, never>, command: Command) => {
      const runtime = await loadRuntimeContext(command);
      const checks = await runDoctorChecks({
        rootDir: runtime.loadedConfig.rootDir,
        testCommands: runtime.loadedConfig.config.testCommands,
        workspaceDir: runtime.loadedConfig.config.workspaceDir
      });

      writeResult(
        runtime.commandContext,
        {
          checks,
          command: "doctor",
          config: formatConfigSource(runtime.loadedConfig),
          rootDir: runtime.loadedConfig.rootDir
        },
        [
          "CodeCouncil doctor",
          `Config: ${formatConfigSource(runtime.loadedConfig)}`,
          `Root: ${relativeToCwd(runtime.commandContext, runtime.loadedConfig.rootDir)}`,
          "",
          ...checks.map((check) => `${formatStatus(check.status)} ${check.name}: ${check.message}`)
        ]
      );
    });
}

export async function runDoctorChecks(input: {
  rootDir: string;
  testCommands: readonly string[];
  workspaceDir: string;
}): Promise<DoctorCheck[]> {
  const runner = new ExecaAgentCommandRunner();
  const checks: DoctorCheck[] = [];

  checks.push(await checkCommand(runner, "git", "Git CLI"));
  checks.push(await checkRepository(input.rootDir));
  checks.push(await checkCommand(runner, "codex", "OpenAI Codex CLI"));
  checks.push(await checkCommand(runner, "claude", "Anthropic Claude Code CLI"));
  checks.push(await checkConfiguredAgents(input.rootDir));
  checks.push(await checkTestCommands(input.rootDir, input.testCommands));
  checks.push(await checkWorkspaceWriteAccess(input.rootDir, input.workspaceDir));

  return checks;
}

async function checkCommand(
  runner: ExecaAgentCommandRunner,
  command: string,
  label: string
): Promise<DoctorCheck> {
  const available = await runner.isCommandAvailable(command);

  return {
    name: label,
    status: available ? "ok" : "warning",
    message: available
      ? `"${command}" is available.`
      : `"${command}" was not found on PATH. Install/authenticate it separately if you plan to use it.`
  };
}

async function checkRepository(rootDir: string): Promise<DoctorCheck> {
  let status;

  try {
    const git = new GitManager(rootDir);
    status = await git.getRepositoryStatus();
  } catch (error) {
    return {
      name: "Git repository",
      status: "warning",
      message: error instanceof Error ? error.message : "Could not inspect git repository."
    };
  }

  if (!status.insideWorkTree) {
    return {
      name: "Git repository",
      status: "warning",
      message: "Current directory is not inside a git repository."
    };
  }

  return {
    details: {
      branch: status.currentBranch,
      changedFiles: status.changedFiles
    },
    name: "Git repository",
    status: status.clean === true ? "ok" : "warning",
    message:
      status.clean === true
        ? `Repository is clean on ${status.currentBranch}.`
        : `Repository has ${status.changedFiles.length} uncommitted change(s).`
  };
}

async function checkConfiguredAgents(rootDir: string): Promise<DoctorCheck> {
  try {
    const { loadConfig } = await import("../config/loadConfig.js");
    const loaded = await loadConfig({ cwd: rootDir });
    const registry = AgentRegistry.fromConfig(loaded.config);
    const agents = registry.listEnabled();
    const availability = [];

    for (const agent of agents) {
      availability.push({
        agentId: agent.id,
        ...(await agent.checkAvailability())
      });
    }

    const unavailable = availability.filter((agent) => !agent.available);

    return {
      details: {
        agents: availability
      },
      name: "Configured agents",
      status: unavailable.length === 0 ? "ok" : "warning",
      message:
        unavailable.length === 0
          ? `${agents.length} configured agent(s) are available.`
          : `${unavailable.length} configured agent(s) are unavailable.`
    };
  } catch (error) {
    return {
      name: "Configured agents",
      status: "error",
      message: error instanceof Error ? error.message : "Could not load configured agents."
    };
  }
}

async function checkTestCommands(
  rootDir: string,
  testCommands: readonly string[]
): Promise<DoctorCheck> {
  const selection = await selectTestCommands({
    configuredCommands: testCommands,
    rootDir
  });

  if (selection.source === "config") {
    return {
      details: {
        testCommands: selection.commands
      },
      name: "Test commands",
      status: "ok",
      message: `${selection.commands.length} test command(s) configured.`
    };
  }

  if (selection.source === "detected") {
    return {
      details: {
        detectedProjects: selection.detectedProjects,
        testCommands: selection.commands
      },
      name: "Test commands",
      status: "ok",
      message: `Detected ${selection.commands.length} default test command(s).`
    };
  }

  return {
    name: "Test commands",
    status: "warning",
    message: "No test commands configured or detected."
  };
}

async function checkWorkspaceWriteAccess(
  rootDir: string,
  workspaceDir: string
): Promise<DoctorCheck> {
  const workspacePath = path.resolve(rootDir, workspaceDir);
  const probePath = path.join(workspacePath, ".doctor-write-check");

  try {
    await mkdir(workspacePath, { recursive: true });
    await writeFile(probePath, "ok\n", "utf8");
    await access(probePath);
    await unlink(probePath);

    return {
      details: {
        workspacePath
      },
      name: "Workspace write access",
      status: "ok",
      message: `Can write to ${workspaceDir}.`
    };
  } catch (error) {
    return {
      details: {
        workspacePath
      },
      name: "Workspace write access",
      status: "error",
      message: error instanceof Error ? error.message : "Workspace is not writable."
    };
  }
}

function formatStatus(status: DoctorCheck["status"]): string {
  if (status === "ok") {
    return "OK";
  }

  if (status === "warning") {
    return "WARN";
  }

  return "ERROR";
}
