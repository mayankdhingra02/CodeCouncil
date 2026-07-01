import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { comparePlans, savePlanArtifacts } from "../src/agents/index.js";
import type { PlanOutput } from "../src/agents/index.js";
import { createCli } from "../src/cli.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import type { CodeCouncilError } from "../src/core/errors.js";
import {
  approveAgentPlan,
  approveManualPlan,
  createTaskSession,
  hasApprovedPlan
} from "../src/session/index.js";

describe("plan comparison and approval", () => {
  it("compares structured plan fields", () => {
    const comparison = comparePlans([
      makePlan("mock-codex", {
        confidence: 0.82,
        proposedFilesToChange: ["src/auth.ts", "test/auth.test.ts"],
        risks: ["Password reset token validation must be secure."],
        testsToRun: ["pnpm test"]
      }),
      makePlan("mock-claude", {
        confidence: 0.76,
        proposedFilesToChange: ["src/auth.ts", "src/email.ts"],
        risks: ["Email workflow can leak token state if logging is too verbose."],
        testsToRun: ["pnpm test", "pnpm typecheck"]
      })
    ]);

    expect(comparison.files.shared).toEqual(["src/auth.ts"]);
    expect(comparison.files.uniqueByAgent["mock-codex"]).toEqual(["test/auth.test.ts"]);
    expect(comparison.testingStrategy.shared).toEqual(["pnpm test"]);
    expect(comparison.securityConsiderations.length).toBeGreaterThan(0);
    expect(comparison.suggestedImplementationAgent).toBe("mock-codex");
    expect(comparison.recommendedApproach).toContain("mock-codex");
  });

  it("creates approval files from an agent plan and manual approval", async () => {
    const rootDir = await makeTempDir();
    const config = createDefaultConfig({
      projectName: "approval-test"
    });
    const session = await createTaskSession({
      config,
      rootDir,
      task: "Add password reset",
      now: new Date("2026-07-01T12:34:56.000Z")
    });
    await savePlanArtifacts(session, makePlan("mock-codex"));

    const agentArtifacts = await approveAgentPlan(session, "mock-codex", new Date("2026-07-01T12:40:00.000Z"));

    await expect(readFile(agentArtifacts.jsonPath, "utf8")).resolves.toContain('"approvedBy": "agent"');
    await expect(readFile(agentArtifacts.markdownPath, "utf8")).resolves.toContain("Source agent");
    await expect(hasApprovedPlan(session)).resolves.toBe(true);

    const manualArtifacts = await approveManualPlan(session, new Date("2026-07-01T12:45:00.000Z"));

    await expect(readFile(manualArtifacts.jsonPath, "utf8")).resolves.toContain('"approvedBy": "manual"');
    await expect(readFile(manualArtifacts.markdownPath, "utf8")).resolves.toContain(
      "Write the approved implementation approach here."
    );
  });
});

describe("sessions CLI", () => {
  it("lists and shows sessions", async () => {
    const rootDir = await makeTempDir();
    const config = createDefaultConfig({
      projectName: "sessions-test"
    });
    const session = await createTaskSession({
      config,
      rootDir,
      task: "Add session commands",
      now: new Date("2026-07-01T12:34:56.000Z")
    });

    const listOutput = await runCli(["--cwd", rootDir, "sessions", "list"]);
    const showOutput = await runCli(["--cwd", rootDir, "sessions", "show", session.id]);

    expect(listOutput).toContain(session.id);
    expect(listOutput).toContain("not approved");
    expect(showOutput).toContain(`Session: ${session.id}`);
    expect(showOutput).toContain("Approved: no");
  });
});

describe("implementation approval gate", () => {
  it("blocks implementation without an approved plan", async () => {
    const rootDir = await makeTempDir();
    const config = createDefaultConfig({
      projectName: "approval-gate-test"
    });
    const session = await createTaskSession({
      config,
      rootDir,
      task: "Add password reset flow",
      now: new Date("2026-07-01T12:34:56.000Z")
    });

    await expect(runCli(["--cwd", rootDir, "implement", "--session", session.id])).rejects.toMatchObject({
      code: "IMPLEMENTATION_APPROVAL_REQUIRED"
    } satisfies Partial<CodeCouncilError>);
  });
});

function makePlan(agentId: string, overrides: Partial<PlanOutput> = {}): PlanOutput {
  return {
    agentId,
    displayName: agentId,
    generatedAt: "2026-07-01T12:34:56.000Z",
    summary: `${agentId} plan summary`,
    assumptions: ["Existing auth module can be extended."],
    proposedFilesToChange: ["src/auth.ts"],
    stepByStepPlan: ["Update auth workflow boundary.", "Add tests."],
    risks: ["No explicit security consideration was identified."],
    testsToRun: ["pnpm test"],
    estimatedComplexity: "medium",
    confidence: 0.75,
    metadata: {},
    ...overrides
  };
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
  return mkdtemp(path.join(os.tmpdir(), "codecouncil-approval-"));
}
