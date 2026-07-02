# Security

CodeCouncil is designed as a local orchestration tool. It should coordinate trusted local CLIs while avoiding credential handling and unsafe repository mutation.

## Principles

- Do not read private auth token files.
- Do not ask users for API keys.
- Do not scrape UI or control existing VS Code extensions.
- Use official agent CLI commands through child processes.
- Keep each implementation isolated in its own git worktree.
- Require an approved plan before implementation unless the user explicitly bypasses that gate.
- Never merge or apply agent changes without explicit user approval.
- Treat generated plans, diffs, reviews, logs, and reports as sensitive project data.
- Treat all safety features as defense-in-depth, not a perfect sandbox.

## `.codecouncilignore`

CodeCouncil uses config `ignore` patterns plus `.codecouncilignore` to exclude files from prompt context, reports, and future artifact collection. `.codecouncilignore` is similar to `.gitignore`, but scoped to CodeCouncil.

Recommended defaults exclude:

- dependency and build directories
- `.git/`
- `.codecouncil/`
- environment files
- private keys and certificates
- local databases

## Planned Child Process Safety

Agent adapters should:

- call configured commands with explicit arguments
- avoid shell interpolation where possible
- capture stdout/stderr for run artifacts
- redact common secret patterns before writing logs
- time out long-running processes
- keep command execution inside the selected repository or worktree
- never read or manipulate CLI auth token files
- never ask users for credentials

Real Codex and Claude adapters are only invoked through configured CLI commands. CodeCouncil appends a generated public prompt as a normal argument and does not use shell interpolation for agent execution.

Test commands are also executed without shell interpolation. CodeCouncil runs only explicit `--command` values, configured `testCommands`, or detected default test commands. Compound shell syntax such as pipes and `&&` is rejected; configure one test command per entry.

CodeCouncil classifies high-risk command text before running test commands and when scanning saved session artifacts. It flags patterns such as recursive force deletion, `curl | sh`, `wget | sh`, `chmod 777`, `sudo`, `ssh`, `scp`, home-directory credential access, cloud credential setup, package publishing, `git push`, and destructive database commands.

## Git Worktree Safety

CodeCouncil creates agent worktrees under:

```text
.codecouncil/runs/<session-id>/worktrees/<agent-id>/
```

Agent branches are named:

```text
codecouncil/<session-id>/<agent-id>
```

The session id includes a timestamp and task slug, which prevents repeated runs
of the same task from colliding on the same branch name.

Cleanup refuses to remove paths outside the CodeCouncil workspace and does not push anything to remotes. Dirty agent worktrees require explicit `--force` cleanup.

## Implementation Safety

Implementation writes are collected as changed files and patch artifacts before any later review or apply step. CodeCouncil blocks implementation results that touch:

- `.env` and `.env.*`
- private key and credential-like files
- auth, token, secret, or credential paths
- `node_modules/`
- `.git/`
- `.codecouncil/` internals outside the current session
- files ignored by config `ignore` or `.codecouncilignore`
- configured `safety.secretPatterns`

Suspicious filenames such as `.npmrc`, `.pypirc`, SSH config files, or names containing password/private/secret/token produce warnings. CodeCouncil does not push, merge, or apply implementation branches automatically.

## Test Log Safety

Test stdout and stderr are saved locally under the session `tests/` directory. Logs are redacted with the same common secret-pattern redactor used for agent command output, but they should still be treated as sensitive project artifacts.

`codecouncil test --container` optionally runs tests in Docker. It verifies the
configured image exists locally, does not pull images automatically, mounts only
the selected agent worktree at `/workspace`, disables Docker networking for test
commands, and persists the same stdout/stderr/result artifacts as host-mode
tests. Dependency setup requires a prebuilt image or explicit
`--container-setup`; setup commands run before tests with Docker's default
network. Host-installed native dependencies may not work inside a Linux
container. Timed-out container commands are run with deterministic names so
CodeCouncil can kill and remove them. This reduces host exposure, but it is still
defense-in-depth rather than a complete sandbox.

Container mode mounts only the worktree, so git-invoking tests may fail when the
worktree `.git` file points at a git directory outside the mount.

## Review Safety

Cross-agent review is read-only. Review prompts include the task, approved plan, changed file list, diff or high-level diff summary, tests, and safety warnings. Review agents are instructed not to modify files, apply patches, or reveal hidden chain-of-thought.

Large diffs are bounded by `review.maxDiffBytes`; when a patch exceeds the limit, CodeCouncil sends a high-level review context instead of the full patch.

If a diff touches sensitive, suspicious, or ignored files, review receives high-level context instead of the full patch.

## Prompt Injection Guardrails

Agent prompts warn that repository files may contain malicious instructions. Agents are instructed to treat user instructions and CodeCouncil instructions as higher priority than repo-embedded text, avoid secret exfiltration, avoid credential files, and avoid install scripts or destructive commands unless explicitly approved.

These instructions reduce risk but do not make untrusted repository content safe by themselves.

## Safety Reports

`codecouncil safety --session <id>` writes:

```text
.codecouncil/runs/<session-id>/safety/safety-summary.json
.codecouncil/runs/<session-id>/safety/safety-summary.md
```

The report includes sensitive files touched, ignored files touched, risky commands observed in local artifacts, warnings, and recommended manual checks.

## Report And Apply Safety

Final reports are advisory. They recommend which worktree or branch to inspect, but CodeCouncil does not merge, cherry-pick, push, or delete anything.

`codecouncil apply` is dry-run only in this version. It prints the branch, diff, changed files, and manual commands the user can run after inspection.

## Reporting Issues

This is an early local project scaffold. Before using CodeCouncil on important repositories, review the generated config, ignore file, planned commands, and worktree behavior.
