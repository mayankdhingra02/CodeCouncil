import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/loadConfig.js";
import { ConfigError } from "../src/core/errors.js";

describe("loadConfig", () => {
  it("creates a default config with mock Codex and mock Claude agents", () => {
    const config = createDefaultConfig({
      projectName: "my-app"
    });

    expect(config).toMatchObject({
      projectName: "my-app",
      baseBranch: "main",
      workspaceDir: ".codecouncil",
      safety: {
        requireApprovalBeforeApply: true,
        blockSecretFiles: true,
        defaultPlanModeReadOnly: true,
        allowImplementationByDefault: false
      }
    });
    expect(Object.keys(config.agents)).toEqual(["mock-codex", "mock-claude"]);
    expect(config.agents["mock-codex"]?.command).toBe("mock-codex");
    expect(config.agents["mock-claude"]?.command).toBe("mock-claude");
  });

  it("returns defaults when no config file exists", async () => {
    const cwd = await makeTempDir();

    const loaded = await loadConfig({ cwd });

    expect(loaded.fromDefaults).toBe(true);
    expect(loaded.rootDir).toBe(cwd);
    expect(loaded.config.projectName).toBe(path.basename(cwd));
    expect(Object.keys(loaded.config.agents)).toEqual(["mock-codex", "mock-claude"]);
    expect(loaded.config.workspaceDir).toBe(".codecouncil");
  });

  it("loads and validates codecouncil.config.json", async () => {
    const cwd = await makeTempDir();
    await writeFile(
      path.join(cwd, "codecouncil.config.json"),
      JSON.stringify(
        {
          projectName: "custom-project",
          baseBranch: "develop",
          agents: {
            local: {
              command: "local-agent",
              planArgs: ["plan"],
              implementArgs: ["run"],
              maxRuntimeSeconds: 120
            }
          },
          testCommands: ["pnpm test"],
          ignore: [".env"],
          safety: {
            requireApprovalBeforeApply: false
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const loaded = await loadConfig({ cwd });

    expect(loaded.fromDefaults).toBe(false);
    expect(loaded.rootDir).toBe(cwd);
    expect(loaded.config).toMatchObject({
      projectName: "custom-project",
      baseBranch: "develop",
      agents: {
        local: {
          enabled: true,
          command: "local-agent",
          planArgs: ["plan"],
          implementArgs: ["run"],
          reviewArgs: [],
          maxRuntimeSeconds: 120
        }
      },
      testCommands: ["pnpm test"],
      testContainer: {
        image: "node:20-bookworm-slim",
        timeoutSeconds: 600
      },
      ignore: [".env"],
      safety: {
        requireApprovalBeforeApply: false,
        blockSecretFiles: true,
        defaultPlanModeReadOnly: true,
        allowImplementationByDefault: false
      }
    });
  });

  it("loads containerized test configuration", async () => {
    const cwd = await makeTempDir();
    await writeFile(
      path.join(cwd, "codecouncil.config.json"),
      JSON.stringify({
        projectName: "container-tests",
        testContainer: {
          image: "node:22-bookworm-slim",
          timeoutSeconds: 120
        }
      }),
      "utf8"
    );

    const loaded = await loadConfig({ cwd });

    expect(loaded.config.testContainer).toEqual({
      image: "node:22-bookworm-slim",
      timeoutSeconds: 120
    });
  });

  it("finds a repo-root config from a child directory", async () => {
    const cwd = await makeTempDir();
    const childDir = path.join(cwd, "packages", "app");
    await writeFile(
      path.join(cwd, "codecouncil.config.json"),
      JSON.stringify({
        projectName: "rooted",
        agents: {
          codex: {
            command: "codex"
          }
        }
      }),
      "utf8"
    );
    await mkdirp(childDir);

    const loaded = await loadConfig({ cwd: childDir });

    expect(loaded.rootDir).toBe(cwd);
    expect(loaded.config.projectName).toBe("rooted");
  });

  it("throws useful errors for invalid config", async () => {
    const cwd = await makeTempDir();
    await writeFile(
      path.join(cwd, "codecouncil.config.json"),
      JSON.stringify({
        agents: {
          codex: {
            command: ""
          }
        }
      }),
      "utf8"
    );

    await expect(loadConfig({ cwd })).rejects.toThrow(ConfigError);
    await expect(loadConfig({ cwd })).rejects.toThrow("projectName");
    await expect(loadConfig({ cwd })).rejects.toThrow("agents.codex.command");
  });
});

async function mkdirp(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true });
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "codecouncil-config-"));
}
