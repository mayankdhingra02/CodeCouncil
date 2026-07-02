# Portfolio Copy

Use this copy as a starting point. Adjust numbers only after you have real benchmark data.

## Resume Bullet

- Built CodeCouncil, a TypeScript CLI that coordinates multiple AI coding agents through isolated git worktrees, structured planning, approval gates, test execution, cross-agent review, safety scanning, benchmark analysis, and final recommendation reports.

## Short Portfolio Description

CodeCouncil is a local AI engineering tool for safely coordinating multiple coding agents on the same repository. It creates isolated git worktrees for each agent, asks agents for structured plans, gates implementation on an approved plan, runs project tests, asks agents to review each other's diffs, scans for safety issues, and produces a final recommendation for human inspection. It also includes a benchmark mode for comparing single-agent and two-agent workflows.

## LinkedIn Post Draft

I built CodeCouncil, a local TypeScript CLI for coordinating multiple AI coding agents safely.

The idea: instead of letting one AI agent directly edit your working tree, CodeCouncil gives each agent its own git worktree and branch, asks for independent plans, lets the user approve a plan, runs implementations in isolation, executes tests, asks agents to review each other's diffs, and produces an auditable final recommendation.

What works today:

- Codex CLI and Claude Code CLI adapters through child processes
- mock agents for reproducible demos and tests
- isolated git worktrees
- plan comparison and approval artifacts
- test runner and scoring
- cross-agent review
- safety summaries
- benchmark mode for comparing collaboration strategies
- minimal VS Code wrapper around the CLI

The research question I want to explore next: when does two-agent collaboration actually improve software engineering outcomes compared with one strong agent alone?

No inflated claims yet. The benchmark harness is there so the project can measure that question with real tasks and human labels.

## Dogfood LinkedIn Post Draft

I dogfooded CodeCouncil on its own demo repository with real Codex CLI and Claude Code CLI.

The workflow:

- Codex and Claude produced independent plans.
- CodeCouncil compared the plans with deterministic local rules.
- Rotate reconciliation asked both agents to produce merged candidate plans.
- I approved the recommended reconciled plan.
- Both agents implemented the same plan in separate git worktrees.
- CodeCouncil ran tests, cross-review, safety checks, and a final report.

Both implementations passed tests and were approved in cross-review. Claude's patch received the top recommendation, while Claude's review of Codex still surfaced two non-blocking missing-test follow-ups.

The most useful part: dogfooding caught a real orchestration bug. Re-running the same task exposed branch-name collisions because branches used only the task slug. I fixed it by including the timestamped session id in each agent branch.

That is exactly the kind of project I wanted CodeCouncil to be: not a magic merge button, but an auditable workflow for comparing AI-generated plans and patches while keeping the human in control.

## GitHub Repo Description

Local TypeScript CLI for coordinating AI coding agents with isolated git worktrees, cross-review, tests, safety checks, reports, and benchmark mode.

## Portfolio Project Page Outline

1. Problem: multi-agent coding is powerful but risky without isolation and evidence.
2. Solution: local CLI that orchestrates plans, worktrees, tests, reviews, and recommendations.
3. Architecture: CLI core, agent adapters, git manager, session store, safety layer, benchmark harness, VS Code wrapper.
4. Demo: mock agents on the demo repository.
5. Safety model: no token handling, no extension automation, no automatic merge/push.
6. Research angle: benchmark strategies for single-agent vs two-agent collaboration.
7. Tech stack: TypeScript, Commander, zod, execa, Vitest, git worktrees, VS Code extension API.
8. Future work: HTML benchmark dashboard, more adapters, richer VS Code UI, safer apply flow.

## Technical Blog Outline

Title: Building a Local Council of AI Coding Agents

1. Why multi-agent coding needs orchestration.
2. Why git worktrees are the right primitive.
3. Designing a durable session model.
4. Making planning and approval explicit.
5. Tests as stronger evidence than model confidence.
6. Cross-agent review: useful, imperfect, measurable.
7. Safety as defense-in-depth, not a sandbox.
8. Benchmarking collaboration strategies honestly.
9. Lessons learned and next steps.
