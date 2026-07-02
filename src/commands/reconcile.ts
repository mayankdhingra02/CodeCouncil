import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";

import {
  AgentRegistry,
  planOutputSchema,
  reconciliationOutputSchema,
  type PlanComparison,
  type PlanOutput,
  type ReconciliationOutput,
  type ReconciliationPlanInput
} from "../agents/index.js";
import type { AgentId, CodeCouncilConfig } from "../config/schema.js";
import { CodeCouncilError, isErrnoException } from "../core/errors.js";
import {
  applyModelSelectionToConfig,
  parseModelSelection,
  type ModelSelection
} from "../core/modelSelection.js";
import {
  readReconcilerBiasMetrics,
  summarizeReconcilerBias
} from "../reconcile/biasMetrics.js";
import {
  saveReconciliationArtifacts,
  saveRotationComparisonArtifacts,
  type ReconciliationRotationComparison,
  type SavedReconciliationArtifact,
  type SaveReconciliationArtifactOptions
} from "../reconcile/index.js";
import {
  appendSessionEvent,
  loadTaskSession,
  type TaskSession
} from "../session/index.js";
import { writeResult } from "./context.js";
import {
  collectRepeatableOption,
  formatConfigSource,
  loadRuntimeContext
} from "./shared.js";

interface ReconcileOptions {
  model?: string[];
  models?: string;
  reconciler?: string;
  session?: string;
  strategy?: string;
}

type ReconcileStrategy = "single" | "rotate";

interface ReconciliationRun {
  artifacts: SavedReconciliationArtifact;
  reconciliation: ReconciliationOutput;
  reconcilerAgentId: AgentId;
}

