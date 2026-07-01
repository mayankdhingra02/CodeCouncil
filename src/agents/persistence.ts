import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TaskSession } from "../session/schema.js";
import type { PlanOutput } from "./types.js";

export interface SavedPlanArtifact {
  agentId: string;
  jsonPath: string;
  markdownPath: string;
  metadataPath?: string;
  parsedOutputPath?: string;
  rawOutputPath?: string;
}

export async function savePlanArtifacts(
  session: TaskSession,
  plan: PlanOutput
): Promise<SavedPlanArtifact> {
  await mkdir(session.paths.plansDir, { recursive: true });

  const safeAgentId = plan.agentId.replace(/[^a-z0-9._-]+/gi, "-");
  const jsonPath = path.join(session.paths.plansDir, `${safeAgentId}.json`);
  const markdownPath = path.join(session.paths.plansDir, `${safeAgentId}.md`);
  const metadataPath = path.join(session.paths.plansDir, `${safeAgentId}.command.json`);
  const parsedOutputPath = path.join(session.paths.plansDir, `${safeAgentId}.parsed.json`);
  const rawOutputPath = path.join(session.paths.plansDir, `${safeAgentId}.raw.txt`);

  await writeFile(jsonPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderPlanMarkdown(plan), "utf8");

  const result: SavedPlanArtifact = {
    agentId: plan.agentId,
    jsonPath,
    markdownPath
  };

  if (plan.command || plan.error) {
    await writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          command: plan.command,
          error: plan.error
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    result.metadataPath = metadataPath;
  }

  if (plan.parsedOutput !== undefined) {
    await writeFile(parsedOutputPath, `${JSON.stringify(plan.parsedOutput, null, 2)}\n`, "utf8");
    result.parsedOutputPath = parsedOutputPath;
  }

  if (plan.rawOutput) {
    await writeFile(
      rawOutputPath,
      [`STDOUT`, plan.rawOutput.stdout, "", `STDERR`, plan.rawOutput.stderr, ""].join("\n"),
      "utf8"
    );
    result.rawOutputPath = rawOutputPath;
  }

  return {
    ...result
  };
}

export function renderPlanMarkdown(plan: PlanOutput): string {
  return [
    `# ${plan.displayName} Plan`,
    "",
    `Agent: \`${plan.agentId}\``,
    `Generated: ${plan.generatedAt}`,
    "",
    "## Summary",
    "",
    plan.summary,
    "",
    renderList("Assumptions", plan.assumptions),
    renderList("Proposed Files To Change", plan.proposedFilesToChange),
    renderList("Step By Step Plan", plan.stepByStepPlan),
    renderList("Risks", plan.risks),
    renderList("Tests To Run", plan.testsToRun),
    "## Estimate",
    "",
    `- Complexity: ${plan.estimatedComplexity}`,
    `- Confidence: ${Math.round(plan.confidence * 100)}%`,
    ""
  ].join("\n");
}

function renderList(title: string, items: readonly string[]): string {
  const lines = [`## ${title}`, ""];

  if (items.length === 0) {
    lines.push("- None");
  } else {
    lines.push(...items.map((item) => `- ${item}`));
  }

  lines.push("");
  return lines.join("\n");
}
