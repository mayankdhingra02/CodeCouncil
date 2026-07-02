import { access, mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createCli } from "../src/cli.js";

describe("solve workflow", () => {
  it("stops after planning by default and creates a suggested approval artifact", async () => {
    const cwd = await makeTempDir();
    const stdout = await runCli([
      "--cwd",
      cwd,
      "--json",
      "solve",
      "--agents",
      "mock-codex,mock-claude",
      "Add password reset flow"
    ]);
    const payload = JSON.parse(stdout) as {
      approvalArtifacts?: unknown;
      sessionDir: string;
      suggestedApproval: { markdownPath: string };
      workflow: { nextRecommendedCommand: string; status: string };
    };

    expect(payload.workflow.status).toBe("planned");
    expect(payload.workflow.nextRecommendedCommand).toContain("codecouncil reconcile");
    expect(payload.approvalArtifacts).toBeUndefined();
    await expect(readFile(payload.suggestedApproval.markdownPath, "utf8")).resolves.toContain(
      "Status: suggested, not yet approved"
    );
    await expect(pathExists(path.join(payload.sessionDir, "approved-plan.json"))).resolves.toBe(false);
  });

  it("auto approves the suggested plan when explicitly requested", async () => {
    const cwd = await makeTempDir();
    const stdout = await runCli([
      "--cwd",
      cwd,
      "--json",
      "solve",
      "--agents",
      "mock-codex,mock-claude",
      "--auto-approve-plan",
      "Add account lockout checks"
    ]);
    const payload = JSON.parse(stdout) as {
      approvalArtifacts: { jsonPath: string; markdownPath: string };
      workflow: { completedStages: string[]; status: string };
    };

    expect(payload.workflow.status).toBe("approved");
    expect(payload.workflow.completedStages).toEqual(["created", "planned", "approved"]);
    await expect(readFile(payload.approvalArtifacts.jsonPath, "utf8")).resolves.toContain(
      "\"approvedBy\": \"agent\""
    );
    await expect(readFile(payload.approvalArtifacts.markdownPath, "utf8")).resolves.toContain(
      "# Approved Plan"
    );
  });

  it("can reconcile during solve and auto approve the reconciled candidate", async () => {
    const cwd = await makeTempDir();
    const stdout = await runCli([
      "--cwd",
      cwd,
      "--json",
      "solve",
      "--agents",
      "mock-codex,mock-claude",
      "--reconcile",
      "rotate",
      "--auto-approve-plan",
      "Add password reset reconciliation"
    ]);
    const payload = JSON.parse(stdout) as {
      approvalArtifacts: { jsonPath: string };
      internalCommandOutputs: Array<{ stage: string; stdoutPath: string }>;
      reconcileStrategy: string;
      workflow: { artifacts: Record<string, string[]>; status: string };
    };

    expect(payload.reconcileStrategy).toBe("rotate");
    expect(payload.workflow.status).toBe("approved");
    expect(payload.workflow.artifacts["reconciledPlan"]).toHaveLength(1);
    expect(payload.workflow.artifacts["reconciliationRotation"]).toHaveLength(1);
    expect(payload.workflow.artifacts["workflowOutputs"]?.length).toBeGreaterThan(0);
    expect(payload.internalCommandOutputs.map((output) => output.stage)).toEqual(["reconcile"]);
    await expect(readFile(payload.approvalArtifacts.jsonPath, "utf8")).resolves.toContain(
      "\"approvedBy\": \"reconciled\""
    );
    await expect(readFile(payload.internalCommandOutputs[0]?.stdoutPath ?? "", "utf8")).resolves.toContain(
      "\"command\": \"reconcile\""
    );
  });

  it("resume inspects the session and suggests the next command", async () => {
    const cwd = await makeTempDir();
    const solveOutput = await runCli([
      "--cwd",
      cwd,
      "--json",
      "solve",
      "--agents",
      "mock-codex,mock-claude",
      "Add email verification"
    ]);
    const solvePayload = JSON.parse(solveOutput) as { sessionId: string };
    const resumeOutput = await runCli([
      "--cwd",
      cwd,
      "--json",
      "resume",
      "--session",
      solvePayload.sessionId
    ]);
    const resumePayload = JSON.parse(resumeOutput) as {
      workflow: { nextRecommendedCommand: string; status: string };
    };

    expect(resumePayload.workflow.status).toBe("planned");
    expect(resumePayload.workflow.nextRecommendedCommand).toContain("codecouncil reconcile");
  });

  it("dry-run does not create a session or execute agents", async () => {
    const cwd = await makeTempDir();
    const stdout = await runCli([
      "--cwd",
      cwd,
      "--json",
      "solve",
      "--dry-run",
      "--agents",
      "mock-codex,mock-claude",
      "Add CSRF protection"
    ]);
    const payload = JSON.parse(stdout) as {
      dryRun: boolean;
      plannedStages: string[];
      status: string;
    };

    expect(payload.status).toBe("dry-run");
    expect(payload.dryRun).toBe(true);
    expect(payload.plannedStages).toContain("plan");
    await expect(pathExists(path.join(cwd, ".codecouncil", "runs"))).resolves.toBe(false);
  });

  it("updates workflow state artifacts after planning", async () => {
    const cwd = await makeTempDir();
    const stdout = await runCli([
      "--cwd",
      cwd,
      "--json",
      "solve",
      "--agents",
      "mock-codex,mock-claude",
      "Add audit logging"
    ]);
    const payload = JSON.parse(stdout) as {
      workflowPath: string;
    };
    const workflow = JSON.parse(await readFile(payload.workflowPath, "utf8")) as {
      artifacts: Record<string, string[]>;
      completedStages: string[];
      status: string;
    };

    expect(workflow.status).toBe("planned");
    expect(workflow.completedStages).toEqual(["created", "planned"]);
    expect(workflow.artifacts["comparison"]).toHaveLength(1);
    expect(workflow.artifacts["suggestedApproval"]).toHaveLength(1);
  });

  it("preserves completed workflow stages and command output after a later failure", async () => {
    const cwd = await makeTempDir();

    await expect(
      runCli([
        "--cwd",
        cwd,
        "--json",
        "solve",
        "--agents",
        "mock-codex,mock-claude",
        "--auto-approve-plan",
        "--implement",
        "missing-agent",
        "Trigger an implementation failure"
      ])
    ).rejects.toThrow();

    const sessionDir = await getOnlySessionDir(cwd);
    const workflow = JSON.parse(await readFile(path.join(sessionDir, "workflow.json"), "utf8")) as {
      artifacts: Record<string, string[]>;
      completedStages: string[];
      failedStage: string;
      status: string;
    };
    const commandMetadata = JSON.parse(
      await readFile(path.join(sessionDir, "workflow", "01-implement.command.json"), "utf8")
    ) as {
      stage: string;
      status: string;
    };

    expect(workflow.status).toBe("failed");
    expect(workflow.failedStage).toBe("implement");
    expect(workflow.completedStages).toEqual(["created", "planned", "approved"]);
    expect(workflow.artifacts["workflowOutputs"]?.length).toBeGreaterThan(0);
    expect(commandMetadata).toMatchObject({
      stage: "implement",
      status: "failed"
    });
  });
});

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
  return mkdtemp(path.join(os.tmpdir(), "codecouncil-workflow-"));
}

async function getOnlySessionDir(cwd: string): Promise<string> {
  const runsDir = path.join(cwd, ".codecouncil", "runs");
  const sessions = await readdir(runsDir);

  expect(sessions).toHaveLength(1);
  return path.join(runsDir, sessions[0] ?? "");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
