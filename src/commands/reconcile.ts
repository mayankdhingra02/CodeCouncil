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
import { saveReconciliationArtifacts } from "../reconcile/index.js";
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
}

export function registerReconcileCommand(program: Command): void {
  program
    .command("reconcile")
    .description("Ask one agent to synthesize competing plans into a human-approvable candidate.")
    .requiredOption("--session <id>", "session id containing plan artifacts")
    .option("--reconciler <agent>", "agent id to use as the reconciler")
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
      const requestedReconciler = options.reconciler ? [options.reconciler] : [];
      const reconcilerAgentId = resolveReconcilerId(runtime.loadedConfig.config, options.reconciler, plans);
      const modelSelection = parseModelSelection({
        model: options.model,
        models: options.models
      });
      const config = applyModelSelectionToConfig(
        runtime.loadedConfig.config,
        modelSelection,
        {
          stage: "reconcile",
          targetAgentIds: [reconcilerAgentId]
        }
      );
      const registry = AgentRegistry.fromConfig(config);
      const reconciler = registry.get(reconcilerAgentId);
      const planInputs = createAnonymizedPlanInputs(plans);
      const planAliases = Object.fromEntries(planInputs.map(({ alias, plan }) => [alias, plan.agentId]));
      const anonymizedComparison = anonymizeReconciliationInputValue(
        comparison,
        Object.fromEntries(planInputs.map(({ alias, plan }) => [plan.agentId, alias]))
      );

      if (!reconciler.capabilities.includes("reconcile")) {
        throw new CodeCouncilError(`Agent "${reconciler.id}" does not support reconciliation.`, {
          code: "AGENT_RECONCILE_UNSUPPORTED",
          exitCode: 2
        });
      }

      await appendSessionEvent(session, {
        type: "reconciliation.started",
        agentId: reconciler.id,
        status: "running",
        message: `Started plan reconciliation with ${reconciler.displayName}.`,
        metadata: {
          planCount: plans.length,
          reconcilerAgentId: reconciler.id,
          requestedReconciler
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
        comparison: anonymizedComparison,
        config,
        plans: planInputs,
        repoRoot: runtime.loadedConfig.rootDir,
        session,
        task: session.task
      });
      let reconciliation = deAnonymizeReconciliationOutput(rawReconciliation, planAliases);
      reconciliation = reconciliationOutputSchema.parse({
        ...reconciliation,
        metadata: {
          ...reconciliation.metadata,
          comparisonPath: path.join(session.paths.plansDir, "comparison.json"),
          deterministicBaseline: true,
          planAliases,
          sourcePlanCount: plans.length
        }
      });

      const artifacts = await saveReconciliationArtifacts(session, reconciliation);

      await appendSessionEvent(session, {
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

      writeResult(
        runtime.commandContext,
        {
          artifacts,
          command: "reconcile",
          config: formatConfigSource(runtime.loadedConfig),
          modelSelection,
          reconciliation,
          reconcilerAgentId,
          sessionId: session.id,
          status: "success"
        },
        formatReconcileOutputLines({
          artifacts,
          modelSelection,
          reconciliation,
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

function createAnonymizedPlanInputs(plans: readonly PlanOutput[]): ReconciliationPlanInput[] {
  return plans.map((plan, index) => ({
    alias: `agent-${String.fromCharCode(97 + index)}`,
    plan
  }));
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
    ...formatModelSelectionLines(input.modelSelection),
    `JSON: ${path.relative(input.cwd, input.artifacts.jsonPath) || "."}`,
    `Markdown: ${path.relative(input.cwd, input.artifacts.markdownPath) || "."}`,
    `Next: codecouncil approve --session ${input.session.id} --reconciled`
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
