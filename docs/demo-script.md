# Demo Script

This script shows CodeCouncil's core workflow using mock agents.

## 1. Build And Link

```bash
pnpm install
pnpm build
pnpm link --global
codecouncil --help
```

## 2. Prepare Demo Repository

```bash
cd examples/demo-repo
git init
git symbolic-ref HEAD refs/heads/main
git add .
git commit -m "initial demo app"
npm test
```

## 3. Initialize CodeCouncil

```bash
codecouncil init
codecouncil doctor
```

Talking point: CodeCouncil is local-first and calls only local CLIs.

## 4. Plan With Two Agents

```bash
codecouncil plan "Add password complexity validation" --agents mock-codex,mock-claude
```

Open:

```text
.codecouncil/runs/<session-id>/plans/comparison.md
```

Talking point: Plans are structured and persisted for review.

## 5. Reconcile And Approve

```bash
codecouncil reconcile --session <session-id> --reconciler mock-codex
# Optional research-oriented variant:
codecouncil reconcile --session <session-id> --strategy rotate
codecouncil approve --session <session-id> --reconciled
```

Open:

```text
.codecouncil/runs/<session-id>/plans/reconciled.md
.codecouncil/runs/<session-id>/plans/reconciliation-rotation.md
.codecouncil/runs/<session-id>/approved-plan.md
```

Talking point: reconciliation proposes a merged plan, and rotate mode compares reconciler bias across agents, but implementation is still gated by explicit human approval.

## 6. Implement In Worktrees

```bash
codecouncil implement --session <session-id> --agents mock-codex,mock-claude
```

Open:

```text
.codecouncil/runs/<session-id>/diffs/mock-codex.patch
.codecouncil/runs/<session-id>/runs/mock-codex/implementation.json
```

Talking point: each agent gets its own branch and worktree.

## 7. Run Tests

```bash
codecouncil test --session <session-id> --agents mock-codex,mock-claude
```

Open:

```text
.codecouncil/runs/<session-id>/tests/summary.md
.codecouncil/runs/<session-id>/scores/implementation-scores.md
```

Talking point: tests matter more than model confidence.

## 8. Cross-Review

```bash
codecouncil review --session <session-id> --reviewers mock-codex,mock-claude --targets mock-codex,mock-claude
```

Open:

```text
.codecouncil/runs/<session-id>/reviews/summary.md
```

Talking point: agents can critique each other's diffs, but review remains advisory.

## 9. Safety And Report

```bash
codecouncil safety --session <session-id>
codecouncil report --session <session-id>
```

Open:

```text
.codecouncil/runs/<session-id>/safety/safety-summary.md
.codecouncil/runs/<session-id>/reports/final-report.md
```

Talking point: CodeCouncil recommends what to inspect; it does not merge.

## 10. Dry-Run Apply

```bash
codecouncil apply --session <session-id> --agent mock-codex --dry-run
```

Talking point: the human remains the final gate.

## Optional: Guided Workflow

```bash
codecouncil solve "Add password complexity validation" --agents mock-codex,mock-claude
codecouncil resume --session <session-id>
```

## Optional: Benchmark

From the repository root:

```bash
codecouncil benchmark --tasks examples/benchmark.tasks.json --agents mock-codex,mock-claude --strategies codex_only,both_implement_then_review_and_select
```
