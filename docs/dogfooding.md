# Dogfooding CodeCouncil

This document summarizes a real CodeCouncil run against `examples/demo-repo`
using the actual Codex CLI and Claude Code CLI. It is written as a PR-style
engineering note: what we tested, what happened, what changed, and what the
evidence does and does not prove.

## Summary

We used CodeCouncil to coordinate Codex and Claude on a small password-validation
task:

> Add password complexity validation and tests for missing uppercase, lowercase,
> and number requirements.

The workflow ran end to end:

1. Doctor checks
2. Independent planning by Codex and Claude
3. Deterministic plan comparison
4. Rotate reconciliation
5. Human approval of the reconciled plan
6. Separate implementation worktrees
7. Test execution
8. Cross-agent review
9. Safety summary
10. Final recommendation
11. Dry-run apply guidance

## Why This Was A Good Dogfood Task

- Small enough to review by hand.
- Useful enough to exercise real validation logic and tests.
- Safe: no secrets, auth files, deployment credentials, or payment code.
- Testable with `npm test`.
- Good for cross-review because small validation changes can still hide fixture,
  ordering, and edge-case issues.

## Commands

Run from `examples/demo-repo`:

```bash
node ../../dist/cli.js --cwd . doctor
node ../../dist/cli.js --cwd . --json plan "Add password complexity validation and tests for missing uppercase, lowercase, and number requirements." --agents codex,claude
node ../../dist/cli.js --cwd . --json reconcile --session 20260702-170202-add-password-complexity-validation-and-tests-for --strategy rotate
node ../../dist/cli.js --cwd . --json approve --session 20260702-170202-add-password-complexity-validation-and-tests-for --reconciled
node ../../dist/cli.js --cwd . --json implement --session 20260702-170202-add-password-complexity-validation-and-tests-for --agents codex,claude
node ../../dist/cli.js --cwd . --json test --session 20260702-170202-add-password-complexity-validation-and-tests-for --agents codex,claude
node ../../dist/cli.js --cwd . --json review --session 20260702-170202-add-password-complexity-validation-and-tests-for --reviewers codex,claude --targets codex,claude
node ../../dist/cli.js --cwd . --json safety --session 20260702-170202-add-password-complexity-validation-and-tests-for
node ../../dist/cli.js --cwd . --json report --session 20260702-170202-add-password-complexity-validation-and-tests-for
node ../../dist/cli.js --cwd . --json apply --session 20260702-170202-add-password-complexity-validation-and-tests-for --agent claude --dry-run
```

## What Happened

Both real agents produced structured plans. CodeCouncil compared the plans with
local deterministic rules, then rotate reconciliation asked both agents to
produce a merged candidate plan from anonymized source plans.

The rotated reconciliation recommended inspecting Codex's reconciled candidate
first. That candidate was approved and both agents implemented the same approved
plan independently.

Both implementations changed only:

- `src/signup.mjs`
- `test/signup.test.mjs`

Both passed `npm test`.

## Results

| Agent | Implementation | Tests | Cross-review | Score |
| --- | --- | --- | --- | ---: |
| Claude | success | passed | approved | 100 |
| Codex | success | passed | approved with non-blocking missing-test notes | 94 |

Final recommendation: inspect Claude's worktree first.

CodeCouncil did not merge, push, or apply either implementation.

## What CodeCouncil Caught

Dogfooding found a real orchestration bug before this writeup existed:

Repeated runs of the same task were using branch names based only on the task
slug:

```text
codecouncil/<session-slug>/<agent-id>
```

That caused branch collisions when an earlier worktree still had the same task
branch checked out. Git correctly refused to check out that branch in a new
worktree.

The fix was to include the timestamped session id in branch names:

```text
codecouncil/<session-id>/<agent-id>
```

That keeps repeated same-task runs isolated and makes old sessions easier to
reason about.

## What Cross-review Added

Both patches passed tests and were approved. Claude's review of Codex still found
two non-blocking missing-test notes:

- no test for multiple accumulated complexity errors at once
- no test for missing or non-string password producing all password errors in
  deterministic order

Those were not blockers because the approved plan intentionally kept the first
change focused. They are useful follow-up context and show why cross-review is
more valuable than treating test pass/fail as the only signal.

## Evidence Artifacts

- [Real-agent run showcase](../examples/showcase/real-agent-run/README.md)
- [Final report](../examples/showcase/real-agent-run/final-report.md)
- [Plan comparison](../examples/showcase/real-agent-run/comparison.md)
- [Recommended reconciled plan](../examples/showcase/real-agent-run/reconciled-plan.md)
- [Claude reviews Codex](../examples/showcase/real-agent-run/reviews/claude-reviews-codex.md)
- [Codex reviews Claude](../examples/showcase/real-agent-run/reviews/codex-reviews-claude.md)
- [Safety summary](../examples/showcase/real-agent-run/safety-summary.md)
- [Rotate reconciliation showcase](../examples/showcase/rotate-reconciliation-run/README.md)

Raw `.codecouncil` outputs are intentionally not committed because they can
contain local absolute paths, command metadata, and bulky provider output.

## Suggested PR Description

Title: Dogfood rotated real-agent workflow

Summary:

- Ran CodeCouncil end to end on `examples/demo-repo` with real Codex and Claude
  CLIs.
- Used rotate reconciliation, approved the recommended reconciled plan, then
  implemented with both agents in isolated worktrees.
- Ran tests, cross-review, safety summary, final report, and dry-run apply.
- Refreshed sanitized showcase artifacts from the run.
- Fixed a branch-collision bug by naming worktree branches with the full
  timestamped session id.

Validation:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`

Notes:

- This is a workflow demo, not benchmark evidence.
- Worktrees isolate git state, not the operating system.
- CodeCouncil still does not merge, push, or apply changes automatically.

## What This Proves

- CodeCouncil can orchestrate real Codex and Claude CLI runs through local child
  processes.
- Independent plans, reconciled plans, implementation patches, test results,
  reviews, safety reports, and final recommendations can be persisted as durable
  artifacts.
- Dogfooding is already useful for improving the orchestration layer itself.

## What This Does Not Prove

- It does not prove two agents outperform one agent.
- It does not prove the final code is correct for all product requirements.
- It does not provide OS-level sandboxing.
- It does not replace human review.

Benchmark mode is the right place to answer the larger research question with
multiple tasks, strategies, and human labels.
