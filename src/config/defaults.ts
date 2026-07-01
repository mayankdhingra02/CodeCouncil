import {
  DEFAULT_IGNORE_PATTERNS,
  codeCouncilConfigSchema,
  type CodeCouncilConfig
} from "./schema.js";

export const DEFAULT_CODEC_COUNCIL_IGNORE = `${[
  "# Files CodeCouncil should avoid passing into agent prompts or reports.",
  ...DEFAULT_IGNORE_PATTERNS,
  "*.pem",
  "*.key",
  "*.p12",
  "*.sqlite",
  "*.db",
  ""
].join("\n")}`;

export interface CreateDefaultConfigOptions {
  projectName?: string;
}

export function createDefaultConfig(options: CreateDefaultConfigOptions = {}): CodeCouncilConfig {
  return codeCouncilConfigSchema.parse({
    projectName: options.projectName ?? "codecouncil-project"
  });
}

export function serializeDefaultConfig(options: CreateDefaultConfigOptions = {}): string {
  return `${JSON.stringify(createDefaultConfig(options), null, 2)}\n`;
}
