import { access, readdir } from "node:fs/promises";
import path from "node:path";

export type ProjectType = "node" | "python" | "go" | "rust" | "maven" | "gradle" | "dotnet";

export interface DetectedProjectType {
  commands: string[];
  evidence: string[];
  type: ProjectType;
}

export interface TestCommandSelection {
  commands: string[];
  detectedProjects: DetectedProjectType[];
  source: "cli" | "config" | "detected" | "none";
}

const SKIPPED_DIRECTORIES = new Set([
  ".codecouncil",
  ".git",
  "dist",
  "node_modules",
  "target"
]);

export async function detectProjectTypes(rootDir: string): Promise<DetectedProjectType[]> {
  const detections: DetectedProjectType[] = [];

  if (await exists(path.join(rootDir, "package.json"))) {
    detections.push({
      commands: [await detectNodeTestCommand(rootDir)],
      evidence: ["package.json"],
      type: "node"
    });
  }

  const pythonEvidence = await existingFiles(rootDir, [
    "pyproject.toml",
    "requirements.txt",
    "pytest.ini"
  ]);

  if (pythonEvidence.length > 0) {
    detections.push({
      commands: ["pytest"],
      evidence: pythonEvidence,
      type: "python"
    });
  }

  if (await exists(path.join(rootDir, "go.mod"))) {
    detections.push({
      commands: ["go test ./..."],
      evidence: ["go.mod"],
      type: "go"
    });
  }

  if (await exists(path.join(rootDir, "Cargo.toml"))) {
    detections.push({
      commands: ["cargo test"],
      evidence: ["Cargo.toml"],
      type: "rust"
    });
  }

  if (await exists(path.join(rootDir, "pom.xml"))) {
    detections.push({
      commands: ["mvn test"],
      evidence: ["pom.xml"],
      type: "maven"
    });
  }

  const gradleEvidence = await existingFiles(rootDir, [
    "build.gradle",
    "build.gradle.kts"
  ]);

  if (gradleEvidence.length > 0) {
    detections.push({
      commands: ["./gradlew test"],
      evidence: gradleEvidence,
      type: "gradle"
    });
  }

  const dotnetEvidence = await findMatchingFiles(
    rootDir,
    (fileName) => fileName.endsWith(".csproj") || fileName.endsWith(".sln")
  );

  if (dotnetEvidence.length > 0) {
    detections.push({
      commands: ["dotnet test"],
      evidence: dotnetEvidence,
      type: "dotnet"
    });
  }

  return detections;
}

export async function selectTestCommands(options: {
  configuredCommands: readonly string[];
  explicitCommands?: readonly string[];
  rootDir: string;
}): Promise<TestCommandSelection> {
  const explicitCommands = normalizeCommands(options.explicitCommands ?? []);

  if (explicitCommands.length > 0) {
    return {
      commands: explicitCommands,
      detectedProjects: [],
      source: "cli"
    };
  }

  const configuredCommands = normalizeCommands(options.configuredCommands);

  if (configuredCommands.length > 0) {
    return {
      commands: configuredCommands,
      detectedProjects: [],
      source: "config"
    };
  }

  const detectedProjects = await detectProjectTypes(options.rootDir);
  const detectedCommands = unique(detectedProjects.flatMap((project) => project.commands));

  return {
    commands: detectedCommands,
    detectedProjects,
    source: detectedCommands.length > 0 ? "detected" : "none"
  };
}

async function detectNodeTestCommand(rootDir: string): Promise<string> {
  if (await exists(path.join(rootDir, "pnpm-lock.yaml"))) {
    return "pnpm test";
  }

  if (await exists(path.join(rootDir, "yarn.lock"))) {
    return "yarn test";
  }

  return "npm test";
}

async function existingFiles(rootDir: string, fileNames: readonly string[]): Promise<string[]> {
  const matches = [];

  for (const fileName of fileNames) {
    if (await exists(path.join(rootDir, fileName))) {
      matches.push(fileName);
    }
  }

  return matches;
}

async function findMatchingFiles(
  rootDir: string,
  predicate: (fileName: string) => boolean,
  maxDepth = 3
): Promise<string[]> {
  const matches: string[] = [];

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      return;
    }

    let entries;

    try {
      entries = await readdir(directory, {
        withFileTypes: true
      });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          await visit(absolutePath, depth + 1);
        }

        continue;
      }

      if (entry.isFile() && predicate(entry.name)) {
        matches.push(relativePath);
      }
    }
  }

  await visit(rootDir, 0);
  return matches.sort();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeCommands(commands: readonly string[]): string[] {
  return commands.map((command) => command.trim()).filter(Boolean);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
