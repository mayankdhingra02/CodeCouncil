# Safety

CodeCouncil is a local orchestration tool. It is not a complete sandbox.

The safety model is defense-in-depth: reduce accidental damage, preserve evidence, and keep the human in control.

## Core Principles

- Do not read auth token files.
- Do not ask for API keys.
- Do not automate VS Code extensions.
- Do not scrape UI.
- Run official CLIs through child processes.
- Keep implementations in separate git worktrees for diff scoping and review.
- Never merge, push, publish, or apply changes automatically.

## Worktree Isolation Limits

CodeCouncil worktrees are not OS sandboxes. They scope the intended change surface and make diffs reviewable, but the real agent CLI still runs as the local user process.

That means a malicious or prompt-injected agent could try to write outside its worktree unless the provider CLI, operating system, container, or another sandbox prevents it.

CodeCouncil treats worktrees as the organization and audit layer. Enforcement should come from:

- Codex CLI sandbox settings such as `--sandbox read-only` for planning and `--sandbox workspace-write` for implementation.
- Claude Code permission settings such as plan mode for planning and explicit edit permissions for implementation.
- External containers or VMs for untrusted repositories or high-risk tasks.
- Human inspection of the original working tree before applying changes.

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

By default, test commands run agent-authored code from the implementation worktree on the host. Treat this as trusted-code execution.

For higher-risk work, use:

```bash
codecouncil test --session <id> --agents codex,claude --container
```

Containerized test execution mounts the selected agent worktree at `/workspace`,
disables Docker networking, and saves the same test logs/artifacts as host mode.
It uses a locally available Docker image from `testContainer.image`; CodeCouncil
does not pull images or install dependencies automatically. Containers reduce
host exposure, but they are still defense-in-depth rather than a perfect sandbox.

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

- No container sandbox is enabled by default; use `codecouncil test --container` explicitly.
- Git worktrees are not a security boundary.
- Host-mode test execution can run agent-authored code on the host.
- Real agents can still propose bad code.
- Real agent CLIs may have their own behavior outside CodeCouncil's control.
- Redaction catches common secret shapes, not every possible secret.
- Human review remains required before applying changes.
