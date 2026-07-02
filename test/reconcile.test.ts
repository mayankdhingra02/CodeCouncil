import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createCli } from "../src/cli.js";
import {
  anonymizeReconciliationInputValue,
  deAnonymizeReconciliationOutput
} from "../src/commands/reconcile.js";
import { reconciliationOutputSchema } from "../src/agents/index.js";
import type { EventLogEntry } from "../src/session/index.js";

describe("reconcile CLI", () => {
  it("creates reconciled plan artifacts and allows explicit reconciled approval", async () => {
    const cwd = await makeTempDir();
    const planStdout = await runCli([
      "--cwd",
      cwd,
      "--json",
      "plan",
      "Add a small retry helper",
      "--agents",
      "mock-codex,mock-claude"
    ]);
    const planPayload = JSON.parse(planStdout) as {
      sessionDir: string;
      sessionId: string;
    };

    const reconcileStdout = await runCli([
      "--cwd",
      cwd,
      "--json",
      "reconcile",
      "--session",
      planPayload.sessionId,
      "--reconciler",
      "mock-codex"
    ]);
    const reconcilePayload = JSON.parse(reconcileStdout) as {
      artifacts: {
        jsonPath: string;
        markdownPath: string;
      };
      reconciliation: {
        mergedPlan: {
          summary: string;
        };
        metadata: {
          planAliases?: Record<string, string>;
          reconcilerBiasMetrics?: {
            otherPlannerSelections: number;
            reconcilerPlanSelections: number;
            selectionsByAgentId: Record<string, number>;
            synthesisSelections: number;
            totalResolutions: number;
            unknownSelections: number;
          };
          reconcilerBiasWarning?: string;
          reconcilerWasAlsoPlanner?: boolean;
          sourcePlanAgentIds?: string[];
        };
        rejectedIdeas: Array<{ agentId: string }>;
        reconcilerAgentId: string;
        resolutions: Array<{ chosenAgentId: string }>;
      };
      status: string;
    };

    expect(reconcilePayload).toMatchObject({
      reconciliation: {
        reconcilerAgentId: "mock-codex"
      },
      status: "success"
    });
    expect(reconcilePayload.reconciliation.resolutions.length).toBeGreaterThan(0);
    expect(Object.values(reconcilePayload.reconciliation.metadata.planAliases ?? {})).toEqual(
      expect.arrayContaining(["mock-codex", "mock-claude"])
    );
    expect(reconcilePayload.reconciliation.metadata.reconcilerWasAlsoPlanner).toBe(true);
    expect(reconcilePayload.reconciliation.metadata.sourcePlanAgentIds).toEqual(
      expect.arrayContaining(["mock-codex", "mock-claude"])
    );
    expect(reconcilePayload.reconciliation.metadata.reconcilerBiasWarning).toContain("self-preference bias");
    const biasMetrics = reconcilePayload.reconciliation.metadata.reconcilerBiasMetrics;
    expect(biasMetrics).toMatchObject({
      selectionsByAgentId: {
        "mock-claude": expect.any(Number),
        "mock-codex": expect.any(Number)
      },
      totalResolutions: reconcilePayload.reconciliation.resolutions.length
    });
    expect(
      (biasMetrics?.reconcilerPlanSelections ?? 0) +
      (biasMetrics?.otherPlannerSelections ?? 0) +
      (biasMetrics?.synthesisSelections ?? 0) +
      (biasMetrics?.unknownSelections ?? 0)
    ).toBe(reconcilePayload.reconciliation.resolutions.length);
    expect(reconcilePayload.reconciliation.resolutions.map((resolution) => resolution.chosenAgentId)).not.toContain("agent-a");
    expect(reconcilePayload.reconciliation.rejectedIdeas.map((idea) => idea.agentId)).not.toContain("agent-a");
    expect(reconcilePayload.reconciliation.rejectedIdeas.map((idea) => idea.agentId)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^mock-(codex|claude)$/u)])
    );
    await expect(readFile(reconcilePayload.artifacts.jsonPath, "utf8")).resolves.toContain("mergedPlan");
    await expect(readFile(reconcilePayload.artifacts.markdownPath, "utf8")).resolves.toContain(
      "codecouncil approve"
    );
    await expect(readFile(reconcilePayload.artifacts.markdownPath, "utf8")).resolves.toContain(
      "## Bias Disclosure"
    );
    await expect(readFile(reconcilePayload.artifacts.markdownPath, "utf8")).resolves.toContain(
      "## Bias Metrics"
    );

    await runCli([
      "--cwd",
      cwd,
      "--json",
      "approve",
      "--session",
      planPayload.sessionId,
      "--reconciled"
    ]);
    const approved = JSON.parse(
      await readFile(path.join(planPayload.sessionDir, "approved-plan.json"), "utf8")
    ) as { approvedBy: string; summary: string };

    expect(approved.approvedBy).toBe("reconciled");
    expect(approved.summary).toContain("Synthesize");
    await expect(readFile(path.join(planPayload.sessionDir, "approved-plan.md"), "utf8")).resolves.not.toContain(
      "agent-a"
    );

    const events = await readEvents(path.join(planPayload.sessionDir, "events.jsonl"));
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["reconciliation.started", "reconciliation.completed", "plan.approved"])
    );
  });

  it("rotates reconciliation across source-plan agents and writes comparison artifacts", async () => {
    const cwd = await makeTempDir();
    const planPayload = JSON.parse(
      await runCli([
        "--cwd",
        cwd,
        "--json",
        "plan",
        "Add a small retry helper",
        "--agents",
        "mock-codex,mock-claude"
      ])
    ) as {
      sessionDir: string;
      sessionId: string;
    };

    const reconcilePayload = JSON.parse(
      await runCli([
        "--cwd",
        cwd,
        "--json",
        "reconcile",
        "--session",
        planPayload.sessionId,
        "--strategy",
        "rotate"
      ])
    ) as {
      artifacts: {
        candidates: Record<string, { jsonPath: string; markdownPath: string }>;
        comparison: { jsonPath: string; markdownPath: string };
        recommended: { jsonPath: string; markdownPath: string };
      };
      rotationComparison: {
        candidates: Array<{
          reconcilerAgentId: string;
          reconcilerPlanSelections: number;
          synthesisSelections: number;
        }>;
        recommendationReason: string;
        recommendedReconcilerAgentId: string;
        strategy: string;
      };
      status: string;
      strategy: string;
    };

    expect(reconcilePayload).toMatchObject({
      rotationComparison: {
        strategy: "rotate"
      },
      status: "success",
      strategy: "rotate"
    });
    expect(Object.keys(reconcilePayload.artifacts.candidates).sort()).toEqual(["mock-claude", "mock-codex"]);
    expect(reconcilePayload.rotationComparison.candidates).toHaveLength(2);
    expect(["mock-codex", "mock-claude"]).toContain(reconcilePayload.rotationComparison.recommendedReconcilerAgentId);
    expect(reconcilePayload.rotationComparison.recommendationReason).toContain("most synthesis selections");
    expect(reconcilePayload.rotationComparison.recommendationReason).toContain("not correctness");

    await expect(readFile(reconcilePayload.artifacts.candidates["mock-codex"]?.jsonPath ?? "", "utf8")).resolves.toContain(
      "\"rotationCandidate\": true"
    );
    await expect(readFile(reconcilePayload.artifacts.candidates["mock-claude"]?.jsonPath ?? "", "utf8")).resolves.toContain(
      "\"rotationCandidate\": true"
    );
    await expect(readFile(reconcilePayload.artifacts.comparison.markdownPath, "utf8")).resolves.toContain(
      "# Reconciliation Rotation Comparison"
    );
    await expect(readFile(reconcilePayload.artifacts.comparison.markdownPath, "utf8")).resolves.toContain(
      "deference behavior"
    );
    await expect(readFile(reconcilePayload.artifacts.recommended.jsonPath, "utf8")).resolves.toContain(
      "\"canonicalFromRotation\": true"
    );
  });

  it("does not report corrupt comparison JSON as a missing comparison", async () => {
    const cwd = await makeTempDir();
    const planPayload = JSON.parse(
      await runCli([
        "--cwd",
        cwd,
        "--json",
        "plan",
        "Add a tiny helper",
        "--agents",
        "mock-codex,mock-claude"
      ])
    ) as { sessionDir: string; sessionId: string };

    await writeFile(path.join(planPayload.sessionDir, "plans", "comparison.json"), "{not-json", "utf8");

    await expect(
      runCli([
        "--cwd",
        cwd,
        "reconcile",
        "--session",
        planPayload.sessionId,
        "--reconciler",
        "mock-codex"
      ])
    ).rejects.not.toMatchObject({
      code: "COMPARISON_NOT_FOUND"
    });
  });
});

