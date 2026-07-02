import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { savePlanArtifacts, type PlanOutput } from "../src/agents/index.js";
import { createCli } from "../src/cli.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import { calculateImplementationScore } from "../src/scoring/index.js";
import { generateSafetySummary } from "../src/safety/report.js";
import {
  approveAgentPlan,
  createTaskSession,
  type TaskSession
} from "../src/session/index.js";
import {
  buildDockerRunArgs,
  detectProjectTypes,
  runContainerizedTestCommand,
  selectTestCommands
} from "../src/testing/index.js";

describe("test detection", () => {
  it("detects supported project types and default test commands", async () => {
    const rootDir = await makeTempDir("codecouncil-detect-");

    await writeFile(path.join(rootDir, "package.json"), "{}\n", "utf8");
    await writeFile(path.join(rootDir, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");
    await writeFile(path.join(rootDir, "pyproject.toml"), "[project]\nname = 'x'\n", "utf8");
    await writeFile(path.join(rootDir, "go.mod"), "module example.test/app\n", "utf8");
    await writeFile(path.join(rootDir, "Cargo.toml"), "[package]\nname='x'\n", "utf8");
    await writeFile(path.join(rootDir, "pom.xml"), "<project />\n", "utf8");
    await writeFile(path.join(rootDir, "build.gradle"), "plugins {}\n", "utf8");
    await writeFile(path.join(rootDir, "App.csproj"), "<Project />\n", "utf8");

    const detections = await detectProjectTypes(rootDir);

    expect(detections.map((detection) => detection.type)).toEqual([
      "node",
      "python",
      "go",
      "rust",
      "maven",
      "gradle",
      "dotnet"
    ]);
    expect(detections.flatMap((detection) => detection.commands)).toEqual(
      expect.arrayContaining([
        "pnpm test",
        "pytest",
        "go test ./...",
        "cargo test",
        "mvn test",
        "./gradlew test",
        "dotnet test"
      ])
    );
  });

  it("prefers explicit and configured test commands before detection", async () => {
    const rootDir = await makeTempDir("codecouncil-select-tests-");
    await writeFile(path.join(rootDir, "package.json"), "{}\n", "utf8");

    await expect(
      selectTestCommands({
        configuredCommands: ["npm test"],
        explicitCommands: ["node custom-test.mjs"],
        rootDir
      })
    ).resolves.toMatchObject({
      commands: ["node custom-test.mjs"],
      source: "cli"
    });

    await expect(
      selectTestCommands({
        configuredCommands: ["npm test"],
        rootDir
      })
    ).resolves.toMatchObject({
      commands: ["npm test"],
      source: "config"
    });
  });
});

describe("test runner CLI", () => {
  it("builds Docker run args for containerized tests without shell interpolation", () => {
    expect(
      buildDockerRunArgs({
        command: "npm",
        commandArgs: ["test"],
        containerName: "codecouncil-test-demo",
        image: "node:20-bookworm-slim",
        mountPath: "/tmp/worktree",
        network: "none",
        user: "501:20"
      })
    ).toEqual([
      "run",
      "--rm",
      "--pull",
      "never",
      "--init",
      "--name",
      "codecouncil-test-demo",
      "--network",
      "none",
      "--user",
      "501:20",
      "--workdir",
      "/workspace",
      "--volume",
      "/tmp/worktree:/workspace",
      "--env",
      "CI=1",
      "--env",
      "HOME=/tmp",
      "node:20-bookworm-slim",
      "npm",
      "test"
    ]);
  });

  it("runs successful tests in an implementation worktree and saves scores", async () => {
    const repo = await createTempGitRepo({
      "pass-test.mjs": "console.log('pass ok');\n"
    });
    const session = await createApprovedSession(repo, "Score passing implementation");

    await runCli([
      "--cwd",
      repo,
      "implement",
      "--session",
      session.id,
      "--agents",
      "mock-codex"
    ]);
    const stdout = await runCli([
      "--cwd",
      repo,
      "--json",
      "test",
      "--session",
      session.id,
      "--agents",
      "mock-codex",
      "--command",
      "node pass-test.mjs"
    ]);
    const payload = JSON.parse(stdout) as {
      scores: Array<{ agentId: string; score: number; testsPassed: boolean }>;
      status: string;
      summaries: Array<{ testsPassed: boolean; testsRun: boolean }>;
    };

    expect(payload.status).toBe("success");
    expect(payload.summaries[0]).toMatchObject({
      testsPassed: true,
      testsRun: true
    });
    expect(payload.scores[0]).toMatchObject({
      agentId: "mock-codex",
      score: 100,
      testsPassed: true
    });

    await expect(
      readFile(path.join(session.paths.testsDir, "mock-codex", "command-1.stdout.log"), "utf8")
    ).resolves.toContain("pass ok");
    await expect(readFile(path.join(session.paths.testsDir, "summary.md"), "utf8")).resolves.toContain(
      "mock-codex"
    );
    await expect(
      readFile(path.join(session.paths.sessionDir, "scores", "implementation-scores.json"), "utf8")
    ).resolves.toContain('"score": 100');
  });

  it("records failing tests without throwing and lowers the score", async () => {
    const repo = await createTempGitRepo({
      "fail-test.mjs": "console.error('fail expected');\nprocess.exit(3);\n"
    });
    const session = await createApprovedSession(repo, "Score failing implementation");

    await runCli([
      "--cwd",
      repo,
      "implement",
      "--session",
      session.id,
      "--agents",
      "mock-codex"
    ]);
    const stdout = await runCli([
      "--cwd",
      repo,
      "--json",
      "test",
      "--session",
      session.id,
      "--agents",
      "mock-codex",
      "--command",
      "node fail-test.mjs"
    ]);
    const payload = JSON.parse(stdout) as {
      scores: Array<{ score: number; testsPassed: boolean }>;
      status: string;
      summaries: Array<{ testsPassed: boolean }>;
    };

    expect(payload.status).toBe("failed");
    expect(payload.summaries[0]?.testsPassed).toBe(false);
    expect(payload.scores[0]).toMatchObject({
      score: 65,
      testsPassed: false
    });
    await expect(
      readFile(path.join(session.paths.testsDir, "mock-codex", "command-1.stderr.log"), "utf8")
    ).resolves.toContain("fail expected");
  });

  it("fails gracefully when Docker is unavailable for containerized tests", async () => {
    const repo = await createTempGitRepo({
      "pass-test.mjs": "console.log('pass ok');\n"
    });
    const session = await createApprovedSession(repo, "Container unavailable");
    const previousDockerCommand = process.env.CODECOUNCIL_DOCKER_COMMAND;

    await runCli([
      "--cwd",
      repo,
      "implement",
      "--session",
      session.id,
      "--agents",
      "mock-codex"
    ]);

    process.env.CODECOUNCIL_DOCKER_COMMAND = "codecouncil-missing-docker";

    try {
      await expect(
        runCli([
          "--cwd",
          repo,
          "--json",
          "test",
          "--session",
          session.id,
          "--agents",
          "mock-codex",
          "--container",
          "--command",
          "node pass-test.mjs"
        ])
      ).rejects.toThrow("rerun without --container");
    } finally {
      if (previousDockerCommand === undefined) {
        delete process.env.CODECOUNCIL_DOCKER_COMMAND;
      } else {
        process.env.CODECOUNCIL_DOCKER_COMMAND = previousDockerCommand;
      }
    }
  });

  it("runs explicit container setup before offline container tests and saves separate logs", async () => {
    const repo = await createTempGitRepo({
      "pass-test.mjs": "console.log('pass ok');\n"
    });
    const session = await createApprovedSession(repo, "Container setup");
    const fakeDocker = await createFakeDocker();
    const previousDockerCommand = process.env.CODECOUNCIL_DOCKER_COMMAND;

    await runCli([
      "--cwd",
      repo,
      "implement",
      "--session",
      session.id,
      "--agents",
      "mock-codex"
    ]);

    process.env.CODECOUNCIL_DOCKER_COMMAND = fakeDocker.commandPath;

    try {
      const stdout = await runCli([
        "--cwd",
        repo,
        "--json",
        "test",
        "--session",
        session.id,
        "--agents",
        "mock-codex",
        "--container",
        "--container-image",
        "node:fake",
        "--container-setup-command",
        "node setup.js",
        "--command",
        "node pass-test.mjs"
      ]);
      const payload = JSON.parse(stdout) as {
        executionMode: string;
        status: string;
        summaries: Array<{ setupCommands: string[]; testsPassed: boolean; testsRun: boolean }>;
      };
      const summary = JSON.parse(
        await readFile(path.join(session.paths.testsDir, "mock-codex", "summary.json"), "utf8")
      ) as {
        commands: Array<{ container: { network: string }; phase: string }>;
        setupCommands: Array<{ container: { network: string }; phase: string }>;
      };

      expect(payload).toMatchObject({
        executionMode: "container",
        status: "success"
      });
      expect(payload.summaries[0]).toMatchObject({
        setupCommands: ["node setup.js"],
        testsPassed: true,
        testsRun: true
      });
      expect(summary.setupCommands).toHaveLength(1);
      expect(summary.commands).toHaveLength(1);
      expect(summary.setupCommands[0]).toMatchObject({
        container: { network: "default" },
        phase: "setup"
      });
      expect(summary.commands[0]).toMatchObject({
        container: { network: "none" },
        phase: "test"
      });
      await expect(
        readFile(path.join(session.paths.testsDir, "mock-codex", "setup-command-1.stdout.log"), "utf8")
      ).resolves.toContain("fake docker run");
    } finally {
      if (previousDockerCommand === undefined) {
        delete process.env.CODECOUNCIL_DOCKER_COMMAND;
      } else {
        process.env.CODECOUNCIL_DOCKER_COMMAND = previousDockerCommand;
      }
    }
  });

  it("kills and removes a named Docker container after a timeout", async () => {
    const fakeDocker = await createFakeDocker({
      hangRun: true
    });
    const result = await runContainerizedTestCommand({
      commandLine: "node slow-test.mjs",
      containerName: "codecouncil-test-timeout",
      cwd: await makeTempDir("codecouncil-container-timeout-"),
      dockerCommand: fakeDocker.commandPath,
      image: "node:fake",
      network: "none",
      timeoutMs: 500
    });
    const log = await readFile(fakeDocker.logPath, "utf8");

    expect(result).toMatchObject({
      executionMode: "container",
      timedOut: true
    });
    expect(log).toContain("run");
    expect(log).toContain("kill codecouncil-test-timeout");
    expect(log).toContain("rm -f codecouncil-test-timeout");
  });
});

describe("test execution safety reporting", () => {
  it("reports containerized test execution differently from host execution", async () => {
    const repo = await createTempGitRepo({});
    const session = await createApprovedSession(repo, "Container safety summary");

    await mkdir(session.paths.testsDir, { recursive: true });
    await writeFile(
      path.join(session.paths.testsDir, "summary.json"),
      JSON.stringify(
        {
          summaries: [
            {
              commands: [
                {
                  executionMode: "container"
                }
              ]
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const summary = await generateSafetySummary({
      session
    });

    expect(summary.warnings).toContain(
      "Configured test commands ran in Docker containers with the agent worktree mounted as /workspace and Docker network disabled."
    );
    expect(summary.warnings.join("\n")).not.toContain("execute code from agent worktrees on the host");
  });
});

describe("implementation scoring", () => {
  it("scores implementation quality from tests, diff size, and safety", () => {
    const score = calculateImplementationScore({
      agentId: "mock-codex",
      blockedFiles: [],
      changedFiles: ["src/a.ts", "test/a.test.ts"],
      diffSizeBytes: 2048,
      implementationSucceeded: true,
      suspiciousFiles: [],
      testsPassed: true,
      testsRun: true
    });

    expect(score.score).toBe(100);
    expect(score.components.map((component) => component.name)).toEqual([
      "Implementation",
      "Tests",
      "Safety",
      "Reviews",
      "Changed Files",
      "Diff Size"
    ]);
  });
});

async function createApprovedSession(repo: string, task: string): Promise<TaskSession> {
  const config = createDefaultConfig({
    projectName: "testing-test"
  });
  const session = await createTaskSession({
    config,
    rootDir: repo,
    task,
    now: new Date("2026-07-01T12:34:56.000Z")
  });

  await savePlanArtifacts(session, makePlan("mock-codex"));
  await approveAgentPlan(session, "mock-codex", new Date("2026-07-01T12:40:00.000Z"));

  return session;
}

function makePlan(agentId: string): PlanOutput {
  return {
    agentId,
    displayName: agentId,
    generatedAt: "2026-07-01T12:34:56.000Z",
    summary: "Approved mock implementation plan.",
    assumptions: ["The mock test repo is small."],
    proposedFilesToChange: ["CODECOUNCIL_MOCK_MOCK_CODEX.md"],
    stepByStepPlan: ["Create a harmless mock implementation artifact."],
    risks: ["None for mock implementation."],
    testsToRun: ["node pass-test.mjs"],
    estimatedComplexity: "low",
    confidence: 0.9,
    metadata: {}
  };
}

async function createTempGitRepo(files: Record<string, string>): Promise<string> {
  const repo = await makeTempDir("codecouncil-test-runner-");

  await execa("git", ["init"], {
    cwd: repo
  });
  await execa("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: repo
  });
  await writeFile(path.join(repo, ".gitignore"), ".codecouncil/\n", "utf8");
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n", "utf8");

  for (const [filePath, source] of Object.entries(files)) {
    await writeFile(path.join(repo, filePath), source, "utf8");
  }

  await execa("git", ["add", "."], {
    cwd: repo
  });
  await execa(
    "git",
    [
      "-c",
      "user.name=CodeCouncil Test",
      "-c",
      "user.email=codecouncil@example.test",
      "commit",
      "-m",
      "initial"
    ],
    {
      cwd: repo
    }
  );

  return repo;
}

async function runCli(argv: readonly string[]): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    await createCli().parseAsync(["node", "codecouncil", ...argv]);
  } finally {
    process.stdout.write = originalWrite;
  }

  return chunks.join("");
}

async function createFakeDocker(options: { hangRun?: boolean } = {}): Promise<{
  commandPath: string;
  logPath: string;
}> {
  const directory = await makeTempDir("codecouncil-fake-docker-");
  const commandPath = path.join(directory, "docker");
  const logPath = path.join(directory, "docker.log");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n");
if (args[0] === "version") {
  process.stdout.write("fake-docker\\n");
  process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect") {
  process.exit(0);
}
if (args[0] === "kill" || args[0] === "rm") {
  process.exit(0);
}
if (args[0] === "run") {
  process.stdout.write("fake docker run\\n");
  if (${options.hangRun === true ? "true" : "false"}) {
    setInterval(() => {}, 1000);
    return;
  } else {
    process.exit(0);
  }
}
process.exit(0);
`;

  await writeFile(commandPath, source, "utf8");
  await writeFile(logPath, "", "utf8");
  await chmod(commandPath, 0o755);

  return {
    commandPath,
    logPath
  };
}

async function makeTempDir(prefix: string): Promise<string> {
  await mkdir(os.tmpdir(), { recursive: true });
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}
