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
4. Optionally reconcile competing plans into one candidate proposal.
5. Approve one plan, approve the reconciled plan, or write a manual approved plan.
6. Implement in isolated worktrees.
7. Run tests.
8. Cross-review diffs.
9. Generate safety summary.
10. Generate final report.
11. Preview manual apply commands.

## Commands

```bash
codecouncil init
codecouncil doctor
codecouncil models list
codecouncil plan "task" --agents codex,claude
codecouncil reconcile --session <id> --reconciler codex
codecouncil reconcile --session <id> --strategy rotate
codecouncil approve --session <id> --reconciled
codecouncil approve --session <id> --agent codex
codecouncil implement --session <id> --agents codex,claude
codecouncil test --session <id> --agents codex,claude
codecouncil review --session <id> --reviewers codex,claude --targets codex,claude
codecouncil safety --session <id>
codecouncil report --session <id>
codecouncil apply --session <id> --agent codex --dry-run
```

## Reconciliation Strategies

Single reconciliation asks one agent to synthesize the competing plans:

```bash
codecouncil reconcile --session <id> --reconciler codex
```

Rotated reconciliation asks each enabled source-plan agent to reconcile the same
plans independently, writes per-reconciler candidates under
`plans/rotations/`, writes `plans/reconciliation-rotation.md`, and copies the
recommended candidate to `plans/reconciled.json` for explicit approval:

```bash
codecouncil reconcile --session <id> --strategy rotate
```

The recommendation is deterministic: CodeCouncil favors more synthesis
selections, fewer own-plan selections, fewer open questions, then higher
confidence. This ranking measures reconciliation/deference behavior, not
correctness. Use it as a bias signal for human review, not as an automatic
decision.

## Guided Solve

`solve` is a convenience wrapper. By default it stops after planning:

```bash
codecouncil solve "Add password reset flow" --agents codex,claude
```

To continue, pass explicit flags:

```bash
codecouncil solve "Add password reset flow" \
  --agents codex,claude \
  --models codex=gpt-5.4-mini,claude=sonnet \
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
