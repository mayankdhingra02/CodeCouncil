# Safety

CodeCouncil is a local orchestration tool. It is not a complete sandbox.

The safety model is defense-in-depth: reduce accidental damage, preserve evidence, and keep the human in control.

## Core Principles

- Do not read auth token files.
- Do not ask for API keys.
- Do not automate VS Code extensions.
- Do not scrape UI.
- Run official CLIs through child processes.
- Keep implementations in isolated git worktrees.
- Never merge, push, publish, or apply changes automatically.

## Sensitive Files

CodeCouncil blocks or warns on paths such as:

- `.env`
- `.env.*`
- `*.pem`
- `*.key`
- `id_rsa`
- `id_ed25519`
- `credentials.json`
- token/auth/secret/credential paths
- SSH config
- browser/session files
- `.git`
- `node_modules`
- CodeCouncil internals outside the current session

Projects can add `safety.secretPatterns` and `.codecouncilignore` entries.

## Command Safety

For v0.1, CodeCouncil itself runs:

- known git commands
- configured or detected test commands
- configured agent CLI commands

Test commands are parsed into argv and executed without shell interpolation. CodeCouncil rejects compound shell syntax such as pipes and `&&`.

Saved artifacts are scanned for suspicious command text such as:

- `rm -rf`
- `curl | sh`
- `wget | sh`
- `chmod 777`
- `sudo`
- `ssh` and `scp`
- `git push`
- package publish commands
- cloud credential commands
- destructive database commands

## Prompt Injection Guardrails

Agent prompts explicitly warn that repository files may contain malicious instructions. Agents are told not to exfiltrate secrets, not to modify credentials, and to prioritize the user's task over repo-embedded instructions.

This helps, but it is not a substitute for sandboxing or human review.

## Reports

Run:

```bash
codecouncil safety --session <id>
```

Artifacts:

```text
.codecouncil/runs/<session-id>/safety/safety-summary.json
.codecouncil/runs/<session-id>/safety/safety-summary.md
```

## Current Limits

- No container sandbox is enabled by default.
- Real agents can still propose bad code.
- Real agent CLIs may have their own behavior outside CodeCouncil's control.
- Redaction catches common secret shapes, not every possible secret.
- Human review remains required before applying changes.
