import { describe, expect, it } from "vitest";

import { buildPlanOutputFromCommand, type AgentCommandResult } from "../src/agents/index.js";

describe("agent output parsing", () => {
  it("extracts a Codex plan from embedded JSONL agent message text", () => {
    const plan = buildPlanOutputFromCommand({
      agentId: "codex",
      displayName: "OpenAI Codex CLI",
      result: makeResult(
        [
          JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: JSON.stringify(makePlan("Codex structured plan", 0.86))
            }
          })
        ].join("\n")
      )
    });

    expect(plan.summary).toBe("Codex structured plan");
    expect(plan.proposedFilesToChange).toEqual(["src/benchmark/output.ts"]);
    expect(plan.stepByStepPlan).toEqual(["Render HTML", "Write summary.html"]);
    expect(plan.confidence).toBe(0.86);
  });

  it("prefers a Claude fenced JSON plan over stream status summaries", () => {
    const planJson = JSON.stringify(makePlan("Claude structured plan", 0.95), null, 2);
    const plan = buildPlanOutputFromCommand({
      agentId: "claude",
      displayName: "Anthropic Claude Code CLI",
      result: makeResult(
        [
          JSON.stringify({
            type: "system",
            subtype: "task_notification",
            summary: "Agent \"Explore benchmark code\" finished"
          }),
          JSON.stringify({
            type: "result",
            subtype: "success",
            result: `Here is the structured JSON output:\n\n\`\`\`json\n${planJson}\n\`\`\``
          })
        ].join("\n")
      )
    });

    expect(plan.summary).toBe("Claude structured plan");
    expect(plan.assumptions).toEqual(["No runtime dependencies are needed."]);
    expect(plan.testsToRun).toContain("pnpm test");
    expect(plan.confidence).toBe(0.95);
  });
});

function makePlan(summary: string, confidence: number): Record<string, unknown> {
  return {
    summary,
    assumptions: ["No runtime dependencies are needed."],
    proposedFilesToChange: ["src/benchmark/output.ts"],
    stepByStepPlan: ["Render HTML", "Write summary.html"],
    risks: ["Escaping must cover all dynamic values."],
    testsToRun: ["pnpm test"],
    estimatedComplexity: "medium",
    confidence
  };
}

function makeResult(stdout: string): AgentCommandResult {
  return {
    args: ["exec", "--json"],
    command: "agent",
    completedAt: "2026-07-01T12:01:00.000Z",
    cwd: "/tmp/repo",
    durationMs: 1000,
    exitCode: 0,
    stderr: "",
    stdout,
    timedOut: false,
    startedAt: "2026-07-01T12:00:59.000Z"
  };
}
