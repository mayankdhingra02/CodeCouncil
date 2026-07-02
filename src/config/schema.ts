import { z } from "zod";

export const CONFIG_FILE_NAMES = [
  "codecouncil.config.json",
  ".codecouncilrc.json"
] as const;

export const DEFAULT_IGNORE_PATTERNS = [
  ".env",
  ".env.*",
  "node_modules",
  ".git",
  ".codecouncil"
] as const;

export const agentIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, "Use letters, numbers, dots, underscores, or dashes.");

export const agentConfigSchema = z
  .object({
    adapter: agentIdSchema.optional(),
    enabled: z.boolean().default(true),
    command: z.string().min(1, "Agent command is required."),
    model: z.string().min(1).optional(),
    models: z
      .object({
        plan: z.string().min(1).optional(),
        implement: z.string().min(1).optional(),
        reconcile: z.string().min(1).optional(),
        review: z.string().min(1).optional()
      })
      .strict()
      .default({}),
    planArgs: z.array(z.string()).default([]),
    implementArgs: z.array(z.string()).default([]),
    reconcileArgs: z.array(z.string()).default([]),
    reviewArgs: z.array(z.string()).default([]),
    maxRuntimeSeconds: z.number().int().positive().default(900)
  })
  .strict();

const defaultAgentInputs = {
  "mock-codex": {
    enabled: true,
    command: "mock-codex",
    planArgs: [],
    implementArgs: [],
    reconcileArgs: [],
    reviewArgs: [],
    maxRuntimeSeconds: 900
  },
  "mock-claude": {
    enabled: true,
    command: "mock-claude",
    planArgs: [],
    implementArgs: [],
    reconcileArgs: [],
    reviewArgs: [],
    maxRuntimeSeconds: 900
  }
} satisfies Record<string, z.input<typeof agentConfigSchema>>;

export const codeCouncilConfigSchema = z
  .object({
    projectName: z.string().min(1, "Project name is required."),
    baseBranch: z.string().min(1).default("main"),
    workspaceDir: z.string().min(1).default(".codecouncil"),
    agents: z
      .record(agentIdSchema, agentConfigSchema)
      .refine((agents) => Object.keys(agents).length > 0, "At least one agent must be configured.")
      .default(defaultAgentInputs),
    testCommands: z.array(z.string().min(1)).default([]),
    testContainer: z
      .object({
        image: z.string().min(1).default("node:20-bookworm-slim"),
        setupCommands: z.array(z.string().min(1)).default([]),
        timeoutSeconds: z.number().int().positive().default(600)
      })
      .strict()
      .default({}),
    ignore: z.array(z.string().min(1)).default([...DEFAULT_IGNORE_PATTERNS]),
    review: z
      .object({
        maxDiffBytes: z.number().int().positive().default(120_000)
      })
      .strict()
      .default({}),
    safety: z
      .object({
        requireApprovalBeforeApply: z.boolean().default(true),
        blockSecretFiles: z.boolean().default(true),
        createCommitOnImplementation: z.boolean().default(false),
        defaultPlanModeReadOnly: z.boolean().default(true),
        allowImplementationByDefault: z.boolean().default(false),
        secretPatterns: z.array(z.string().min(1)).default([])
      })
      .strict()
      .default({})
  })
  .strict();

export type AgentId = z.infer<typeof agentIdSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type CodeCouncilConfig = z.infer<typeof codeCouncilConfigSchema>;
