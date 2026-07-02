import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AgentRegistry, savePlanArtifacts } from "../src/agents/index.js";
import type {
  AgentCommandResult,
  AgentCommandRunner,
  AgentCommandRunOptions,
  PlanOutput
} from "../src/agents/index.js";
import { createCli } from "../src/cli.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import { CodeCouncilError } from "../src/core/errors.js";
import { createTaskSession } from "../src/session/index.js";
import type { EventLogEntry, TaskSession } from "../src/session/index.js";

describe("AgentRegistry", () => {
  it("loads enabled mock agents from config", () => {
    const registry = AgentRegistry.fromConfig(
      createDefaultConfig({
        projectName: "agent-test"
      })
    );

    expect(registry.listEnabled().map((agent) => agent.id)).toEqual([
      "mock-codex",
      "mock-claude"
    ]);
  });

  it("rejects enabled agents without registered adapters", () => {
    const config = createDefaultConfig({
      projectName: "agent-test"
    });
    config.agents = {
      gemini: {
        enabled: true,
        command: "gemini",
        models: {},
        planArgs: [],
        implementArgs: [],
        reconcileArgs: [],
        reviewArgs: [],
        maxRuntimeSeconds: 900
      }
    };

    expect(() => AgentRegistry.fromConfig(config)).toThrow(CodeCouncilError);
    expect(() => AgentRegistry.fromConfig(config)).toThrow("no adapter is registered");
  });

  it("decouples configured agent ids from adapter ids", () => {
    const config = createDefaultConfig({
      projectName: "agent-test"
    });
    config.agents = {
      "codex-fast": {
        adapter: "codex",
        enabled: true,
        command: "codex",
        model: "gpt-5.4-mini",
        models: {},
        planArgs: ["exec", "--json"],
        implementArgs: ["exec", "--json"],
        reconcileArgs: ["exec", "--json"],
        reviewArgs: ["exec", "--json"],
        maxRuntimeSeconds: 120
      },
      "codex-reviewer": {
        adapter: "codex",
        enabled: true,
        command: "codex",
        model: "gpt-5.5",
        models: {},
        planArgs: ["exec", "--json"],
        implementArgs: ["exec", "--json"],
        reconcileArgs: ["exec", "--json"],
        reviewArgs: ["exec", "--json"],
        maxRuntimeSeconds: 120
      }
    };

    const agents = AgentRegistry.fromConfig(config, new FakeRunner(true)).listEnabled();

    expect(agents.map((agent) => agent.id)).toEqual(["codex-fast", "codex-reviewer"]);
    expect(agents.map((agent) => agent.displayName)).toEqual([
      "OpenAI Codex CLI",
      "OpenAI Codex CLI"
    ]);
  });

  it("loads real Codex and Claude adapters when configured", () => {
    const config = createDefaultConfig({
      projectName: "agent-test"
    });
    const runner = new FakeRunner(true);
    config.agents = {
      codex: {
        enabled: true,
        command: "codex",
        models: {},
        planArgs: ["exec", "--json"],
        implementArgs: ["exec", "--json"],
        reconcileArgs: ["exec", "--json"],
        reviewArgs: ["exec", "--json"],
        maxRuntimeSeconds: 120
      },
      claude: {
        enabled: true,
        command: "claude",
        models: {},
        planArgs: ["-p", "--output-format", "stream-json"],
        implementArgs: ["-p", "--output-format", "stream-json"],
        reconcileArgs: ["-p", "--output-format", "stream-json"],
        reviewArgs: ["-p", "--output-format", "stream-json"],
        maxRuntimeSeconds: 120
      }
    };

    const agents = AgentRegistry.fromConfig(config, runner).listEnabled();

    expect(agents.map((agent) => agent.id)).toEqual(["codex", "claude"]);
    expect(agents.map((agent) => agent.displayName)).toEqual([
      "OpenAI Codex CLI",
      "Anthropic Claude Code CLI"
    ]);
  });
});

