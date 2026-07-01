# CodeCouncil VS Code Extension

This package is a minimal VS Code wrapper around the CodeCouncil CLI. The CLI remains the source of truth for planning, sessions, worktrees, safety checks, reports, and future agent execution.

## Local Development

From the repository root:

```bash
pnpm install
pnpm build
pnpm link --global
```

Then open `packages/vscode-extension` in VS Code and press `F5` to launch an Extension Development Host.

If the CLI is not globally linked, set:

```json
{
  "codecouncil.cliPath": "/absolute/path/to/CodeCouncil/dist/cli.js"
}
```

When `cliPath` points to a `.js` file, the extension runs it with the current Node executable.

## Commands

- `CodeCouncil: Initialize Project`
- `CodeCouncil: Doctor`
- `CodeCouncil: Plan Task`
- `CodeCouncil: Show Sessions`
- `CodeCouncil: Open Latest Report`
- `CodeCouncil: Open Latest Plan Comparison`
- `CodeCouncil: Resume Session`

The extension calls only the `codecouncil` CLI. It does not interact with Codex or Claude VS Code extensions, scrape UI, or read authentication token files.
