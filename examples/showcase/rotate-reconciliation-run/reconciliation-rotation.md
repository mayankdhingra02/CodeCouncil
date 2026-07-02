# Reconciliation Rotation Comparison

Session: `20260702-170202-add-password-complexity-validation-and-tests-for`

## Recommendation

Inspect the reconciled candidate from `codex` first.

CodeCouncil selected it by most synthesis selections, then lowest own-plan
selections, then fewest open questions, then highest confidence. This ranking
measures reconciliation/deference behavior, not correctness.

## Candidates

| Reconciler | Confidence | Resolutions | Own-Plan Picks | Synthesis Picks | Open Questions |
| --- | ---: | ---: | ---: | ---: | ---: |
| `claude` | 90% | 6 | 1 | 5 | 2 |
| `codex` | 86% | 6 | 0 | 5 | 1 |

## Source Plan Agents

- `claude`
- `codex`

## Warnings

- The rotation ranking measures reconciliation/deference behavior, not
  implementation correctness.
- Rotated reconciliation compares candidate plans, but it is still a heuristic
  and not a proof of correctness.
- A human must explicitly approve a reconciled candidate before implementation.
- Both reconcilers were also source-plan authors, so anonymization reduces but
  does not eliminate self-preference bias.

## Approval

Rotation writes the recommended candidate to `plans/reconciled.json`, but it is
still only a candidate until the user runs:

```bash
codecouncil approve --session 20260702-170202-add-password-complexity-validation-and-tests-for --reconciled
```