describe("mock agents", () => {
  it("return structured but distinct plans", async () => {
    const rootDir = await makeTempDir();
    const config = createDefaultConfig({
      projectName: "agent-test"
    });
    const session = await createTaskSession({
      config,
      rootDir,
      task: "Add planning support",
      now: new Date("2026-07-01T12:34:56.000Z")
    });
    const [mockCodex, mockClaude] = AgentRegistry.fromConfig(config).listEnabled();

    if (!mockCodex || !mockClaude) {
      throw new Error("Expected both mock agents to be registered.");
    }

    const codexPlan = await mockCodex.generatePlan({
      config,
      repoRoot: rootDir,
      session,
      task: session.task
    });
    const claudePlan = await mockClaude.generatePlan({
      config,
      repoRoot: rootDir,
      session,
      task: session.task
    });

    expect(codexPlan).toMatchObject({
      agentId: "mock-codex",
      displayName: "Mock Codex",
      estimatedComplexity: "medium"
    });
    expect(codexPlan.stepByStepPlan.length).toBeGreaterThan(0);
    expect(codexPlan.confidence).toBeGreaterThan(0);
    expect(claudePlan.summary).not.toEqual(codexPlan.summary);
    expect(claudePlan.risks).not.toEqual(codexPlan.risks);
  });

  it("persists plan JSON and markdown artifacts", async () => {
    const { rootDir, session } = await createSessionFixture();
    const [agent] = AgentRegistry.fromConfig(
      createDefaultConfig({
        projectName: "agent-test"
      })
    ).listEnabled();

    if (!agent) {
      throw new Error("Expected mock agent to be registered.");
    }

    const plan = await agent.generatePlan({
      config: createDefaultConfig({
        projectName: "agent-test"
      }),
      repoRoot: rootDir,
      session,
      task: session.task
    });

    const saved = await savePlanArtifacts(session, plan);
    const json = JSON.parse(await readFile(saved.jsonPath, "utf8")) as unknown;
    const markdown = await readFile(saved.markdownPath, "utf8");

    expect(json).toMatchObject({
      agentId: "mock-codex",
      summary: plan.summary
    });
    expect(markdown).toContain("# Mock Codex Plan");
    expect(markdown).toContain("## Risks");
  });
});

