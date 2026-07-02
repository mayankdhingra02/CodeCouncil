# Rotate Reconciliation Dogfood Run

This folder contains curated artifacts from a real CodeCouncil planning and
rotated reconciliation run against `examples/demo-repo` using the actual Codex
CLI and Claude Code CLI.

Raw `.codecouncil` output is not committed because it can contain local absolute
paths, command metadata, and bulky provider output. These files preserve the
important evidence in a safe, reviewable form.

## Task

Add password complexity validation and tests for missing uppercase, lowercase,
and number requirements.

## Commands Run

Run from `examples/demo-repo` after initializing it as its own local git repo:

```bash
node ../../dist/cli.js --cwd . doctor
node ../../dist/cli.js --cwd . --json plan "Add password complexity validation and tests for missing uppercase, lowercase, and number requirements." --agents codex,claude
node ../../dist/cli.js --cwd . --json reconcile --session 20260702-170202-add-password-complexity-validation-and-tests-for --strategy rotate
```

## Result

| Reconciler | Confidence | Resolutions | Own-Plan Picks | Synthesis Picks | Open Questions |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude | 90% | 6 | 1 | 5 | 2 |
| Codex | 86% | 6 | 0 | 5 | 1 |

CodeCouncil recommended inspecting Codex's reconciled candidate first because
both reconcilers used synthesis five times, and Codex had fewer own-plan picks
and fewer open questions. The ranking intentionally measures
reconciliation/deference behavior, not implementation correctness.

## What This Demonstrates

- CodeCouncil can ask multiple real agents for independent plans.
- The deterministic comparison stays local and auditable.
- Rotate reconciliation can ask each planner to reconcile the same anonymized
  source plans.
- CodeCouncil records whether the reconciler was also a planner and how often
  it selected its own plan, another plan, or synthesis.
- The recommended reconciled plan remains a candidate until the human approves
  it.

## Interesting Finding

Claude-as-reconciler caught that the existing short-password fixture also needed
to change, because the old value would fail the new complexity checks and pollute
the existing exact error-array assertion.

Codex-as-reconciler produced a smaller candidate plan that kept the focused
missing-uppercase, missing-lowercase, and missing-number tests while rejecting
extra propagation and accumulation tests as out of scope for this task.

That is the useful CodeCouncil pattern: use agents to surface tradeoffs, preserve
the deterministic baseline, and leave the approval decision to the human.

## Artifacts

- `comparison.md`: deterministic local comparison before reconciliation.
- `reconciliation-rotation.md`: rotation ranking and warnings.
- `recommended-reconciled-plan.md`: recommended reconciled candidate.
- `rotations/codex.md`: Codex-as-reconciler candidate.
- `rotations/claude.md`: Claude-as-reconciler candidate.

## Limitations

- This is one small demo task, not benchmark evidence.
- Rotation ranking is a heuristic and should not be treated as correctness.
- Both reconcilers were also source planners, so self-preference bias can still
  exist despite anonymized source-plan labels.
- This run stops at planning and reconciliation; implementation, tests, review,
  and report are demonstrated separately in `examples/showcase/real-agent-run`.
