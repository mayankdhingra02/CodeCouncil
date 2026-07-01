import path from "node:path";

export interface FileChangeSafetyResult {
  blockedFiles: string[];
  ignoredFiles: string[];
  safeFiles: string[];
  suspiciousFiles: string[];
  warnings: string[];
}

export interface FilePathSafetyClassification {
  blocked: boolean;
  filePath: string;
  ignored: boolean;
  reasons: string[];
  suspicious: boolean;
}

export interface FileChangeSafetyOptions {
  currentSessionDir?: string;
  ignoreMatcher?: {
    ignores(filePath: string): boolean;
  };
  secretPatterns?: readonly string[];
}

interface FileRule {
  action: "block" | "warn";
  label: string;
  pattern: RegExp;
}

const BLOCKED_FILE_RULES: readonly FileRule[] = [
  { action: "block", label: "environment file", pattern: /(?:^|\/)\.env(?:\.|$)/iu },
  { action: "block", label: "git metadata", pattern: /(?:^|\/)\.git(?:\/|$)/iu },
  { action: "block", label: "dependency directory", pattern: /(?:^|\/)node_modules(?:\/|$)/iu },
  { action: "block", label: "private key or certificate", pattern: /\.(?:pem|key|p12|pfx)$/iu },
  { action: "block", label: "ssh private key", pattern: /(?:^|\/)(?:id_rsa|id_ed25519)$/iu },
  { action: "block", label: "credential json", pattern: /(?:^|\/)credentials\.json$/iu },
  { action: "block", label: "cloud credential", pattern: /(?:^|\/)\.aws\/(?:credentials|config)$/iu },
  { action: "block", label: "cloud credential", pattern: /(?:^|\/)\.config\/gcloud(?:\/|$)/iu },
  { action: "block", label: "cloud credential", pattern: /(?:^|\/)\.azure(?:\/|$)/iu },
  { action: "block", label: "kubernetes credential", pattern: /(?:^|\/)\.kube\/config$/iu },
  { action: "block", label: "ssh config", pattern: /(?:^|\/)\.ssh\/(?:config|known_hosts)$/iu },
  {
    action: "block",
    label: "token or credential file",
    pattern: /(?:^|\/)(?:access[-_.]?token|refresh[-_.]?token|session[-_.]?token|auth[-_.]?token|api[-_.]?key)(?:\.[a-z0-9]+)?$/iu
  },
  {
    action: "block",
    label: "secret directory",
    pattern: /(?:^|\/)(?:secrets?|credentials?|tokens?)(?:\/|$)/iu
  },
  {
    action: "block",
    label: "browser session store",
    pattern: /(?:^|\/)(?:cookies|login data|session storage|local storage|web data)(?:\.[a-z0-9]+)?$/iu
  }
];

const SUSPICIOUS_FILE_RULES: readonly FileRule[] = [
  { action: "warn", label: "package registry credential", pattern: /(?:^|\/)\.npmrc$/iu },
  { action: "warn", label: "package registry credential", pattern: /(?:^|\/)\.pypirc$/iu },
  { action: "warn", label: "ssh file", pattern: /(?:^|\/)(?:known_hosts|ssh_config)$/iu },
  { action: "warn", label: "possible secret", pattern: /(?:password|private|secret|token|credential|session)/iu },
  { action: "warn", label: "auth-related data file", pattern: /(?:^|\/)auth(?:\.(?:json|yaml|yml|env|txt)|\/)/iu }
];

export function classifyChangedFiles(
  changedFiles: readonly string[],
  options: FileChangeSafetyOptions = {}
): FileChangeSafetyResult {
  const classifications = changedFiles.map((filePath) => classifyFilePath(filePath, options));
  const blockedFiles = classifications
    .filter((classification) => classification.blocked || classification.ignored)
    .map((classification) => classification.filePath);
  const ignoredFiles = classifications
    .filter((classification) => classification.ignored)
    .map((classification) => classification.filePath);
  const suspiciousFiles = classifications
    .filter((classification) => !classification.blocked && !classification.ignored && classification.suspicious)
    .map((classification) => classification.filePath);
  const safeFiles = classifications
    .filter((classification) => !classification.blocked && !classification.ignored && !classification.suspicious)
    .map((classification) => classification.filePath);

  return {
    blockedFiles: unique(blockedFiles),
    ignoredFiles: unique(ignoredFiles),
    safeFiles: unique(safeFiles),
    suspiciousFiles: unique(suspiciousFiles),
    warnings: buildWarnings(classifications)
  };
}

export function classifyFilePath(
  filePath: string,
  options: FileChangeSafetyOptions = {}
): FilePathSafetyClassification {
  const normalizedPath = normalizeFilePath(filePath);
  const ignored = options.ignoreMatcher?.ignores(normalizedPath) === true;
  const reasons = [];
  let blocked = false;
  let suspicious = false;

  for (const rule of BLOCKED_FILE_RULES) {
    if (rule.pattern.test(normalizedPath)) {
      blocked = true;
      reasons.push(rule.label);
    }
  }

  for (const pattern of options.secretPatterns ?? []) {
    const regex = compileUserPattern(pattern);

    if (regex?.test(normalizedPath)) {
      blocked = true;
      reasons.push(`configured secret pattern: ${pattern}`);
    }
  }

  if (normalizedPath === ".codecouncil" || normalizedPath.startsWith(".codecouncil/")) {
    if (!options.currentSessionDir || !normalizedPath.startsWith(normalizeFilePath(options.currentSessionDir))) {
      blocked = true;
      reasons.push("CodeCouncil workspace internals outside the current session");
    }
  }

  for (const rule of SUSPICIOUS_FILE_RULES) {
    if (rule.pattern.test(normalizedPath)) {
      suspicious = true;
      reasons.push(rule.label);
    }
  }

  if (ignored) {
    reasons.push("matches CodeCouncil ignore rules");
  }

  return {
    blocked,
    filePath: normalizedPath,
    ignored,
    reasons: unique(reasons),
    suspicious
  };
}

function buildWarnings(classifications: readonly FilePathSafetyClassification[]): string[] {
  const warnings = [];

  for (const classification of classifications) {
    if (classification.ignored) {
      warnings.push(`Changed file matches CodeCouncil ignore rules: ${classification.filePath}`);
    } else if (classification.suspicious) {
      warnings.push(
        `Suspicious changed file: ${classification.filePath} (${classification.reasons.join(", ")})`
      );
    }
  }

  return unique(warnings);
}

function compileUserPattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, "iu");
  } catch {
    return undefined;
  }
}

function normalizeFilePath(filePath: string): string {
  return filePath.split(path.sep).join("/").replace(/^\.\/+/u, "");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
