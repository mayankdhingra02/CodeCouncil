# Contributing

Thanks for considering a contribution to CodeCouncil.

CodeCouncil is early, local-first, and safety-sensitive. The core rule is simple: the CLI is the source of truth, and integrations should wrap it rather than duplicate orchestration logic.

## Development Setup

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

## Contribution Areas

- Agent adapters for additional CLIs.
- Better artifact parsing for Codex and Claude output.
- Safer worktree cleanup and apply workflows.
- Benchmark tasks and analysis improvements.
- VS Code wrapper improvements that call the CLI rather than editor extensions.
- Documentation, examples, and safety reviews.

## Pull Request Guidelines

- Keep changes scoped and reviewable.
- Add tests for CLI behavior, schemas, safety checks, and artifact generation.
- Do not add code that reads auth token files or asks users for API keys.
- Do not automate VS Code extensions or scrape UI.
- Do not add auto-merge, auto-push, or destructive cleanup behavior without explicit human approval gates.
- Update docs when command behavior changes.

## Local Safety Expectations

Use temporary repositories for tests. Do not run tests against private projects with real secrets. If you add a new command execution path, document what runs, where it runs, and which files it may touch.
