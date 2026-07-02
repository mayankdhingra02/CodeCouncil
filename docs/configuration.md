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
      "models": {},
      "planArgs": [],
      "implementArgs": [],
      "reviewArgs": [],
      "maxRuntimeSeconds": 900
    },
    "mock-claude": {
      "enabled": true,
      "command": "mock-claude",
      "models": {},
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
      "models": {
        "plan": "gpt-5.4-mini",
        "implement": "gpt-5.5",
        "review": "gpt-5.5"
      },
      "planArgs": ["exec", "--json"],
      "implementArgs": ["exec", "--json"],
      "reviewArgs": ["exec", "--json"],
      "maxRuntimeSeconds": 900
    },
    "claude": {
      "enabled": true,
      "command": "claude",
      "models": {
        "plan": "sonnet",
        "implement": "opus",
        "review": "opus"
      },
      "planArgs": ["-p", "--output-format", "stream-json"],
      "implementArgs": ["-p", "--output-format", "stream-json"],
      "reviewArgs": ["-p", "--output-format", "stream-json"],
      "maxRuntimeSeconds": 900
    }
  }
}
```

CodeCouncil appends its generated prompt as the final argument after the configured args.

## Model Selection

Each agent can define a default `model` or stage-specific `models`.

```json
{
  "agents": {
    "codex": {
      "command": "codex",
      "model": "gpt-5.4-mini",
      "models": {
        "implement": "gpt-5.5"
      }
    }
  }
}
```

Stage-specific values win over `model`. CLI flags win over config:

```bash
codecouncil models list
codecouncil plan "task" --agents codex,claude --models codex=gpt-5.4-mini,claude=sonnet
codecouncil implement --session <id> --agent claude --model claude=opus
```

CodeCouncil passes the selected value to the official CLI as `--model`; it does not validate account-specific model access itself.

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
