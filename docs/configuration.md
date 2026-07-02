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
      "adapter": "mock-codex",
      "enabled": true,
      "command": "mock-codex",
      "models": {},
      "planArgs": [],
      "implementArgs": [],
      "reconcileArgs": [],
      "reviewArgs": [],
      "maxRuntimeSeconds": 900
    },
    "mock-claude": {
      "adapter": "mock-claude",
      "enabled": true,
      "command": "mock-claude",
      "models": {},
      "planArgs": [],
      "implementArgs": [],
      "reconcileArgs": [],
      "reviewArgs": [],
      "maxRuntimeSeconds": 900
    }
  },
  "testCommands": ["npm test"],
  "testContainer": {
    "image": "node:20-bookworm-slim",
    "setupCommands": [],
    "timeoutSeconds": 600
  },
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
      "adapter": "codex",
      "enabled": true,
      "command": "codex",
      "models": {
        "plan": "gpt-5.4-mini",
        "implement": "gpt-5.5",
        "reconcile": "gpt-5.5",
        "review": "gpt-5.5"
      },
      "planArgs": ["exec", "--json"],
      "implementArgs": ["exec", "--json", "--sandbox", "workspace-write"],
      "reconcileArgs": ["exec", "--json"],
      "reviewArgs": ["exec", "--json"],
      "maxRuntimeSeconds": 900
    },
    "claude": {
      "adapter": "claude",
      "enabled": true,
      "command": "claude",
      "models": {
        "plan": "sonnet",
        "implement": "opus",
        "reconcile": "opus",
        "review": "opus"
      },
      "planArgs": ["-p", "--output-format", "stream-json"],
      "implementArgs": ["-p", "--output-format", "stream-json", "--permission-mode", "acceptEdits"],
      "reconcileArgs": ["-p", "--output-format", "stream-json"],
      "reviewArgs": ["-p", "--output-format", "stream-json"],
      "maxRuntimeSeconds": 900
    }
  }
}
```

`adapter` selects the built-in integration to use. If omitted, CodeCouncil defaults `adapter` to the agent id, so existing `codex` and `claude` configs keep working.

The configured agent id can differ from the adapter id. That lets you define multiple instances of the same CLI with different models or roles:

```json
{
  "agents": {
    "codex-fast": {
      "adapter": "codex",
      "command": "codex",
      "model": "gpt-5.4-mini",
      "planArgs": ["exec", "--json"],
      "implementArgs": ["exec", "--json", "--sandbox", "workspace-write"],
      "reconcileArgs": ["exec", "--json"],
      "reviewArgs": ["exec", "--json"]
    },
    "codex-reviewer": {
      "adapter": "codex",
      "command": "codex",
      "model": "gpt-5.5",
      "planArgs": ["exec", "--json"],
      "implementArgs": ["exec", "--json", "--sandbox", "workspace-write"],
      "reconcileArgs": ["exec", "--json"],
      "reviewArgs": ["exec", "--json"]
    }
  }
}
```

CodeCouncil sends generated prompts over stdin to avoid large prompts appearing in process arguments. The Codex adapter adds a `-` stdin sentinel for `codex exec`; Claude keeps the configured `-p` style flags.

If `reconcileArgs` is empty, real adapters fall back to `planArgs` so reconciliation stays read-only by default.

## Model Selection

Each agent can define a default `model` or stage-specific `models`.

```json
{
  "agents": {
    "codex": {
      "command": "codex",
      "model": "gpt-5.4-mini",
      "models": {
        "implement": "gpt-5.5",
        "reconcile": "gpt-5.5"
      }
    }
  }
}
```

Stage-specific values win over `model`. CLI flags win over config:

```bash
codecouncil models list
codecouncil plan "task" --agents codex,claude --models codex=gpt-5.4-mini,claude=sonnet
codecouncil reconcile --session <id> --reconciler codex --model codex=gpt-5.5
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

## Containerized Test Execution

Containerized test execution is opt-in:

```bash
codecouncil test --session <id> --agents codex,claude --container
```

Config:

```json
{
  "testContainer": {
    "image": "node:20-bookworm-slim",
    "setupCommands": ["npm ci"],
    "timeoutSeconds": 600
  }
}
```

When `--container` is set, CodeCouncil:

- verifies Docker is available and the configured image already exists locally
- does not pull images automatically
- does not install project dependencies automatically
- mounts only the selected agent worktree at `/workspace`
- runs with Docker network disabled
- saves stdout, stderr, exit code, duration, and command JSON under the usual `tests/<agent>/` directory

Dependency setup is explicit. If the worktree already contains host-installed
dependencies, they may not work in a Linux container, especially for packages
with native binaries. Prefer a prebuilt image containing dependencies, or opt in
to setup commands:

```bash
codecouncil test --session <id> --agents codex,claude --container --container-setup
```

Setup commands from `testContainer.setupCommands` run first with Docker's default
network. Test commands then run in a fresh container with networking disabled.
You can also pass one-off setup commands:

```bash
codecouncil test --session <id> --agents codex --container --container-setup-command "npm ci"
```

Containerized commands use named containers and `--init`. CodeCouncil maps the
host UID/GID into the container when Node exposes that information, which helps
avoid root-owned files on Linux hosts. If a containerized command times out,
CodeCouncil attempts to `docker kill` and `docker rm -f` that named container.

Container mode mounts only the agent worktree. In git worktrees, `.git` is often
a file pointing at a git directory outside the mounted path, so tests that invoke
`git` may fail inside the container.

Use `--container-image <image>` to override the configured image for one run.
Use `--timeout-seconds <seconds>` to override the configured container timeout.
