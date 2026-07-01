# Architecture

CodeCouncil is built as a local-first TypeScript CLI. The CLI is the stable core; editor integrations should be thin wrappers around it.

The VS Code wrapper lives in `packages/vscode-extension`. It shells out to the CLI, displays output, and opens generated markdown artifacts; it does not duplicate workflow logic or interact with Codex/Claude editor extensions.

## Design Goals

- Run multiple AI coding agents on the same repository without letting them overwrite each other.
- Prefer official agent CLIs through child processes.
- Keep authentication owned by each agent CLI.
- Avoid VS Code extension control, browser/UI scraping, and private token file access.
- Make new agents pluggable without changing the workflow engine.

## Planned Workflow

1. `init`: create project config and `.codecouncilignore`.
2. `plan`: create a durable session, ask selected agents for structured implementation plans, and save `plans/comparison.json/md`.
3. `approve`: approve one agent plan or create an editable manual approved plan.
4. `worktree create`: create isolated git worktrees and branches for one or more agents.
5. `implement`: let one or more agents implement inside their assigned worktrees after approval, then persist changed files, patches, command output, and safety metadata.
6. `review`: ask the other agent or agents to review each resulting diff, aggregate verdicts, and refresh implementation scores.
7. `test`: run configured or detected tests inside implementation worktrees and save preliminary implementation scores.
8. `safety`: scan session artifacts for sensitive file touches and risky command text.
9. `report`: summarize plans, diffs, reviews, test results, scores, safety findings, and a final recommendation.
10. `apply --dry-run`: preview manual merge or patch commands without mutating the original repository.
11. `benchmark`: run reproducible strategy comparisons across task files and write research artifacts.

`solve` is a convenience orchestrator over those same stages. Its default state path is conservative: create a session, run doctor checks, plan, compare, write a suggested approval artifact, and stop. It only proceeds to approval or implementation when the user passes explicit flags such as `--auto-approve-plan`, `--approved-plan`, `--implement`, `--run-tests`, `--review`, or `--report`.

`resume` reads session artifacts and `workflow.json` to suggest the next manual command.

## Current Modules

- `src/cli.ts`: top-level CLI entry point, global options, and command registration.
- `src/agents/`: agent interface, registry, mock agents, plan comparison, and plan artifact persistence.
- `src/benchmark/`: benchmark task validation, strategy execution, metrics, labels, and research summaries.
- `src/commands/`: one module per CLI command.
- `src/config/`: zod schema, default config, and config-file discovery.
- `src/core/`: shared errors and agent selection logic.
- `src/git/`: git repository detection, branch naming, worktree lifecycle, diff utilities, and path safety checks.
- `src/ignore/`: `.codecouncilignore` loading and matching.
- `src/implementation/`: implementation artifact persistence.
- `src/report/`: final recommendation algorithm and report rendering.
- `src/review/`: cross-review pairing, aggregation, and artifact persistence.
- `src/safety/`: sensitive path checks, risky command scanning, redaction-adjacent safety summaries.
- `src/scoring/`: deterministic preliminary implementation scoring.
- `src/session/`: typed session artifacts, run directory creation, and event logging.
- `src/testing/`: project-type detection, test command execution, and test artifact persistence.
- `src/workflow/`: reusable planning workflow and solve/resume state inference.
- `packages/vscode-extension/`: thin VS Code command wrapper around the CLI.

## Planned Runtime Layout

```text
.codecouncil/
  runs/
    <run-id>/
      task.json
      plans/
      worktrees/
      diffs/
      runs/
        <agent-id>/
          implementation.json
          implementation.raw.txt
      reviews/
        <reviewer>-reviews-<target>.json
        <reviewer>-reviews-<target>.md
        summary.json
        summary.md
      tests/
        <agent-id>/
          command-1.stdout.log
          command-1.stderr.log
          summary.json
        summary.md
      scores/
        implementation-scores.json
        implementation-scores.md
      safety/
        safety-summary.json
        safety-summary.md
      reports/
        final-report.md
        final-recommendation.json
      events.jsonl
      workflow.json
      approved-plan.json
      approved-plan.md
```

## Planned Agent Adapter Boundary

