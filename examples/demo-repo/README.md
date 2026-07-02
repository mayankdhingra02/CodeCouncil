# CodeCouncil Demo Repo

This is a tiny Node project for demoing CodeCouncil with mock or real agents.

It has no dependencies. Run tests with:

```bash
npm test
```

Before using it with CodeCouncil worktrees, initialize a local git repository:

```bash
git init
git symbolic-ref HEAD refs/heads/main
git add .
git commit -m "initial demo app"
```

Suggested task:

```text
Add password complexity validation and tests for missing uppercase, lowercase, and number requirements.
```

This folder includes a demo-local `codecouncil.config.json` that points at the
real `codex` and `claude` CLIs. Those CLIs must already be installed and
authenticated on your machine. CodeCouncil does not read token files or automate
VS Code extensions.