export function registerReconcileCommand(program: Command): void {
  program
    .command("reconcile")
    .description("Ask one agent to synthesize competing plans into a human-approvable candidate.")
    .requiredOption("--session <id>", "session id containing plan artifacts")
    .option("--reconciler <agent>", "agent id to use as the reconciler")
    .option("--strategy <strategy>", "reconciliation strategy: single or rotate", "single")
    .option("-m, --model <model>", "model override for this reconciliation run; use agent=model for one agent", collectRepeatableOption)
    .option("--models <models>", "comma-separated model overrides, for example codex=gpt-5.5")
    .action(async (options: ReconcileOptions, command: Command) => {
      const runtime = await loadRuntimeContext(command);

      if (!options.session) {
        throw new CodeCouncilError("Reconcile requires --session.", {
          code: "MISSING_SESSION",
          exitCode: 2
        });
      }

      const session = await loadTaskSession({
        rootDir: runtime.loadedConfig.rootDir,
        sessionId: options.session,
        workspaceDir: runtime.loadedConfig.config.workspaceDir
      });
      const plans = await loadPlanArtifacts(session);
      const comparison = await loadComparisonArtifact(session);
      const strategy = parseReconcileStrategy(options.strategy);

      if (strategy === "rotate" && options.reconciler) {
        throw new CodeCouncilError("--reconciler cannot be used with --strategy rotate. Rotate uses all enabled source-plan agents.", {
          code: "RECONCILE_ROTATE_RECONCILER_CONFLICT",
          exitCode: 2
        });
      }

      const targetAgentIds = strategy === "rotate"
        ? resolveRotateReconcilerIds(runtime.loadedConfig.config, plans)
        : [resolveReconcilerId(runtime.loadedConfig.config, options.reconciler, plans)];
      const modelSelection = parseModelSelection({
        model: options.model,
        models: options.models
      });
      const config = applyModelSelectionToConfig(
        runtime.loadedConfig.config,
        modelSelection,
        {
          stage: "reconcile",
          targetAgentIds
        }
      );
      const registry = AgentRegistry.fromConfig(config);
      const planInputs = createAnonymizedPlanInputs(plans);
      const planAliases = Object.fromEntries(planInputs.map(({ alias, plan }) => [alias, plan.agentId]));
      const anonymizedComparison = anonymizeReconciliationInputValue(
        comparison,
        Object.fromEntries(planInputs.map(({ alias, plan }) => [plan.agentId, alias]))
      );

      if (strategy === "rotate") {
        const rotationRuns = [];
        const rotationDir = path.join(session.paths.plansDir, "rotations");

        for (const [index, reconcilerAgentId] of targetAgentIds.entries()) {
          rotationRuns.push(await runReconciliationCandidate({
            agentRegistry: registry,
            anonymizedComparison,
            artifactOptions: {
              basename: reconcilerAgentId,
              directory: rotationDir
            },
            config,
            extraMetadata: {
              rotationCandidate: true,
              rotationCandidateIndex: index,
              rotationReconcilerCount: targetAgentIds.length,
              rotationStrategy: "rotate"
            },
            planAliases,
            planInputs,
            plans,
            reconcilerAgentId,
            repoRoot: runtime.loadedConfig.rootDir,
            requestedReconciler: [],
            session
          }));
        }

        const rotationComparison = buildRotationComparison({
          reconcilerAgentIds: targetAgentIds,
          runs: rotationRuns,
          session,
          sourcePlanAgentIds: plans.map((plan) => plan.agentId)
        });
        const rotationArtifacts = await saveRotationComparisonArtifacts(session, rotationComparison);
        const recommendedRun = rotationRuns.find((run) => run.reconcilerAgentId === rotationComparison.recommendedReconcilerAgentId) ?? rotationRuns[0];

        if (!recommendedRun) {
          throw new CodeCouncilError("Rotate reconciliation did not produce any candidate reconciliations.", {
            code: "RECONCILE_ROTATE_NO_CANDIDATES",
            exitCode: 1
          });
        }

        const canonicalArtifacts = await saveReconciliationArtifacts(session, reconciliationOutputSchema.parse({
          ...recommendedRun.reconciliation,
          metadata: {
            ...recommendedRun.reconciliation.metadata,
            canonicalFromRotation: true,
            rotationComparisonPath: rotationArtifacts.jsonPath
          }
        }));

        await appendSessionEvent(session, {
          type: "reconciliation.rotation.completed",
          status: "success",
          message: "Completed rotated plan reconciliation.",
          metadata: {
            candidateCount: rotationRuns.length,
            comparisonJsonPath: rotationArtifacts.jsonPath,
            comparisonMarkdownPath: rotationArtifacts.markdownPath,
            recommendedReconcilerAgentId: rotationComparison.recommendedReconcilerAgentId
          }
        });

        writeResult(
          runtime.commandContext,
          {
            artifacts: {
              candidates: Object.fromEntries(rotationRuns.map((run) => [run.reconcilerAgentId, run.artifacts])),
              comparison: rotationArtifacts,
              recommended: canonicalArtifacts
            },
            command: "reconcile",
            config: formatConfigSource(runtime.loadedConfig),
            modelSelection,
            reconciliation: recommendedRun.reconciliation,
            reconcilerAgentId: rotationComparison.recommendedReconcilerAgentId,
            rotationComparison,
            sessionId: session.id,
            status: "success",
            strategy
          },
          formatRotateReconcileOutputLines({
            canonicalArtifacts,
            cwd: runtime.commandContext.cwd,
            modelSelection,
            rotationArtifacts,
            rotationComparison,
            runs: rotationRuns,
            session
          })
        );

        return;
      }

      const reconcilerAgentId = targetAgentIds[0];

      if (!reconcilerAgentId) {
        throw new CodeCouncilError("No reconciler agent was selected.", {
          code: "NO_RECONCILER_SELECTED",
          exitCode: 2
        });
      }

      const run = await runReconciliationCandidate({
        agentRegistry: registry,
        anonymizedComparison,
        artifactOptions: {},
        config,
        extraMetadata: {},
        planAliases,
        planInputs,
        plans,
        reconcilerAgentId,
        repoRoot: runtime.loadedConfig.rootDir,
        requestedReconciler: options.reconciler ? [options.reconciler] : [],
        session
      });

      writeResult(
        runtime.commandContext,
        {
          artifacts: run.artifacts,
          command: "reconcile",
          config: formatConfigSource(runtime.loadedConfig),
          modelSelection,
          reconciliation: run.reconciliation,
          reconcilerAgentId,
          sessionId: session.id,
          status: "success",
          strategy
        },
        formatReconcileOutputLines({
          artifacts: run.artifacts,
          modelSelection,
          reconciliation: run.reconciliation,
          reconcilerAgentId,
          session,
          cwd: runtime.commandContext.cwd
        })
      );
    });
}