describe("real CLI adapters", () => {
  it("checks availability through the injected command runner", async () => {
    const config = createDefaultConfig({
      projectName: "agent-test"
    });
    config.agents = {
      codex: {
        enabled: true,
        command: "codex",
        models: {},
        planArgs: ["exec", "--json"],
        implementArgs: ["exec", "--json"],
        reconcileArgs: ["exec", "--json"],
        reviewArgs: ["exec", "--json"],
        maxRuntimeSeconds: 120
      }
    };

    const [agent] = AgentRegistry.fromConfig(config, new FakeRunner(false)).listEnabled();

    if (!agent) {
      throw new Error("Expected Codex agent.");
    }

    await expect(agent.checkAvailability()).resolves.toMatchObject({
      available: false,
      command: "codex"
    });
  });

  it("runs plan commands with configured args and persists raw metadata", async () => {
    const rootDir = await makeTempDir();
    const config = createDefaultConfig({
      projectName: "agent-test"
    });
    config.agents = {
      codex: {
        enabled: true,
        command: "codex",
        models: {
          plan: "gpt-5.4-mini"
        },
        planArgs: ["exec", "--json"],
        implementArgs: ["exec", "--json"],
        reconcileArgs: ["exec", "--json"],
        reviewArgs: ["exec", "--json"],
        maxRuntimeSeconds: 120
      }
    };
    const session = await createTaskSession({
      config,
      rootDir,
      task: "Add real adapter test",
      now: new Date("2026-07-01T12:34:56.000Z")
    });
    const runner = new FakeRunner(true);
    const [agent] = AgentRegistry.fromConfig(config, runner).listEnabled();

    if (!agent) {
      throw new Error("Expected Codex agent.");
    }

    const plan = await agent.generatePlan({
      config,
      repoRoot: rootDir,
      session,
      task: session.task
    });
    const saved = await savePlanArtifacts(session, plan);

    expect(runner.runs[0]).toMatchObject({
      args: expect.arrayContaining(["exec", "--json", "--model", "gpt-5.4-mini", "-"]),
      command: "codex",
      cwd: rootDir,
      input: expect.stringContaining("Add real adapter test"),
      timeoutMs: 120000
    });
    expect(runner.runs[0]?.args.join(" ")).not.toContain("Add real adapter test");
    expect(plan).toMatchObject({
      agentId: "codex",
      summary: "Use the real adapter test plan.",
      command: {
        command: "codex",
        exitCode: 0
      },
      rawOutput: {
        stderr: ""
      }
    });
    expect(saved.rawOutputPath).toBeDefined();
    expect(saved.metadataPath).toBeDefined();
    expect(saved.parsedOutputPath).toBeDefined();
    await expect(readFile(saved.rawOutputPath ?? "", "utf8")).resolves.toContain(
      "Use the real adapter test plan."
    );
  });

  it("runs reconciliation commands with configured args and stdin prompts", async () => {
    const rootDir = await makeTempDir();
    const config = createDefaultConfig({
      projectName: "agent-test"
    });
    config.agents = {
      codex: {
        enabled: true,
        command: "codex",
        models: {
          reconcile: "gpt-5.5"
        },
        planArgs: ["exec", "--json"],
        implementArgs: ["exec", "--json"],
        reconcileArgs: ["exec", "--json", "--sandbox", "read-only"],
        reviewArgs: ["exec", "--json"],
        maxRuntimeSeconds: 120
      }
    };
    const session = await createTaskSession({
      config,
      rootDir,
      task: "Merge competing plans",
      now: new Date("2026-07-01T12:34:56.000Z")
    });
    const runner = new FakeRunner(true);
    const [agent] = AgentRegistry.fromConfig(config, runner).listEnabled();

    if (!agent) {
      throw new Error("Expected Codex agent.");
    }

    const reconciliation = await agent.reconcilePlans({
      comparison: {
        majorDisagreements: ["Different file boundaries."]
      },
      config,
      plans: [
        {
          alias: "agent-a",
          plan: makePlanOutput("agent-a")
        },
        {
          alias: "agent-b",
          plan: makePlanOutput("agent-b")
        }
      ],
      repoRoot: rootDir,
      session,
      task: session.task
    });

    expect(runner.runs[0]).toMatchObject({
      args: expect.arrayContaining(["exec", "--json", "--sandbox", "read-only", "--model", "gpt-5.5", "-"]),
      command: "codex",
      cwd: rootDir,
      input: expect.stringContaining("plan reconciler"),
      timeoutMs: 120000
    });
    expect(runner.runs[0]?.args.join(" ")).not.toContain("Merge competing plans");
    expect(reconciliation).toMatchObject({
      reconcilerAgentId: "codex",
      mergedPlan: {
        summary: "Use the reconciled adapter test plan."
      },
      resolutions: [
        expect.objectContaining({
          chosenAgentId: "synthesis"
        })
      ]
    });
  });
});

