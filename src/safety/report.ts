import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isErrnoException } from "../core/errors.js";
import type { TaskSession } from "../session/index.js";
import { scanTextForDangerousCommands, type DangerousCommandFinding } from "./commands.js";
import {
  classifyChangedFiles,
  classifyFilePath,
  type FilePathSafetyClassification
} from "./fileChanges.js";

export interface SafetySummary {
  generatedAt: string;
  ignoredFiles: string[];
  recommendedManualChecks: string[];
  riskyCommands: DangerousCommandFinding[];
  sensitiveFilesTouched: FilePathSafetyClassification[];
  sessionId: string;
  warnings: string[];
}

export interface SaveSafetySummaryResult {
  jsonPath: string;
  markdownPath: string;
  summary: SafetySummary;
}

export async function generateSafetySummary(options: {
  ignoreMatcher?: {
    ignores(filePath: string): boolean;
  };
  secretPatterns?: readonly string[];
  session: TaskSession;
}): Promise<SafetySummary> {
  const changedFiles = await loadChangedFiles(options.session);
  const classifierOptions = {
    ...(options.ignoreMatcher ? { ignoreMatcher: options.ignoreMatcher } : {}),
    ...(options.secretPatterns ? { secretPatterns: options.secretPatterns } : {})
  };
  const safety = classifyChangedFiles(changedFiles, classifierOptions);
  const sensitiveFilesTouched = changedFiles
    .map((filePath) => classifyFilePath(filePath, classifierOptions))
    .filter((classification) => classification.blocked || classification.ignored || classification.suspicious);
  const riskyCommands = await scanSessionArtifactsForRiskyCommands(options.session);
  const warnings = [
    "Git worktrees scope intended diffs, but they are not OS sandboxes and do not prevent an agent CLI from accessing other user-writable paths.",
    "Configured test commands execute code from agent worktrees on the host; use external sandboxing or containers for untrusted code.",
    ...safety.warnings,
    ...sensitiveFilesTouched
      .filter((classification) => classification.blocked && !classification.ignored)
      .map((classification) => `Sensitive file touched: ${classification.filePath} (${classification.reasons.join(", ")})`),
    ...riskyCommands.map((finding) => `Risky command observed: ${finding.command} (${finding.reason})`)
  ];

  return {
    generatedAt: new Date().toISOString(),
    ignoredFiles: safety.ignoredFiles,
    recommendedManualChecks: buildManualChecks(sensitiveFilesTouched, riskyCommands),
    riskyCommands,
    sensitiveFilesTouched,
    sessionId: options.session.id,
    warnings: unique(warnings)
  };
}

export async function saveSafetySummary(options: {
  ignoreMatcher?: {
    ignores(filePath: string): boolean;
  };
  secretPatterns?: readonly string[];
  session: TaskSession;
}): Promise<SaveSafetySummaryResult> {
  const summary = await generateSafetySummary(options);
  const safetyDir = path.join(options.session.paths.sessionDir, "safety");
  const jsonPath = path.join(safetyDir, "safety-summary.json");
  const markdownPath = path.join(safetyDir, "safety-summary.md");

  await mkdir(safetyDir, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderSafetySummaryMarkdown(summary), "utf8");

  return {
    jsonPath,
    markdownPath,
    summary
  };
}

export function renderSafetySummaryMarkdown(summary: SafetySummary): string {
  return `${[
    "# Safety Summary",
    "",
    `Session: ${summary.sessionId}`,
    `Generated: ${summary.generatedAt}`,
    "",
    "This is defense-in-depth, not a guarantee of perfect security.",
    "",
    renderList("Sensitive Files Touched", summary.sensitiveFilesTouched.map(formatSensitiveFile)),
    renderList("Ignored Files Touched", summary.ignoredFiles),
    renderList("Risky Commands Observed", summary.riskyCommands.map(formatRiskyCommand)),
    renderList("Warnings", summary.warnings),
    renderList("Recommended Manual Checks", summary.recommendedManualChecks)
  ].join("\n")}\n`;
}

