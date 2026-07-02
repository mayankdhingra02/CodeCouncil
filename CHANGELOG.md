# Changelog

All notable changes to CodeCouncil will be documented here.

The format is inspired by Keep a Changelog, and this project uses semantic versioning once releases begin.

## [Unreleased]

### Added

- TypeScript CLI with modular commands for init, doctor, plan, approve, implement, test, review, safety, report, apply dry-run, solve, resume, sessions, worktrees, and benchmark.
- Config validation with zod and `.codecouncilignore` support.
- Durable session model with JSONL event logging.
- Git worktree management for isolated agent implementation branches.
- Mock Codex and Claude agents for local demos and tests.
- Real Codex CLI and Claude Code CLI adapters through configurable child-process commands.
- Cross-agent review, test execution, implementation scoring, safety summaries, and final reports.
- Optional `codecouncil test --container` mode for Docker-based test execution with worktree-only mounts, explicit setup commands, named-container timeout cleanup, and disabled networking for test commands.
- `codecouncil solve --reconcile` support with persisted internal stage output and failure progress preservation.
- Benchmark mode for comparing single-agent and two-agent workflows.
- Minimal VS Code extension wrapper around the CLI.
- Demo fixture under `examples/demo-repo`.

### Known Limitations

- `apply` is dry-run only.
- Real-agent output parsing is best-effort when CLIs do not return structured JSON.
- Safety checks are defense-in-depth, not a complete sandbox.
- Benchmark conclusions require real task data and human labeling before making claims.