describe("codecouncil plan with mocks", () => {
  it("persists mock plans and logs plan events through the CLI", async () => {
    const cwd = await makeTempDir();
    const stdout = await runCli(["--cwd", cwd, "--json", "plan", "Add mock planning"]);
    const payload = JSON.parse(stdout) as {
      agents: string[];
      artifacts: Array<{ agentId: string; jsonPath: string; markdownPath: string }>;
      sessionDir: string;
      sessionId: string;
      status: string;
    };

    expect(payload).toMatchObject({
      agents: ["mock-codex", "mock-claude"],
      status: "success"
    });
    expect(payload.sessionId).toContain("add-mock-planning");
    expect(payload.artifacts.map((artifact) => artifact.agentId)).toEqual([
      "mock-codex",
      "mock-claude"
    ]);

    for (const artifact of payload.artifacts) {
      await expect(readFile(artifact.jsonPath, "utf8")).resolves.toContain(artifact.agentId);
      await expect(readFile(artifact.markdownPath, "utf8")).resolves.toContain("## Summary");
    }

    const events = await readEvents(path.join(payload.sessionDir, "events.jsonl"));

    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "plan.started",
      "agent.plan.started",
      "agent.plan.completed",
      "agent.plan.started",
      "agent.plan.completed",
      "plan.completed"
    ]);
  });
});

async function createSessionFixture(): Promise<{
  rootDir: string;
  session: TaskSession;
}> {
  const rootDir = await makeTempDir();
  const config = createDefaultConfig({
    projectName: "agent-test"
  });
  const session = await createTaskSession({
    config,
    rootDir,
    task: "Add planning support",
    now: new Date("2026-07-01T12:34:56.000Z")
  });

  return {
    rootDir,
    session
  };
}

async function readEvents(eventsPath: string): Promise<EventLogEntry[]> {
  return (await readFile(eventsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as EventLogEntry);
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

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "codecouncil-agents-"));
}

function makePlanOutput(agentId: string): PlanOutput {
  return {
    agentId,
    displayName: agentId,
    generatedAt: "2026-07-01T12:34:56.000Z",
    summary: `${agentId} summary`,
    assumptions: [`${agentId} assumption`],
    proposedFilesToChange: ["src/example.ts"],
    stepByStepPlan: [`${agentId} step`],
    risks: [`${agentId} risk`],
    testsToRun: ["pnpm test"],
    estimatedComplexity: "medium",
    confidence: 0.75,
    metadata: {}
  };
}

class FakeRunner implements AgentCommandRunner {
  public readonly runs: AgentCommandRunOptions[] = [];

  public constructor(private readonly available: boolean) {}

  public async isCommandAvailable(): Promise<boolean> {
    return this.available;
  }

  public async run(options: AgentCommandRunOptions): Promise<AgentCommandResult> {
    this.runs.push(options);
    const stdout = options.input?.includes("plan reconciler")
      ? JSON.stringify({
          mergedPlan: {
            summary: "Use the reconciled adapter test plan.",
            assumptions: ["The fake runner simulates reconciliation output."],
            files: ["src/agents/cliAgents.ts"],
            steps: ["Run the configured non-interactive reconciliation command."],
            risks: ["Real CLI output shape may vary."],
            tests: ["pnpm test"],
            estimatedComplexity: "medium"
          },
          resolutions: [
            {
              disagreement: "Different file boundaries.",
              chosenAgentId: "synthesis",
              rationale: "Combine both plans after checking the local file boundary.",
              evidence: ["src/agents/cliAgents.ts"]
            }
          ],
          rejectedIdeas: [],
          openQuestionsForHuman: [],
          confidence: 0.83
        })
      : JSON.stringify({
          summary: "Use the real adapter test plan.",
          assumptions: ["The fake runner simulates CLI output."],
          proposedFilesToChange: ["src/agents/cliAgents.ts"],
          stepByStepPlan: ["Run the configured non-interactive command."],
          risks: ["Real CLI output shape may vary."],
          testsToRun: ["pnpm test"],
          estimatedComplexity: "medium",
          confidence: 0.81
        });

    return {
      args: [...options.args],
      command: options.command,
      completedAt: "2026-07-01T12:35:00.000Z",
      cwd: options.cwd,
      durationMs: 42,
      exitCode: 0,
      stderr: "",
      stdout,
      timedOut: false,
      startedAt: "2026-07-01T12:34:59.958Z"
    };
  }
}
