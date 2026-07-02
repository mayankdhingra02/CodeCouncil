import path from "node:path";

import type { AgentConfig, AgentId } from "../config/schema.js";
import { CodeCouncilError } from "../core/errors.js";
import { getAgentStageModel, injectModelArg } from "../core/modelSelection.js";
import {
  buildImplementationOutputFromCommand,
  buildPlanOutputFromCommand,
  buildReviewOutputFromCommand
} from "./outputParsing.js";
import {
  createImplementationPrompt,
  createPlanningPrompt,
  createReviewPrompt
} from "./prompts.js";
import {
  ExecaAgentCommandRunner,
  type AgentCommandRunner
} from "./commandRunner.js";
import type {
  AgentAvailability,
  AgentCapability,
  CodeCouncilAgent,
  ImplementationInput,
  ImplementationOutput,
  PlanInput,
  PlanOutput,
  ReviewInput,
  ReviewOutput
} from "./types.js";

interface CliAgentOptions {
  config: AgentConfig;
  displayName: string;
  id: AgentId;
  installHint: string;
  runner?: AgentCommandRunner;
}

export class CliAgent implements CodeCouncilAgent {
  public readonly capabilities: readonly AgentCapability[] = ["plan", "implement", "review"];
  public readonly config: AgentConfig;
  public readonly displayName: string;
  public readonly id: AgentId;
  private readonly installHint: string;
  private readonly runner: AgentCommandRunner;

  public constructor(options: CliAgentOptions) {
    this.config = options.config;
    this.displayName = options.displayName;
    this.id = options.id;
    this.installHint = options.installHint;
    this.runner = options.runner ?? new ExecaAgentCommandRunner();
  }

  public async checkAvailability(): Promise<AgentAvailability> {
    const available = await this.runner.isCommandAvailable(this.config.command);

    if (!available) {
      return {
        available: false,
        command: this.config.command,
        metadata: {},
        reason: `${this.displayName} command "${this.config.command}" was not found on PATH. ${this.installHint}`
      };
    }

    return {
      available: true,
      command: this.config.command,
      metadata: {}
    };
  }

  public async generatePlan(input: PlanInput): Promise<PlanOutput> {
    const prompt = createPlanningPrompt(input);
    const args = buildPromptArgs({
      command: this.config.command,
      args: injectModelArg(this.config.planArgs, getAgentStageModel(this.config, "plan"))
    });
    const result = await this.runner.run({
      args,
      command: this.config.command,
      cwd: input.repoRoot,
      input: prompt,
      timeoutMs: this.config.maxRuntimeSeconds * 1000
    });

    return buildPlanOutputFromCommand({
      agentId: this.id,
      displayName: this.displayName,
      result
    });
  }

  public async implementTask(input: ImplementationInput): Promise<ImplementationOutput> {
    if (path.resolve(input.worktreePath) === path.resolve(input.repoRoot)) {
      throw new CodeCouncilError(
        `Refusing to run ${this.displayName} implementation in the original working tree.`,
        {
          code: "AGENT_IMPLEMENT_REQUIRES_WORKTREE",
          exitCode: 2
        }
      );
    }

    const prompt = createImplementationPrompt(input);
    const args = buildPromptArgs({
      command: this.config.command,
      args: injectModelArg(this.config.implementArgs, getAgentStageModel(this.config, "implement"))
    });
    const result = await this.runner.run({
      args,
      command: this.config.command,
      cwd: input.worktreePath,
      input: prompt,
      timeoutMs: this.config.maxRuntimeSeconds * 1000
    });

    return buildImplementationOutputFromCommand({
      agentId: this.id,
      displayName: this.displayName,
      result
    });
  }

  public async reviewDiff(input: ReviewInput): Promise<ReviewOutput> {
    const prompt = createReviewPrompt(input);
    const args = buildPromptArgs({
      command: this.config.command,
      args: injectModelArg(this.config.reviewArgs, getAgentStageModel(this.config, "review"))
    });
    const result = await this.runner.run({
      args,
      command: this.config.command,
      cwd: input.repoRoot,
      input: prompt,
      timeoutMs: this.config.maxRuntimeSeconds * 1000
    });

    return buildReviewOutputFromCommand({
      agentId: this.id,
      displayName: this.displayName,
      result,
      targetAgentId: input.targetAgentId
    });
  }
}

export function createCodexAgent(
  id: AgentId,
  config: AgentConfig,
  runner?: AgentCommandRunner
): CodeCouncilAgent {
  return new CliAgent({
    config,
    displayName: "OpenAI Codex CLI",
    id,
    installHint: "Install and authenticate OpenAI Codex CLI separately, then rerun CodeCouncil.",
    ...(runner ? { runner } : {})
  });
}

function buildPromptArgs(input: { args: readonly string[]; command: string }): string[] {
  const args = [...input.args];

  if (shouldUseCodexStdinSentinel(input.command, args)) {
    return [...args, "-"];
  }

  return args;
}

function shouldUseCodexStdinSentinel(command: string, args: readonly string[]): boolean {
  const executable = path.basename(command).toLowerCase();

  return executable === "codex" && args[0] === "exec" && !args.includes("-");
}

export function createClaudeCodeAgent(
  id: AgentId,
  config: AgentConfig,
  runner?: AgentCommandRunner
): CodeCouncilAgent {
  return new CliAgent({
    config,
    displayName: "Anthropic Claude Code CLI",
    id,
    installHint: "Install and authenticate Claude Code separately, then rerun CodeCouncil.",
    ...(runner ? { runner } : {})
  });
}
