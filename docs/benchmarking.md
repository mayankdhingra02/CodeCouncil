# Benchmarking

Benchmark mode turns CodeCouncil into a research harness for evaluating agent collaboration strategies.

It does not claim that two agents are better. It records evidence so that claim can be tested.

## Command

```bash
codecouncil benchmark --tasks tasks.json --agents codex,claude --yes
```

Mock-agent benchmark:

```bash
codecouncil benchmark \
  --tasks examples/benchmark.tasks.json \
  --agents mock-codex,mock-claude \
  --strategies codex_only,codex_then_claude_review,both_implement_then_review_and_select
```

Real-agent runs require `--yes`.

## Task File

```json
[
  {
    "id": "task-001",
    "title": "Add input validation",
    "description": "Add validation to the signup endpoint and tests for invalid email/password.",
    "repositoryPath": "../sample-app",
    "baseBranch": "main",
    "testCommands": ["npm test"],
    "expectedFiles": ["src/signup.ts"],
    "evaluationNotes": "Check invalid email and weak password behavior."
  }
]
```

## Strategies

- `codex_only`
- `claude_only`
- `codex_then_claude_review`
- `claude_then_codex_review`
- `both_independent_then_select`
- `both_plan_then_one_implement`
- `both_implement_then_review_and_select`

## Metrics

Each result records:

- task success
- tests passed
- implementation duration
- review duration
- total duration
- changed files
- diff size
- review finding count
- safety warnings
- final recommendation
- optional later human acceptance label

## Outputs

```text
benchmark/<run-id>/results.jsonl
benchmark/<run-id>/summary.json
benchmark/<run-id>/summary.md
benchmark/<run-id>/table.csv
benchmark/latest.json
```

## Manual Labels

After inspecting a result:

```bash
codecouncil benchmark label \
  --run <run-id> \
  --task task-001 \
  --strategy codex_only \
  --accepted true \
  --notes "Accepted after manual review."
```

Labels update `results.jsonl`, `summary.json`, `summary.md`, and `table.csv`.

## Interpreting Results

Useful comparisons:

- single-agent success rate vs two-agent success rate
- review-enabled strategies vs no-review strategies
- average time cost
- average diff size
- safety warning rate
- cases where review found issues
- cases where collaboration made outcomes worse

Do not make public performance claims without enough representative tasks and human labels.
