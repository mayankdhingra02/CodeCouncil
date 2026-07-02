# Getting Started

This guide runs CodeCouncil locally with mock agents. Mock agents do not call Codex or Claude, so the flow is safe for a first demo.

## Prerequisites

- Node.js 20.11+
- pnpm 9+
- git

## Install

From the CodeCouncil repository:

```bash
pnpm install
pnpm build
pnpm link --global
codecouncil --help
```

## Run The Demo Fixture

```bash
cd examples/demo-repo
git init
git symbolic-ref HEAD refs/heads/main
git add .
git commit -m "initial demo app"
```

Initialize CodeCouncil:

```bash
codecouncil init
codecouncil doctor
```

Run planning:

```bash
codecouncil plan "Add password complexity validation" --agents mock-codex,mock-claude
```

Reconcile the plans into one candidate, then approve it explicitly:

```bash
codecouncil sessions list
codecouncil reconcile --session <session-id> --reconciler mock-codex
codecouncil approve --session <session-id> --reconciled
```

To compare reconciliation bias between both mock planners, use rotate mode:

```bash
codecouncil reconcile --session <session-id> --strategy rotate
```

Rotate mode saves each reconciler's candidate under `plans/rotations/`, writes a
`plans/reconciliation-rotation.md` comparison, and still requires explicit
approval before implementation.

Run the implementation workflow:

```bash
codecouncil implement --session <session-id> --agents mock-codex,mock-claude
codecouncil test --session <session-id> --agents mock-codex,mock-claude
codecouncil review --session <session-id> --reviewers mock-codex,mock-claude --targets mock-codex,mock-claude
codecouncil safety --session <session-id>
codecouncil report --session <session-id>
```

Preview apply instructions:

```bash
codecouncil apply --session <session-id> --agent mock-codex --dry-run
```

## Guided Workflow

The `solve` command runs the conservative front half of the workflow:

```bash
codecouncil solve "Add password complexity validation" --agents mock-codex,mock-claude
```

It stops after planning unless you explicitly approve:

```bash
codecouncil solve "Add password complexity validation" \
  --agents mock-codex,mock-claude \
  --auto-approve-plan \
  --implement both \
  --run-tests \
  --review \
  --report
```

## Real Agents

To use Codex or Claude, install and authenticate their CLIs separately. CodeCouncil does not read token files or ask for API keys.

Then configure `codex` and/or `claude` in `codecouncil.config.json` and run:

```bash
codecouncil plan "your task" --agents codex,claude
```

Before a real-agent run, inspect and choose model/cost tradeoffs:

```bash
codecouncil models list
codecouncil plan "your task" --agents codex,claude --models codex=gpt-5.4-mini,claude=sonnet
codecouncil reconcile --session <session-id> --reconciler codex --model codex=gpt-5.5
codecouncil reconcile --session <session-id> --strategy rotate
```
