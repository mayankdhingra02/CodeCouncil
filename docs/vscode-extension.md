# VS Code Extension

The VS Code extension is a thin wrapper around the CodeCouncil CLI.

It does not duplicate workflow logic. It does not control Codex or Claude VS Code extensions. It does not scrape UI or read auth files.

## Location

```text
packages/vscode-extension
```

## Commands

- `CodeCouncil: Initialize Project`
- `CodeCouncil: Doctor`
- `CodeCouncil: Plan Task`
- `CodeCouncil: Show Sessions`
- `CodeCouncil: Open Latest Report`
- `CodeCouncil: Open Latest Plan Comparison`
- `CodeCouncil: Resume Session`

## Local Development

```bash
pnpm install
pnpm build
pnpm link --global
code packages/vscode-extension
```

Press `F5` in VS Code to launch an Extension Development Host.

If the CLI is not linked globally, configure:

```json
{
  "codecouncil.cliPath": "/absolute/path/to/CodeCouncil/dist/cli.js"
}
```

When `cliPath` points to a `.js` file, the extension runs it with the current Node executable.

## How It Works

- Detects the active workspace folder.
- Runs `codecouncil` commands from the workspace root.
- Streams output to a `CodeCouncil` output channel.
- Uses a dedicated `CodeCouncil` terminal for init.
- Opens generated Markdown reports and plan comparisons.
- Shows a simple status bar indicator for CLI availability.

## Current Limits

- No rich session tree view yet.
- No interactive approve/implement/report command flow yet.
- No packaged Marketplace release yet.
- Extension tests are limited to TypeScript build/typecheck.