async function loadChangedFiles(session: TaskSession): Promise<string[]> {
  const runsDir = path.join(session.paths.sessionDir, "runs");
  const changedFiles = [];

  let entries;

  try {
    entries = await readdir(runsDir, {
      withFileTypes: true
    });
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const implementationPath = path.join(runsDir, entry.name, "implementation.json");

    try {
      const parsed = JSON.parse(await readFile(implementationPath, "utf8")) as {
        changedFiles?: unknown;
      };

      if (Array.isArray(parsed.changedFiles)) {
        changedFiles.push(...parsed.changedFiles.filter((file): file is string => typeof file === "string"));
      }
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return unique(changedFiles);
}

async function scanSessionArtifactsForRiskyCommands(session: TaskSession): Promise<DangerousCommandFinding[]> {
  const directories = [
    session.paths.plansDir,
    path.join(session.paths.sessionDir, "runs"),
    session.paths.diffsDir,
    session.paths.reviewsDir,
    session.paths.testsDir,
    session.paths.reportsDir
  ];
  const findings = [];

  for (const directoryPath of directories) {
    findings.push(...(await scanDirectory(directoryPath, session.paths.sessionDir)));
  }

  return dedupeFindings(findings);
}

async function scanDirectory(directoryPath: string, sessionDir: string): Promise<DangerousCommandFinding[]> {
  let entries;

  try {
    entries = await readdir(directoryPath, {
      withFileTypes: true
    });
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const findings = [];

  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "worktrees" || entry.name === "safety") {
        continue;
      }

      findings.push(...(await scanDirectory(absolutePath, sessionDir)));
      continue;
    }

    if (!entry.isFile() || !isScannableArtifact(entry.name)) {
      continue;
    }

    const sourceLabel = path.relative(sessionDir, absolutePath).split(path.sep).join("/");
    const source = await readFile(absolutePath, "utf8");
    findings.push(...scanTextForDangerousCommands(source.slice(0, 1_000_000), sourceLabel));
  }

  return findings;
}

function isScannableArtifact(fileName: string): boolean {
  return /\.(?:json|md|txt|log|patch)$/iu.test(fileName);
}

function buildManualChecks(
  sensitiveFiles: readonly FilePathSafetyClassification[],
  riskyCommands: readonly DangerousCommandFinding[]
): string[] {
  const checks = [
    "Inspect implementation worktrees before applying any changes.",
    "Run tests from a clean shell before merging.",
    "Review diffs for unexpected file changes and generated code.",
    "Check the original working tree for unexpected modifications after real-agent implementation.",
    "Use provider CLI sandbox/permission settings or containers when running untrusted agent output."
  ];

  if (sensitiveFiles.length > 0) {
    checks.push("Review sensitive or ignored file touches and rotate credentials if secrets may have been exposed.");
  }

  if (riskyCommands.length > 0) {
    checks.push("Review risky commands observed in agent output or logs; do not run them without understanding impact.");
  }

  return checks;
}

function formatSensitiveFile(classification: FilePathSafetyClassification): string {
  return `${classification.filePath} (${classification.reasons.join(", ")})`;
}

function formatRiskyCommand(finding: DangerousCommandFinding): string {
  return `${finding.severity}: ${finding.command} (${finding.reason})`;
}

function renderList(title: string, items: readonly string[]): string {
  return [
    `## ${title}`,
    "",
    ...(items.length > 0 ? items.map((item) => `- ${item}`) : ["- None reported."]),
    ""
  ].join("\n");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function dedupeFindings(findings: readonly DangerousCommandFinding[]): DangerousCommandFinding[] {
  const seen = new Set<string>();
  const result = [];

  for (const finding of findings) {
    const key = `${finding.severity}:${finding.reason}:${finding.command}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(finding);
  }

  return result;
}
