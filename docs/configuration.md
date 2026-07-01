# Configuration

CodeCouncil reads configuration from the repository root.

Default file:

```text
codecouncil.config.json
```

Fallback legacy name:

```text
.codecouncilrc.json
```

## Example

```json
{
  "projectName": "my-app",
  "baseBranch": "main",
  "workspaceDir": ".codecouncil",
  "agents": {
    "mock-codex": {
      "enabled": true,
      "command": "mock-codex",
      "planArgs": [],
      "implementArgs": [],
      "reviewArgs": [],
      "maxRuntimeSeconds": 900
    },
    "mock-claude": {
      "enabled": true,
      "command": "mock-claude",
      "planArgs": [],
      "implementArgs": [],
      "reviewArgs": [],
      "maxRuntimeSeconds": 900
    }
  },
  "testCommands": ["npm test"],
  "ignore": [".env", ".env.*", "node_modules", ".git", ".codecouncil"],
  "review": {
    "maxDiffBytes": 120000
  },
  "safety": {
    "requireApprovalBeforeApply": true,
    "blockSecretFiles": true,
    "createCommitOnImplementation": false,
    "defaultPlanModeReadOnly": true,
    "allowImplementationByDefault": false,
    "secretPatterns": []
  }
}
```

## Real Agent Adapters

CodeCouncil calls configured commands through child processes. It does not read auth files.

```json
{
  "agents": {
    "codex": {
      "enabled": true,
      "command": "codex",
      "planArgs": ["exec", "--json"],
      "implementArgs": ["exec", "--json"],
      "reviewArgs": ["exec", "--json"],
      "maxRuntimeSeconds": 900
    },
    "claude": {
      "enabled": true,
      "command": "claude",
      "planArgs": ["-p", "--output-format", "stream-json"],
      "implementArgs": ["-p", "--output-format", "stream-json"],
      "reviewArgs": ["-p", "--output-format", "stream-json"],
      "maxRuntimeSeconds": 900
    }
  }
}
```

CodeCouncil appends its generated prompt as the final argument after the configured args.

## Ignore Rules

CodeCouncil combines config `ignore` rules with `.codecouncilignore`.

Use this for files that should not be collected as context, included in review diffs, or considered safe to touch:

```text
.env
.env.*
*.pem
*.key
node_modules
.git
.codecouncil
```

## Test Commands

If `testCommands` is set, CodeCouncil uses those commands first. If not, it detects common project types:

- Node/TypeScript
- Python
- Go
- Rust
- Maven
- Gradle
- .NET

Test commands are parsed into argv and run without shell interpolation. Compound shell commands are rejected.
