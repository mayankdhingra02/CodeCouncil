import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentConfig, AgentId } from "../config/schema.js";
import {
  implementationOutputSchema,
  planOutputSchema,
  reconciliationOutputSchema,
  reviewOutputSchema,
  type AgentAvailability,
  type AgentCapability,
  type CodeCouncilAgent,
  type ImplementationInput,
  type ImplementationOutput,
  type PlanInput,
  type PlanOutput,
  type ReconciliationInput,
  type ReconciliationOutput,
  type ReviewInput,
  type ReviewOutput
} from "./types.js";

type MockPersona = "codex" | "claude";

interface MockAgentOptions {
  config: AgentConfig;
  displayName: string;
  id: AgentId;
  persona: MockPersona;
}

export class MockAgent implements CodeCouncilAgent {
  public readonly capabilities: readonly AgentCapability[] = ["plan", "implement", "reconcile", "review"];
  public readonly config: AgentConfig;
  public readonly displayName: string;
  public readonly id: AgentId;
  private readonly persona: MockPersona;

  public constructor(options: MockAgentOptions) {
    this.config = options.config;
    this.displayName = options.displayName;
    this.id = options.id;
    this.persona = options.persona;
  }

  public async checkAvailability(): Promise<AgentAvailability> {
    return {
      available: true,
      command: this.config.command,
      metadata: {
        mock: true
      }
    };
  }

  public async generatePlan(input: PlanInput): Promise<PlanOutput> {
    const generatedAt = new Date().toISOString();
    const plan =
      this.persona === "codex"
        ? createMockCodexPlan(this.id, this.displayName, generatedAt, input)
        : createMockClaudePlan(this.id, this.displayName, generatedAt, input);

    return planOutputSchema.parse(plan);
  }

  public async implementTask(input: ImplementationInput): Promise<ImplementationOutput> {
    const safeAgentName = this.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const fileName = `CODECOUNCIL_MOCK_${safeAgentName}.md`;
    const filePath = path.join(input.worktreePath, fileName);

    await mkdir(input.worktreePath, { recursive: true });
    await writeFile(
      filePath,
      [
        `# Mock implementation for ${this.displayName}`,
        "",
        `Task: ${input.task}`,
        "",
        "This file was created by a CodeCouncil mock agent. No real coding agent was executed.",
        ""
      ].join("\n"),
      "utf8"
    );

    return implementationOutputSchema.parse({
      agentId: this.id,
      displayName: this.displayName,
      completedAt: new Date().toISOString(),
      status: "success",
      summary: `${this.displayName} created a harmless mock implementation artifact.`,
      filesChanged: [fileName],
      createdFiles: [fileName],
      metadata: {
        mock: true
      }
    });
  }

  public async reviewDiff(input: ReviewInput): Promise<ReviewOutput> {
    const hasDiff = input.diff.trim().length > 0;
    const hasSafetyWarnings = (input.safetyWarnings ?? []).length > 0;
    const hasFailingTests = input.testSummary?.includes('"status": "failed"') === true;

    return reviewOutputSchema.parse({
      reviewerAgentId: this.id,
      targetAgentId: input.targetAgentId,
      displayName: this.displayName,
      generatedAt: new Date().toISOString(),
      verdict: hasDiff && !hasSafetyWarnings && !hasFailingTests ? "approve" : "request_changes",
      summary: hasDiff
        ? `${this.displayName} reviewed the mock diff and found it suitable for a dry-run workflow.`
        : `${this.displayName} did not receive a substantive diff to review.`,
      blockingIssues: hasDiff && !hasSafetyWarnings ? [] : ["Review needs a substantive safe diff before approval."],
      nonBlockingIssues: hasDiff
        ? ["The mock artifact should be replaced by real implementation evidence in production workflows."]
        : [],
      securityConcerns: hasSafetyWarnings ? ["Safety warnings were reported for the target implementation."] : [],
      missingTests: hasFailingTests ? ["Target tests did not pass and need follow-up."] : [],
      edgeCases: hasDiff ? ["Large future diffs should be reviewed at file-boundary level first."] : [],
      maintainabilityConcerns: hasDiff ? ["Mock-only artifacts do not prove real behavior changes."] : [],
      suggestedFixes: hasDiff
        ? ["Keep the implementation isolated to the session worktree and attach test evidence."]
        : ["Generate an implementation diff before requesting review."],
      findings: hasDiff
        ? [
            "The change appears isolated to mock-generated files.",
            "No production code behavior is changed by the mock artifact."
          ]
        : ["No diff content was provided."],
      riskyAreas: hasDiff ? ["Future real implementations must avoid writing outside the worktree."] : [],
      recommendation: hasDiff
        ? "Proceed to real adapter planning once command execution boundaries are in place."
        : "Generate an implementation diff before requesting review.",
      confidence: hasDiff ? 0.82 : 0.55
    });
  }