async function loadPlanArtifacts(session: TaskSession): Promise<PlanOutput[]> {
  const entries = await readdir(session.paths.plansDir);
  const planFiles = entries
    .filter((entry) => entry.endsWith(".json"))
    .filter((entry) => !entry.endsWith(".command.json"))
    .filter((entry) => !entry.endsWith(".parsed.json"))
    .filter((entry) => ![
      "comparison.json",
      "reconciliation-rotation.json",
      "reconciled.json",
      "suggested-approved-plan.json"
    ].includes(entry))
    .sort();
  const plans = [];

  for (const planFile of planFiles) {
    const source = await readFile(path.join(session.paths.plansDir, planFile), "utf8");
    plans.push(planOutputSchema.parse(JSON.parse(source) as unknown));
  }

  if (plans.length < 2) {
    throw new CodeCouncilError("Reconciliation requires at least two saved agent plans. Run codecouncil plan with multiple agents first.", {
      code: "RECONCILE_REQUIRES_MULTIPLE_PLANS",
      exitCode: 2
    });
  }

  return plans;
}

async function loadComparisonArtifact(session: TaskSession): Promise<PlanComparison> {
  const comparisonPath = path.join(session.paths.plansDir, "comparison.json");
  let source: string;

  try {
    source = await readFile(comparisonPath, "utf8");
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }

    throw new CodeCouncilError("No deterministic comparison exists for this session. Run codecouncil plan first.", {
      code: "COMPARISON_NOT_FOUND",
      exitCode: 2
    });
  }

  return JSON.parse(source) as PlanComparison;
}

function resolveReconcilerId(
  config: CodeCouncilConfig,
  requestedReconciler: string | undefined,
  plans: readonly PlanOutput[]
): AgentId {
  if (requestedReconciler) {
    return requestedReconciler;
  }

  const plannerIds = new Set(plans.map((plan) => plan.agentId));
  const enabledAgentIds = Object.entries(config.agents)
    .filter(([, agentConfig]) => agentConfig.enabled)
    .map(([agentId]) => agentId);
  const nonPlanner = enabledAgentIds.find((agentId) => !plannerIds.has(agentId));
  const selected = nonPlanner ?? enabledAgentIds[0];

  if (!selected) {
    throw new CodeCouncilError("No enabled agents are configured for reconciliation.", {
      code: "NO_ENABLED_AGENTS",
      exitCode: 2
    });
  }

  return selected;
}

function parseReconcileStrategy(value: string | undefined): ReconcileStrategy {
  const strategy = (value ?? "single").trim().toLowerCase();

  if (strategy === "single" || strategy === "rotate") {
    return strategy;
  }

  throw new CodeCouncilError(`Unknown reconciliation strategy "${value}". Use "single" or "rotate".`, {
    code: "INVALID_RECONCILE_STRATEGY",
    exitCode: 2
  });
}

function resolveRotateReconcilerIds(
  config: CodeCouncilConfig,
  plans: readonly PlanOutput[]
): AgentId[] {
  const enabledAgentIds = new Set(
    Object.entries(config.agents)
      .filter(([, agentConfig]) => agentConfig.enabled)
      .map(([agentId]) => agentId)
  );
  const reconcilerIds = unique(plans.map((plan) => plan.agentId).filter((agentId) => enabledAgentIds.has(agentId)));

  if (reconcilerIds.length < 2) {
    throw new CodeCouncilError("Rotate reconciliation requires at least two enabled source-plan agents.", {
      code: "RECONCILE_ROTATE_REQUIRES_MULTIPLE_AGENTS",
      exitCode: 2
    });
  }

  return reconcilerIds;
}