Each agent should eventually implement a common adapter shape:

```ts
interface AgentAdapter {
  id: string;
  plan(input: PlanInput): Promise<PlanResult>;
  implement(input: ImplementInput): Promise<ImplementResult>;
  review(input: ReviewInput): Promise<ReviewResult>;
}
```

Adapters should call official local CLIs with `execa`. They should not inspect auth files, automate editor UI, or depend on web sessions.

The built-in adapters are `mock-codex`, `mock-claude`, `codex`, and `claude`. Mock adapters produce structured public planning rationale and harmless mock implementation/review outputs without executing external tools. Real adapters call the configured local CLI command with explicit args, append the CodeCouncil prompt as a final non-shell argument, capture redacted stdout/stderr, and persist command metadata.

Implementation adapters receive the approved plan markdown, the task, the repo root, and the agent-specific worktree path. They must run implementation commands only in that worktree.

Review adapters receive the original task, approved plan, target agent, changed files, diff content or a high-level diff summary, test summary, and safety warnings. They must not modify files or apply suggested patches.

## Planned Safety Model

- Require a git repository.
- Warn when the main repository has uncommitted changes.
- Create one worktree per agent implementation.
- Create branches named `codecouncil/<session-slug>/<agent-id>`.
- Keep generated artifacts under `.codecouncil/`.
- Refuse worktree cleanup paths outside the CodeCouncil workspace.
- Apply config `ignore` patterns and `.codecouncilignore` when collecting context.
- Block implementation results that touch ignored files, `.env` files, credential-like files, `.git`, `node_modules`, or CodeCouncil internals outside the current session.
- Warn on suspicious paths such as npm/pypi credentials, SSH files, or filenames containing password/private/secret/token.
- Flag risky command text observed in agent output or logs, including destructive deletes, `curl | sh`, `sudo`, remote shell/file transfer, package publish, `git push`, cloud credential setup, and destructive database commands.
- Refuse high-risk configured test commands before execution.
- Add prompt-injection guardrails to agent prompts and treat repository-embedded instructions as untrusted unless relevant to the user task.
- Log commands and outputs with secret redaction.
- Require an explicit user decision before applying or merging any agent work.

These checks are defense-in-depth, not a complete sandbox for arbitrary commands or malicious repositories.

## Test And Score Model

The test runner chooses commands in this order: explicit CLI `--command`, configured `testCommands`, then detected project defaults. Detection currently covers Node/TypeScript, Python, Go, Rust, Maven, Gradle, and .NET.

Test commands are parsed into argv and executed with `shell: false`. Compound shell commands such as pipes or `&&` are rejected; users should configure separate commands instead.

Scores are deterministic and avoid model-confidence weighting:

- implementation succeeded: 15 points
- tests passed: 40 points
- safety result: 20 points
- review results: 15 points
- changed-file count: 5 points
- diff size: 5 points

Tests remain the largest component. Blocking review issues, rejections, and security concerns reduce the review component heavily.

## Final Recommendation Model

The final report recommends what the user should inspect next, not what CodeCouncil should merge. Recommendation types are:

- `recommend_agent_solution`
- `recommend_manual_review`
- `recommend_no_solution`
- `recommend_combine_solutions`
- `recommend_rerun_with_more_context`

The algorithm prioritizes passing tests, no critical safety warnings, fewer blocking review issues, smaller or less risky diffs when candidates are otherwise equivalent, reviewer confidence, and implementation success. It avoids choosing an agent based only on model confidence.

## Benchmark Model

Benchmark mode is a research wrapper around normal CodeCouncil sessions. For each task and strategy it creates an isolated workspace under the target repository, runs the selected plan/implement/test/review/report stages, and harvests the same durable artifacts used by ordinary CLI workflows.

Supported strategies include single-agent baselines, one-agent implementation with cross-review, independent two-agent implementation, shared planning with one implementation, and full two-agent implementation plus review and selection.

Outputs are written under `benchmark/<run-id>/` as `results.jsonl`, `summary.json`, `summary.md`, and `table.csv`. Human inspection labels can be applied later with `benchmark label`; labels update the benchmark result rows without rerunning agents.