describe("reconciliation anonymization helpers", () => {
  it("anonymizes standalone agent names without corrupting file paths or CLI snippets", () => {
    const anonymized = anonymizeReconciliationInputValue(
      {
        summary: "Codex and CLAUDE disagree on the implementation boundary.",
        commands: ["codex exec --json", "claude -p"],
        files: ["src/agents/codex.ts", "docs/claude.md"],
        nested: {
          codex: "Codex planner"
        }
      },
      {
        codex: "agent-a",
        claude: "agent-b"
      }
    );

    expect(anonymized).toEqual({
      summary: "agent-a and agent-b disagree on the implementation boundary.",
      commands: ["codex exec --json", "claude -p"],
      files: ["src/agents/codex.ts", "docs/claude.md"],
      nested: {
        "agent-a": "agent-a planner"
      }
    });
  });

  it("de-anonymizes reconciliation agent references before persistence", () => {
    const reconciliation = reconciliationOutputSchema.parse({
      reconcilerAgentId: "mock-codex",
      displayName: "Mock Codex",
      generatedAt: "2026-07-01T12:34:56.000Z",
      mergedPlan: {
        summary: "Merged plan.",
        assumptions: [],
        files: [],
        steps: [],
        risks: [],
        tests: [],
        estimatedComplexity: "medium"
      },
      resolutions: [
        {
          disagreement: "Different files.",
          chosenAgentId: "agent-a",
          rationale: "Agent A had better scope.",
          evidence: []
        },
        {
          disagreement: "Different tests.",
          chosenAgentId: "synthesis",
          rationale: "Combine both test plans.",
          evidence: []
        }
      ],
      rejectedIdeas: [
        {
          agentId: "agent-b",
          item: "Overbroad refactor.",
          why: "Too risky."
        }
      ],
      openQuestionsForHuman: [],
      confidence: 0.8,
      metadata: {}
    });

    const deAnonymized = deAnonymizeReconciliationOutput(reconciliation, {
      "agent-a": "mock-codex",
      "agent-b": "mock-claude"
    });

    expect(deAnonymized.resolutions.map((resolution) => resolution.chosenAgentId)).toEqual([
      "mock-codex",
      "synthesis"
    ]);
    expect(deAnonymized.rejectedIdeas.map((idea) => idea.agentId)).toEqual(["mock-claude"]);
  });
});

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
  return mkdtemp(path.join(os.tmpdir(), "codecouncil-reconcile-"));
}