async function runReconciliationCandidate(input: {
  agentRegistry: AgentRegistry;
  anonymizedComparison: unknown;
  artifactOptions: SaveReconciliationArtifactOptions;
  config: CodeCouncilConfig;
  extraMetadata: Record<string, unknown>;
  planAliases: Record<string, string>;
  planInputs: ReconciliationPlanInput[];
  plans: readonly PlanOutput[];
  reconcilerAgentId: AgentId;
  repoRoot: string;
  requestedReconciler: string[];
  session: TaskSession;
}): Promise<ReconciliationRun> {
  const reconciler = input.agentRegistry.get(input.reconcilerAgentId);

  if (!reconciler.capabilities.includes("reconcile")) {
    throw new CodeCouncilError(`Agent "${reconciler.id}" does not support reconciliation.`, {
      code: "AGENT_RECONCILE_UNSUPPORTED",
      exitCode: 2
    });
  }

  await appendSessionEvent(input.session, {
    type: "reconciliation.started",
    agentId: reconciler.id,
    status: "running",
    message: `Started plan reconciliation with ${reconciler.displayName}.`,
    metadata: {
      planCount: input.plans.length,
      reconcilerAgentId: reconciler.id,
      requestedReconciler: input.requestedReconciler
    }
  });

  const availability = await reconciler.checkAvailability();

  if (!availability.available) {
    throw new CodeCouncilError(
      `Reconciler "${reconciler.id}" is not available: ${availability.reason ?? "unknown reason"}`,
      {
        code: "AGENT_NOT_AVAILABLE",
        exitCode: 2
      }
    );
  }

  const rawReconciliation = await reconciler.reconcilePlans({
    comparison: input.anonymizedComparison,
    config: input.config,
    plans: input.planInputs,
    repoRoot: input.repoRoot,
    session: input.session,
    task: input.session.task
  });
  let reconciliation = deAnonymizeReconciliationOutput(rawReconciliation, input.planAliases);
  const sourcePlanAgentIds = input.plans.map((plan) => plan.agentId);
  const reconcilerWasAlsoPlanner = sourcePlanAgentIds.includes(reconciler.id);
  const reconcilerBiasMetrics = summarizeReconcilerBias({
    reconciliation,
    reconcilerAgentId: reconciler.id,
    reconcilerWasAlsoPlanner,
    sourcePlanAgentIds
  });
  const reconcilerBiasMetadata = reconcilerWasAlsoPlanner
    ? {
      reconcilerBiasWarning: "The reconciler also produced one of the source plans, so this reconciliation may contain model self-preference bias."
    }
    : {};
  reconciliation = reconciliationOutputSchema.parse({
    ...reconciliation,
    metadata: {
      ...reconciliation.metadata,
      comparisonPath: path.join(input.session.paths.plansDir, "comparison.json"),
      deterministicBaseline: true,
      planAliases: input.planAliases,
      ...reconcilerBiasMetadata,
      reconcilerBiasMetrics,
      reconcilerWasAlsoPlanner,
      sourcePlanAgentIds,
      sourcePlanCount: input.plans.length,
      ...input.extraMetadata
    }
  });

  const artifacts = await saveReconciliationArtifacts(input.session, reconciliation, input.artifactOptions);

  await appendSessionEvent(input.session, {
    type: "reconciliation.completed",
    agentId: reconciler.id,
    status: "success",
    message: "Completed plan reconciliation.",
    metadata: {
      jsonPath: artifacts.jsonPath,
      markdownPath: artifacts.markdownPath,
      openQuestions: reconciliation.openQuestionsForHuman.length,
      resolutions: reconciliation.resolutions.length
    }
  });

  return {
    artifacts,
    reconciliation,
    reconcilerAgentId: input.reconcilerAgentId
  };
}

function buildRotationComparison(input: {
  reconcilerAgentIds: readonly string[];
  runs: readonly ReconciliationRun[];
  session: TaskSession;
  sourcePlanAgentIds: readonly string[];
}): ReconciliationRotationComparison {
  const candidates = input.runs.map((run) => {
    const metrics = readReconcilerBiasMetrics(run.reconciliation.metadata["reconcilerBiasMetrics"]);

    return {
      confidence: run.reconciliation.confidence,
      openQuestions: run.reconciliation.openQuestionsForHuman.length,
      reconcilerAgentId: run.reconcilerAgentId,
      reconcilerPlanSelections: metrics?.reconcilerPlanSelections ?? 0,
      synthesisSelections: metrics?.synthesisSelections ?? 0,
      totalResolutions: run.reconciliation.resolutions.length
    };
  });
  const rankedCandidates = [...candidates].sort((left, right) =>
    right.synthesisSelections - left.synthesisSelections ||
    left.reconcilerPlanSelections - right.reconcilerPlanSelections ||
    left.openQuestions - right.openQuestions ||
    right.confidence - left.confidence ||
    input.reconcilerAgentIds.indexOf(left.reconcilerAgentId) - input.reconcilerAgentIds.indexOf(right.reconcilerAgentId)
  );
  const recommended = rankedCandidates[0] ?? candidates[0];

  if (!recommended) {
    throw new CodeCouncilError("No reconciliation candidates were available to compare.", {
      code: "RECONCILE_ROTATE_NO_CANDIDATES",
      exitCode: 1
    });
  }

  return {
    candidates,
    generatedAt: new Date().toISOString(),
    recommendedReconcilerAgentId: recommended.reconcilerAgentId,
    recommendationReason: "Selected by most synthesis selections, then lowest own-plan selections, then fewest open questions, then highest confidence. This ranking measures reconciliation/deference behavior, not correctness.",
    reconcilerAgentIds: [...input.reconcilerAgentIds],
    sessionId: input.session.id,
    sourcePlanAgentIds: [...input.sourcePlanAgentIds],
    strategy: "rotate",
    warnings: [
      "The rotation ranking measures reconciliation/deference behavior, not implementation correctness.",
      "Rotated reconciliation compares candidate plans, but it is still a heuristic and not a proof of correctness.",
      "A human must explicitly approve a reconciled candidate before implementation."
    ]
  };
}