  public async reconcilePlans(input: ReconciliationInput): Promise<ReconciliationOutput> {
    const firstPlan = input.plans[0];
    const secondPlan = input.plans[1];
    const files = unique(input.plans.flatMap(({ plan }) => plan.proposedFilesToChange));
    const steps = unique(input.plans.flatMap(({ plan }) => plan.stepByStepPlan));
    const risks = unique(input.plans.flatMap(({ plan }) => plan.risks));
    const tests = unique(input.plans.flatMap(({ plan }) => plan.testsToRun));
    const comparison = isRecord(input.comparison) ? input.comparison : {};
    const disagreements = Array.isArray(comparison["majorDisagreements"])
      ? comparison["majorDisagreements"].filter((item): item is string => typeof item === "string")
      : [];

    return reconciliationOutputSchema.parse({
      reconcilerAgentId: this.id,
      displayName: this.displayName,
      generatedAt: new Date().toISOString(),
      mergedPlan: {
        summary: `Synthesize ${input.plans.length} plans for "${input.task}" into a narrow human-approved implementation path.`,
        assumptions: unique(input.plans.flatMap(({ plan }) => plan.assumptions)),
        files,
        steps: steps.length > 0 ? steps : ["Use the deterministic comparison to choose the smallest reviewable path."],
        risks: risks.length > 0 ? risks : ["Mock reconciliation cannot verify real repository semantics."],
        tests: tests.length > 0 ? tests : input.config.testCommands,
        estimatedComplexity: firstPlan?.plan.estimatedComplexity ?? secondPlan?.plan.estimatedComplexity ?? "medium"
      },
      resolutions:
        disagreements.length > 0
          ? disagreements.map((disagreement) => ({
              disagreement,
              chosenAgentId: "synthesis",
              rationale: "Use shared low-risk pieces and defer unresolved differences to human review.",
              evidence: files.slice(0, 2)
            }))
          : [
              {
                disagreement: "No major disagreements were identified by deterministic comparison.",
                chosenAgentId: firstPlan?.alias ?? "synthesis",
                rationale: "Prefer the first complete plan while retaining useful tests and risks from the other plan.",
                evidence: files.slice(0, 2)
              }
            ],
      rejectedIdeas: [],
      openQuestionsForHuman: files.length === 0 ? ["Which concrete files should be inspected before approval?"] : [],
      confidence: 0.76,
      metadata: {
        mock: true
      }
    });
  }
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createMockCodexAgent(id: AgentId, config: AgentConfig): CodeCouncilAgent {
  return new MockAgent({
    config,
    displayName: "Mock Codex",
    id,
    persona: "codex"
  });
}

export function createMockClaudeAgent(id: AgentId, config: AgentConfig): CodeCouncilAgent {
  return new MockAgent({
    config,
    displayName: "Mock Claude",
    id,
    persona: "claude"
  });
}

function createMockCodexPlan(
  agentId: AgentId,
  displayName: string,
  generatedAt: string,
  input: PlanInput
): PlanOutput {
  return {
    agentId,
    displayName,
    generatedAt,
    summary: `Implement "${input.task}" with a narrow, test-first change set that preserves existing module boundaries.`,
    assumptions: [
      "The repository already has a usable test command or a clear local test convention.",
      "The task can be implemented without changing public configuration formats unless tests indicate otherwise."
    ],
    proposedFilesToChange: [
      "Focused source module for the requested behavior",
      "Nearby unit test or integration test file",
      "Documentation only if user-facing behavior changes"
    ],
    stepByStepPlan: [
      "Inspect the relevant modules and existing tests.",
      "Add or update a failing test that captures the requested behavior.",
      "Implement the smallest code change that satisfies the test.",
      "Run the configured test command and type checks.",
      "Summarize the diff and any remaining risks."
    ],
    risks: [
      "The implementation target may be broader than the task wording suggests.",
      "Existing tests may not cover the affected integration path."
    ],
    testsToRun: input.config.testCommands.length > 0 ? input.config.testCommands : ["project test suite"],
    estimatedComplexity: "medium",
    confidence: 0.78,
    metadata: {
      mock: true
    }
  };
}

function createMockClaudePlan(
  agentId: AgentId,
  displayName: string,
  generatedAt: string,
  input: PlanInput
): PlanOutput {
  return {
    agentId,
    displayName,
    generatedAt,
    summary: `Approach "${input.task}" by first clarifying behavioral boundaries, then implementing in an isolated branch with reviewable artifacts.`,
    assumptions: [
      "The current codebase has enough structure to identify ownership boundaries before editing.",
      "A conservative implementation is preferable to a broad refactor for the first pass."
    ],
    proposedFilesToChange: [
      "Primary feature or orchestration module",
      "Boundary-level tests around the new behavior",
      "Run artifact or documentation file if the workflow surface changes"
    ],
    stepByStepPlan: [
      "Map inputs, outputs, and failure states for the requested behavior.",
      "Identify the smallest stable interface to modify.",
      "Implement with explicit error handling and durable artifacts.",
      "Review the diff for security and path-safety implications.",
      "Run tests and document any skipped verification."
    ],
    risks: [
      "Path, process, or filesystem side effects may need stronger guards.",
      "A mock-success path can hide missing real-agent edge cases."
    ],
    testsToRun: input.config.testCommands.length > 0 ? input.config.testCommands : ["unit tests", "typecheck"],
    estimatedComplexity: "medium",
    confidence: 0.74,
    metadata: {
      mock: true
    }
  };
}
