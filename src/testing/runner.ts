import { execa } from "execa";

import { CodeCouncilError } from "../core/errors.js";
import { redactSecrets } from "../core/redact.js";
import { classifyDangerousCommand } from "../safety/index.js";
import { parseCommandLine } from "./commandLine.js";

export type TestCommandStatus = "passed" | "failed" | "error";
export type TestExecutionMode = "host" | "container";
export type TestCommandPhase = "setup" | "test";
export type TestContainerNetworkMode = "default" | "none";

export interface TestCommandContainerMetadata {
  containerName: string;
  dockerCommand: string;
  image: string;
  mountPath: string;
  network: TestContainerNetworkMode;
  user?: string;
  workdir: string;
}

export interface TestCommandRun {
  args: string[];
  command: string;
  container?: TestCommandContainerMetadata;
  commandLine: string;
  completedAt: string;
  cwd: string;
  durationMs: number;
  error?: string;
  executionMode: TestExecutionMode;
  exitCode?: number;
  phase: TestCommandPhase;
  startedAt: string;
  status: TestCommandStatus;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export interface RunTestCommandOptions {
  commandLine: string;
  cwd: string;
  timeoutMs: number;
}

export interface RunContainerizedTestCommandOptions extends RunTestCommandOptions {
  containerName: string;
  dockerCommand?: string;
  image: string;
  network: TestContainerNetworkMode;
  phase?: TestCommandPhase;
}

const CONTAINER_WORKDIR = "/workspace";
const DEFAULT_DOCKER_COMMAND = "docker";

export async function runTestCommand(options: RunTestCommandOptions): Promise<TestCommandRun> {
  const riskyCommands = classifyDangerousCommand(options.commandLine).filter(
    (finding) => finding.severity === "high" || finding.severity === "critical"
  );

  if (riskyCommands.length > 0) {
    const startedAt = new Date().toISOString();
    return {
      args: [],
      command: "",
      commandLine: options.commandLine,
      completedAt: startedAt,
      cwd: options.cwd,
      durationMs: 0,
      error: `Refused risky test command: ${riskyCommands.map((finding) => finding.reason).join(", ")}`,
      executionMode: "host",
      phase: "test",
      startedAt,
      status: "error",
      stderr: "",
      stdout: "",
      timedOut: false
    };
  }

  const parsed = parseCommandLine(options.commandLine);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  try {
    const result = await execa(parsed.command, parsed.args, {
      cwd: options.cwd,
      reject: false,
      shell: false,
      timeout: options.timeoutMs
    });
    const completed = Date.now();
    const exitCode = result.exitCode ?? 1;
    const timedOut = result.timedOut === true;

    return {
      args: parsed.args,
      command: parsed.command,
      commandLine: options.commandLine,
      completedAt: new Date(completed).toISOString(),
      cwd: options.cwd,
      durationMs: completed - started,
      ...(timedOut ? { error: "Test command timed out." } : {}),
      executionMode: "host",
      exitCode,
      phase: "test",
      startedAt,
      status: timedOut ? "error" : exitCode === 0 ? "passed" : "failed",
      stderr: redactSecrets(result.stderr),
      stdout: redactSecrets(result.stdout),
      timedOut
    };
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
    const timedOut = maybeError.timedOut === true || maybeError.isTerminated === true;
    const run: TestCommandRun = {
      args: parsed.args,
      command: parsed.command,
      commandLine: options.commandLine,
      completedAt: new Date(completed).toISOString(),
      cwd: options.cwd,
      durationMs: completed - started,
      error: redactSecrets(maybeError.shortMessage ?? "Test command failed."),
      executionMode: "host",
      phase: "test",
      startedAt,
      status: "error",
      stderr: redactSecrets(maybeError.stderr ?? ""),
      stdout: redactSecrets(maybeError.stdout ?? ""),
      timedOut
    };

    if (maybeError.exitCode !== undefined) {
      run.exitCode = maybeError.exitCode;
      run.status = maybeError.exitCode === 0 ? "passed" : "failed";
    }

    return run;
  }
}

export async function runContainerizedTestCommand(
  options: RunContainerizedTestCommandOptions
): Promise<TestCommandRun> {
  const dockerCommand = options.dockerCommand ?? getDockerCommand();
  const phase = options.phase ?? "test";
  const riskyCommands = classifyDangerousCommand(options.commandLine).filter(
    (finding) => finding.severity === "high" || finding.severity === "critical"
  );

  if (riskyCommands.length > 0) {
    const startedAt = new Date().toISOString();
    return {
      args: [],
      command: dockerCommand,
      commandLine: options.commandLine,
      completedAt: startedAt,
      container: buildContainerMetadata({
        containerName: options.containerName,
        dockerCommand,
        image: options.image,
        mountPath: options.cwd,
        network: options.network
      }),
      cwd: options.cwd,
      durationMs: 0,
      error: `Refused risky test command: ${riskyCommands.map((finding) => finding.reason).join(", ")}`,
      executionMode: "container",
      phase,
      startedAt,
      status: "error",
      stderr: "",
      stdout: "",
      timedOut: false
    };
  }

  const parsed = parseCommandLine(options.commandLine);
  const dockerUser = getDockerUser();
  const dockerArgs = buildDockerRunArgs({
    commandArgs: parsed.args,
    command: parsed.command,
    containerName: options.containerName,
    image: options.image,
    mountPath: options.cwd,
    network: options.network,
    ...(dockerUser ? { user: dockerUser } : {})
  });
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const container = buildContainerMetadata({
    containerName: options.containerName,
    dockerCommand,
    image: options.image,
    mountPath: options.cwd,
    network: options.network
  });

  try {
    const result = await execa(dockerCommand, dockerArgs, {
      cwd: options.cwd,
      reject: false,
      shell: false,
      timeout: options.timeoutMs
    });
    const completed = Date.now();
    const exitCode = result.exitCode ?? 1;
    const timedOut = result.timedOut === true;

    if (timedOut) {
      await killContainer(dockerCommand, options.containerName);
    }

    return {
      args: dockerArgs,
      command: dockerCommand,
      commandLine: options.commandLine,
      completedAt: new Date(completed).toISOString(),
      container,
      cwd: options.cwd,
      durationMs: completed - started,
      ...(timedOut ? { error: "Containerized test command timed out." } : {}),
      executionMode: "container",
      exitCode,
      phase,
      startedAt,
      status: timedOut ? "error" : exitCode === 0 ? "passed" : "failed",
      stderr: redactSecrets(result.stderr),
      stdout: redactSecrets(result.stdout),
      timedOut
    };
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
    const timedOut = maybeError.timedOut === true || maybeError.isTerminated === true;

    if (timedOut) {
      await killContainer(dockerCommand, options.containerName);
    }

    const run: TestCommandRun = {
      args: dockerArgs,
      command: dockerCommand,
      commandLine: options.commandLine,
      completedAt: new Date(completed).toISOString(),
      container,
      cwd: options.cwd,
      durationMs: completed - started,
      error: redactSecrets(maybeError.shortMessage ?? "Containerized test command failed."),
      executionMode: "container",
      phase,
      startedAt,
      status: "error",
      stderr: redactSecrets(maybeError.stderr ?? ""),
      stdout: redactSecrets(maybeError.stdout ?? ""),
      timedOut
    };

    if (maybeError.exitCode !== undefined) {
      run.exitCode = maybeError.exitCode;
      run.status = maybeError.exitCode === 0 ? "passed" : "failed";
    }

    return run;
  }
}

export async function assertDockerTestRuntimeAvailable(options: {
  dockerCommand?: string;
  image: string;
}): Promise<void> {
  const dockerCommand = options.dockerCommand ?? getDockerCommand();
  let versionResult;

  try {
    versionResult = await execa(dockerCommand, ["version", "--format", "{{.Server.Version}}"], {
      reject: false,
      shell: false,
      timeout: 10_000
    });
  } catch {
    throw new CodeCouncilError(
      `Docker is not available. Install Docker, start Docker, or rerun without --container.`,
      {
        code: "DOCKER_UNAVAILABLE",
        exitCode: 2
      }
    );
  }

  if ((versionResult.exitCode ?? 1) !== 0) {
    throw new CodeCouncilError(
      `Docker is installed but not ready: ${redactSecrets(versionResult.stderr || versionResult.stdout || "docker version failed")}. Start Docker or rerun without --container.`,
      {
        code: "DOCKER_UNAVAILABLE",
        exitCode: 2
      }
    );
  }

  const imageResult = await execa(dockerCommand, ["image", "inspect", options.image], {
    reject: false,
    shell: false,
    timeout: 10_000
  });

  if ((imageResult.exitCode ?? 1) !== 0) {
    throw new CodeCouncilError(
      `Docker image "${options.image}" is not available locally. Pull or build it explicitly, configure testContainer.image, or rerun without --container. CodeCouncil does not pull images automatically.`,
      {
        code: "DOCKER_IMAGE_UNAVAILABLE",
        exitCode: 2
      }
    );
  }
}

export function buildDockerRunArgs(options: {
  command: string;
  commandArgs: readonly string[];
  containerName: string;
  image: string;
  mountPath: string;
  network: TestContainerNetworkMode;
  user?: string;
}): string[] {
  const args = [
    "run",
    "--rm",
    "--pull",
    "never",
    "--init",
    "--name",
    options.containerName
  ];

  if (options.network === "none") {
    args.push("--network", "none");
  }

  if (options.user) {
    args.push("--user", options.user);
  }

  args.push(
    "--workdir",
    CONTAINER_WORKDIR,
    "--volume",
    `${options.mountPath}:${CONTAINER_WORKDIR}`,
    "--env",
    "CI=1",
    "--env",
    "HOME=/tmp",
    options.image,
    options.command,
    ...options.commandArgs
  );

  return args;
}

function buildContainerMetadata(options: {
  containerName: string;
  dockerCommand: string;
  image: string;
  mountPath: string;
  network: TestContainerNetworkMode;
}): TestCommandContainerMetadata {
  const user = getDockerUser();
  return {
    containerName: options.containerName,
    dockerCommand: options.dockerCommand,
    image: options.image,
    mountPath: options.mountPath,
    network: options.network,
    workdir: CONTAINER_WORKDIR,
    ...(user ? { user } : {})
  };
}

function getDockerCommand(): string {
  return process.env.CODECOUNCIL_DOCKER_COMMAND?.trim() || DEFAULT_DOCKER_COMMAND;
}

function getDockerUser(): string | undefined {
  if (process.platform === "win32") {
    return undefined;
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const gid = typeof process.getgid === "function" ? process.getgid() : undefined;

  if (uid === undefined || gid === undefined) {
    return undefined;
  }

  return `${uid}:${gid}`;
}

async function killContainer(dockerCommand: string, containerName: string): Promise<void> {
  await execa(dockerCommand, ["kill", containerName], {
    reject: false,
    shell: false,
    timeout: 10_000
  });
  await execa(dockerCommand, ["rm", "-f", containerName], {
    reject: false,
    shell: false,
    timeout: 10_000
  });
}