function createAnonymizedPlanInputs(plans: readonly PlanOutput[]): ReconciliationPlanInput[] {
  return plans.map((plan, index) => ({
    alias: `agent-${String.fromCharCode(97 + index)}`,
    plan
  }));
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

export function anonymizeReconciliationInputValue(
  value: unknown,
  aliasByAgentId: Record<string, string>
): unknown {
  if (typeof value === "string") {
    return replaceAgentIds(value, aliasByAgentId);
  }

  if (Array.isArray(value)) {
    return value.map((item) => anonymizeReconciliationInputValue(item, aliasByAgentId));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        replaceAgentIds(key, aliasByAgentId),
        anonymizeReconciliationInputValue(nestedValue, aliasByAgentId)
      ])
    );
  }

  return value;
}

function replaceAgentIds(value: string, aliasByAgentId: Record<string, string>): string {
  return Object.entries(aliasByAgentId).reduce((current, [agentId, alias]) => {
    const pattern = new RegExp(`(^|[^A-Za-z0-9._/-])(${escapeRegExp(agentId)})(?=$|[^A-Za-z0-9._/-])`, "giu");

    return current.replace(pattern, (match, prefix: string, _matchedAgentId: string, offset: number, source: string) => {
      const afterMatch = source.slice(offset + match.length);

      if (/^\s+(?:-|exec|init|plan|reconcile|approve|implement|test|review|report|safety|solve|benchmark|doctor|models|sessions|worktree)\b/iu.test(afterMatch)) {
        return match;
      }

      return `${prefix}${alias}`;
    });
  }, value);
}

export function deAnonymizeReconciliationOutput(
  reconciliation: ReconciliationOutput,
  agentIdByAlias: Record<string, string>
): ReconciliationOutput {
  const deAnonymized = deAnonymizeAliasesInValue(reconciliation, agentIdByAlias) as ReconciliationOutput;

  return reconciliationOutputSchema.parse({
    ...deAnonymized,
    resolutions: deAnonymized.resolutions.map((resolution) => ({
      ...resolution,
      chosenAgentId: deAnonymizeAgentReference(resolution.chosenAgentId, agentIdByAlias)
    })),
    rejectedIdeas: deAnonymized.rejectedIdeas.map((idea) => ({
      ...idea,
      agentId: deAnonymizeAgentReference(idea.agentId, agentIdByAlias)
    }))
  });
}

function deAnonymizeAliasesInValue(value: unknown, agentIdByAlias: Record<string, string>): unknown {
  if (typeof value === "string") {
    return replaceAliases(value, agentIdByAlias);
  }

  if (Array.isArray(value)) {
    return value.map((item) => deAnonymizeAliasesInValue(item, agentIdByAlias));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        replaceAliases(key, agentIdByAlias),
        deAnonymizeAliasesInValue(nestedValue, agentIdByAlias)
      ])
    );
  }

  return value;
}

