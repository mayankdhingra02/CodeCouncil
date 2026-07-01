export type CommandRiskSeverity = "medium" | "high" | "critical";

export interface DangerousCommandFinding {
  command: string;
  reason: string;
  severity: CommandRiskSeverity;
}

interface CommandRiskRule {
  pattern: RegExp;
  reason: string;
  severity: CommandRiskSeverity;
}

const COMMAND_RISK_RULES: readonly CommandRiskRule[] = [
  {
    pattern: /\brm\s+-[^\n]*(?:r[^\n]*f|f[^\n]*r)[^\n]*(?:\s\/|\s~|\s\.\.|\s\*)/iu,
    reason: "recursive force deletion",
    severity: "critical"
  },
  {
    pattern: /\b(?:curl|wget)\b[^\n|]*(?:\|\s*(?:sh|bash|zsh|python|node)\b)/iu,
    reason: "downloaded script piped to an interpreter",
    severity: "critical"
  },
  {
    pattern: /\bchmod\s+777\b/iu,
    reason: "world-writable permissions",
    severity: "high"
  },
  {
    pattern: /(?:^|\s)sudo(?:\s|$)/iu,
    reason: "privileged command execution",
    severity: "high"
  },
  {
    pattern: /(?:^|\s)(?:ssh|scp|sftp|rsync)\b/iu,
    reason: "remote shell or file transfer command",
    severity: "medium"
  },
  {
    pattern: /(?:~\/|\/Users\/[^/\s]+\/)(?:\.ssh|\.aws|\.azure|\.kube|\.config\/gcloud|\.gnupg|Library\/Application Support)/iu,
    reason: "accesses home-directory credential or session storage",
    severity: "high"
  },
  {
    pattern: /\b(?:aws\s+configure|gcloud\s+auth|az\s+login|kubectl\s+config)\b/iu,
    reason: "cloud credential or cluster configuration command",
    severity: "high"
  },
  {
    pattern: /\bgit\s+push\b/iu,
    reason: "pushes code to a remote",
    severity: "high"
  },
  {
    pattern: /\b(?:npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bgem\s+push\b/iu,
    reason: "publishes a package",
    severity: "high"
  },
  {
    pattern: /\b(?:drop\s+database|drop\s+table|truncate\s+table|delete\s+from\s+\S+\s*;|flushall|flushdb|prisma\s+migrate\s+reset|rails\s+db:drop|sequelize\s+db:drop|dropDatabase\s*\()/iu,
    reason: "destructive database command",
    severity: "critical"
  }
];

export function classifyDangerousCommand(commandLine: string): DangerousCommandFinding[] {
  const findings = [];

  for (const rule of COMMAND_RISK_RULES) {
    if (rule.pattern.test(commandLine)) {
      findings.push({
        command: commandLine.trim(),
        reason: rule.reason,
        severity: rule.severity
      });
    }
  }

  return findings;
}

export function scanTextForDangerousCommands(
  text: string,
  source = "text"
): DangerousCommandFinding[] {
  const findings = [];

  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    for (const finding of classifyDangerousCommand(trimmed)) {
      findings.push({
        ...finding,
        command: `${source}: ${finding.command}`
      });
    }
  }

  return dedupeFindings(findings);
}

export function hasHighRiskCommand(commandLine: string): boolean {
  return classifyDangerousCommand(commandLine).some(
    (finding) => finding.severity === "high" || finding.severity === "critical"
  );
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
