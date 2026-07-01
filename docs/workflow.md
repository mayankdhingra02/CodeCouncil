# Workflow

CodeCouncil is built around durable local sessions.

```text
.codecouncil/runs/<session-id>/
```

Each session stores the task, plans, worktrees, diffs, reviews, tests, scores, safety summaries, reports, and event logs.

## Standard Flow

1. Initialize config.
2. Plan with one or more agents.
3. Compare plans.
4. Approve one plan or write a manual approved plan.
5. Implement in isolated worktrees.
6. Run tests.
7. Cross-review diffs.
8. Generate safety summary.
9. Generate final report.
10. Preview manual apply commands.

## Commands

```bash
codecouncil init
codecouncil doctor
codecouncil plan "task" --agents codex,claude
codecouncil approve --session <id> --agent codex
codecouncil implement --session <id> --agents codex,claude
codecouncil test --session <id> --agents codex,claude
codecouncil review --session <id> --reviewers codex,claude --targets codex,claude
codecouncil safety --session <id>
codecouncil report --session <id>
codecouncil apply --session <id> --agent codex --dry-run
```

## Guided Solve

`solve` is a convenience wrapper. By default it stops after planning:

```bash
codecouncil solve "Add password reset flow" --agents codex,claude
```

To continue, pass explicit flags:

```bash
codecouncil solve "Add password reset flow" \
  --agents codex,claude \
  --auto-approve-plan \
  --implement both \
  --run-tests \
  --review \
  --report
```

## Resume

If you forget the next step:

```bash
codecouncil resume --session <id>
```

This inspects artifacts and `workflow.json` to suggest the next command.

## Worktrees

Implementation creates one branch and worktree per agent:

```text
.codecouncil/runs/<session-id>/worktrees/<agent-id>/
codecouncil/<session-slug>/<agent-id>
```

CodeCouncil does not merge, push, or apply these branches automatically.

## Final Report

The final report recommends what to inspect next. It includes:

- task summary
- agents used
- approved plan
- changed files
- test results
- review results
- safety warnings
- score table
- recommendation
- manual inspection/apply commands