function deAnonymizeAgentReference(value: string, agentIdByAlias: Record<string, string>): string {
  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue === "synthesis") {
    return "synthesis";
  }

  const match = Object.entries(agentIdByAlias).find(([alias]) => alias.toLowerCase() === normalizedValue);
  return match?.[1] ?? value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceAliases(value: string, agentIdByAlias: Record<string, string>): string {
  return Object.entries(agentIdByAlias).reduce((current, [alias, agentId]) => {
    const pattern = new RegExp(`(^|[^A-Za-z0-9._/-])(${escapeRegExp(alias)})(?=$|[^A-Za-z0-9._/-])`, "giu");
    return current.replace(pattern, (_match, prefix: string) => `${prefix}${agentId}`);
  }, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatReconcileOutputLines(input: {
  artifacts: { jsonPath: string; markdownPath: string };
  cwd: string;
  modelSelection: ModelSelection;
  reconciliation: ReconciliationOutput;
  reconcilerAgentId: AgentId;
  session: TaskSession;
}): string[] {
  return [
    "Reconciliation complete.",
    `Session: ${input.session.id}`,
    `Reconciler: ${input.reconcilerAgentId}`,
    "",
    "Merged plan:",
    `- ${input.reconciliation.mergedPlan.summary}`,
    "",
    "Resolutions:",
    ...formatListItems(input.reconciliation.resolutions.map((resolution) => `${resolution.disagreement} -> ${resolution.chosenAgentId}`)),
    "Open human questions:",
    ...formatListItems(input.reconciliation.openQuestionsForHuman),
    "",
    ...formatBiasWarningLines(input.reconciliation),
    ...formatModelSelectionLines(input.modelSelection),
    `JSON: ${path.relative(input.cwd, input.artifacts.jsonPath) || "."}`,
    `Markdown: ${path.relative(input.cwd, input.artifacts.markdownPath) || "."}`,
    `Next: codecouncil approve --session ${input.session.id} --reconciled`
  ];
}

function formatRotateReconcileOutputLines(input: {
  canonicalArtifacts: { jsonPath: string; markdownPath: string };
  cwd: string;
  modelSelection: ModelSelection;
  rotationArtifacts: { jsonPath: string; markdownPath: string };
  rotationComparison: ReconciliationRotationComparison;
  runs: readonly ReconciliationRun[];
  session: TaskSession;
}): string[] {
  return [
    "Rotated reconciliation complete.",
    `Session: ${input.session.id}`,
    `Reconcilers: ${input.rotationComparison.reconcilerAgentIds.join(", ")}`,
    `Recommended candidate: ${input.rotationComparison.recommendedReconcilerAgentId}`,
    "",
    "Candidates:",
    ...formatListItems(input.runs.map((run) => {
      const metrics = readReconcilerBiasMetrics(run.reconciliation.metadata["reconcilerBiasMetrics"]);
      const metricSummary = metrics
        ? `own=${metrics.reconcilerPlanSelections}, other=${metrics.otherPlannerSelections}, synthesis=${metrics.synthesisSelections}, unknown=${metrics.unknownSelections}`
        : "bias metrics unavailable";

      return `${run.reconcilerAgentId}: ${run.reconciliation.mergedPlan.summary} (${metricSummary})`;
    })),
    "",
    "Selection policy:",
    `- ${input.rotationComparison.recommendationReason}`,
    "",
    ...formatModelSelectionLines(input.modelSelection),
    `Recommended JSON: ${path.relative(input.cwd, input.canonicalArtifacts.jsonPath) || "."}`,
    `Recommended Markdown: ${path.relative(input.cwd, input.canonicalArtifacts.markdownPath) || "."}`,
    `Rotation JSON: ${path.relative(input.cwd, input.rotationArtifacts.jsonPath) || "."}`,
    `Rotation Markdown: ${path.relative(input.cwd, input.rotationArtifacts.markdownPath) || "."}`,
    `Next: review ${path.relative(input.cwd, input.rotationArtifacts.markdownPath) || input.rotationArtifacts.markdownPath}, then codecouncil approve --session ${input.session.id} --reconciled`
  ];
}

function formatListItems(items: readonly string[]): string[] {
  if (items.length === 0) {
    return ["- None"];
  }

  return items.map((item) => `- ${item}`);
}

function formatModelSelectionLines(selection: ModelSelection): string[] {
  const assignments = Object.entries(selection.byAgent);

  if (!selection.defaultModel && assignments.length === 0) {
    return [];
  }

  return [
    `Model override: ${[
      selection.defaultModel ? `default=${selection.defaultModel}` : "",
      ...assignments.map(([agentId, model]) => `${agentId}=${model}`)
    ].filter(Boolean).join(", ")}`
  ];
}

function formatBiasWarningLines(reconciliation: ReconciliationOutput): string[] {
  const metrics = readReconcilerBiasMetrics(reconciliation.metadata["reconcilerBiasMetrics"]);

  if (reconciliation.metadata["reconcilerWasAlsoPlanner"] !== true && !metrics) {
    return [];
  }

  const lines = [];

  if (reconciliation.metadata["reconcilerWasAlsoPlanner"] === true) {
    lines.push("Bias note: reconciler also produced one source plan; inspect the reconciled plan for possible self-preference.");
  }

  if (metrics) {
    lines.push(
      `Bias metrics: reconciler=${metrics.reconcilerPlanSelections}, other=${metrics.otherPlannerSelections}, synthesis=${metrics.synthesisSelections}, unknown=${metrics.unknownSelections}.`
    );
  }

  return [...lines, ""];
}
