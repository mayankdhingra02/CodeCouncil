# Real Agent Dogfood Run

This folder contains curated artifacts from a real CodeCouncil run against
`examples/demo-repo` using the actual Codex CLI and Claude Code CLI.

Raw `.codecouncil` run output is not committed because it can contain local
absolute paths, command metadata, and bulky provider output. These files are a
sanitized showcase of the important evidence.

## Task

Add password complexity validation and tests for missing uppercase, lowercase,
and number requirements.

## Commands Run

Run from `examples/demo-repo` after initializing it as its own local git repo:

```bash
node ../../dist/cli.js --cwd . doctor
node ../../dist/cli.js --cwd . --json plan "Add password complexity validation and tests for missing uppercase, lowercase, and number requirements." --agents codex,claude
node ../../dist/cli.js --cwd . --json reconcile --session 20260702-040811-add-password-complexity-validation-and-tests-for --reconciler codex
node ../../dist/cli.js --cwd . --json approve --session 20260702-040811-add-password-complexity-validation-and-tests-for --reconciled
node ../../dist/cli.js --cwd . --json implement --session 20260702-040811-add-password-complexity-validation-and-tests-for --agents codex,claude
node ../../dist/cli.js --cwd . --json test --session 20260702-040811-add-password-complexity-validation-and-tests-for --agents codex,claude
node ../../dist/cli.js --cwd . --json review --session 20260702-040811-add-password-complexity-validation-and-tests-for --reviewers codex,claude --targets codex,claude
node ../../dist/cli.js --cwd . --json safety --session 20260702-040811-add-password-complexity-validation-and-tests-for
node ../../dist/cli.js --cwd . --json report --session 20260702-040811-add-password-complexity-validation-and-tests-for
node ../../dist/cli.js --cwd . --json apply --session 20260702-040811-add-password-complexity-validation-and-tests-for --agent claude --dry-run
```

## Result

| Agent | Implementation | Tests | Review | Score |
| --- | --- | --- | --- | ---: |
| Claude | success | passed | 1/1 approve, 0 security concerns | 100 |
| Codex | success | passed | 1/1 approve, 1 security concern noted | 85 |

Final recommendation: inspect Claude's worktree first.

## What This Demonstrates

- Real Codex and Claude CLIs can be orchestrated through CodeCouncil.
- Planning stays separate from implementation.
- Reconciliation produces a human-approvable merged plan.
- Each agent implements in its own git worktree and branch.
- Tests run independently against each implementation.
- Cross-review can still find useful differences when both patches pass tests.
- The final report recommends what to inspect, but does not merge or push.

## Artifacts

- `comparison.md`: deterministic local comparison of the two plans.
- `reconciled-plan.md`: Codex-synthesized plan after reading both plans and the comparison.
- `reviews/`: cross-agent review summaries.
- `patches/`: the two generated patches.
- `final-report.md`: sanitized final recommendation.
- `safety-summary.md`: safety report and limitations.

## Limitations

- This is one small demo task, not benchmark evidence.
- The agents produced very similar patches, so the value here is orchestration,
  traceability, cross-review, and human-control flow.
- Git worktrees isolate repository state, not the operating system. Containerized
  test execution is still a planned safety improvement.
