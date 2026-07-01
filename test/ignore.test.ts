import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  loadCodecouncilIgnore,
  parseCodecouncilIgnore
} from "../src/ignore/loadCodecouncilIgnore.js";

describe("loadCodecouncilIgnore", () => {
  it("parses comments, blanks, and extra patterns", () => {
    expect(parseCodecouncilIgnore("# comment\n\n dist/ \n!.keep\n", [".env"])).toEqual([
      ".env",
      "dist/",
      "!.keep"
    ]);
  });

  it("matches ignored files from .codecouncilignore", async () => {
    const cwd = await makeTempDir();
    await writeFile(path.join(cwd, ".codecouncilignore"), "dist/\n.env*\n", "utf8");

    const loaded = await loadCodecouncilIgnore(cwd);

    expect(loaded.patterns).toEqual(["dist/", ".env*"]);
    expect(loaded.ignores("dist/index.js")).toBe(true);
    expect(loaded.ignores(path.join(cwd, ".env.local"))).toBe(true);
    expect(loaded.ignores("src/index.ts")).toBe(false);
  });

  it("returns an empty matcher when no ignore file exists", async () => {
    const cwd = await makeTempDir();

    const loaded = await loadCodecouncilIgnore(cwd);

    expect(loaded.patterns).toEqual([]);
    expect(loaded.ignores("dist/index.js")).toBe(false);
  });
});

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "codecouncil-ignore-"));
}
