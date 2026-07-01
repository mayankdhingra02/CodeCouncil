const NAMED_SECRET_PATTERN =
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|bearer|client[_-]?secret|private[_-]?key|session)\s*[:=]\s*)(["']?)[^\s"',}]+/giu;
const JSON_SECRET_PATTERN =
  /("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|client[_-]?secret|private[_-]?key|session)"?\s*:\s*)(["'])[^"']+\2/giu;
const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[^\s"',}]+/giu;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu;
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{20,}\b/gu;
const GITHUB_TOKEN_PATTERN = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu;

export function redactSecrets(value: string): string {
  let redacted = value
    .replace(PRIVATE_KEY_BLOCK_PATTERN, "[REDACTED_PRIVATE_KEY]")
    .replace(JSON_SECRET_PATTERN, "$1$2[REDACTED]$2")
    .replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]")
    .replace(NAMED_SECRET_PATTERN, "$1$2[REDACTED]")
    .replace(AWS_ACCESS_KEY_PATTERN, "[REDACTED_AWS_KEY]")
    .replace(OPENAI_KEY_PATTERN, "[REDACTED_OPENAI_KEY]")
    .replace(GITHUB_TOKEN_PATTERN, "[REDACTED_GITHUB_TOKEN]")
    .replace(SLACK_TOKEN_PATTERN, "[REDACTED_SLACK_TOKEN]")
    .replace(JWT_PATTERN, "[REDACTED_JWT]");

  for (const [name, envValue] of Object.entries(process.env)) {
    if (!envValue || envValue.length < 8 || !isSensitiveEnvName(name)) {
      continue;
    }

    redacted = redacted.split(envValue).join("[REDACTED]");
  }

  return redacted;
}

function isSensitiveEnvName(name: string): boolean {
  return /(?:key|token|secret|password|auth|credential|session|cookie|private)/iu.test(name);
}
