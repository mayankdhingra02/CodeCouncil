import { spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";

interface CliInvocation {
  args: string[];
  command: string;
}

interface CliRunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface WorkspacePick extends vscode.QuickPickItem {
  fsPath: string;
}

interface AgentPick extends vscode.QuickPickItem {
  agents: string;
}

interface SessionPick extends vscode.QuickPickItem {
  sessionId: string;
}

interface PlanCliPayload {
  comparisonArtifact?: {
    markdownPath?: string;
  };
  sessionId?: string;
}

let outputChannel: vscode.OutputChannel | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let terminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("CodeCouncil");
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "codecouncil.doctor";
  statusBarItem.text = "$(sync~spin) CodeCouncil";
  statusBarItem.tooltip = "Checking CodeCouncil CLI availability.";
  statusBarItem.show();

  context.subscriptions.push(
    outputChannel,
    statusBarItem,
    vscode.commands.registerCommand("codecouncil.init", () => initializeProject()),
    vscode.commands.registerCommand("codecouncil.doctor", () => runSimpleCliCommand(["doctor"])),
    vscode.commands.registerCommand("codecouncil.planTask", () => planTask()),
    vscode.commands.registerCommand("codecouncil.showSessions", () => runSimpleCliCommand(["sessions", "list"])),
    vscode.commands.registerCommand("codecouncil.openLatestReport", () =>
      openLatestArtifact(["reports", "final-report.md"], "No final report found yet.")
    ),
    vscode.commands.registerCommand("codecouncil.openLatestPlanComparison", () =>
      openLatestArtifact(["plans", "comparison.md"], "No plan comparison found yet.")
    ),
    vscode.commands.registerCommand("codecouncil.resumeSession", () => resumeSession())
  );

  void refreshAvailabilityStatus();
}

export function deactivate(): void {
  terminal = undefined;
}

async function initializeProject(): Promise<void> {
  const workspaceRoot = await selectWorkspaceRoot();

  if (!workspaceRoot) {
    return;
  }

  if (!(await ensureCliAvailable(workspaceRoot))) {
    return;
  }

  const codeCouncilTerminal = getCodeCouncilTerminal();
  const invocation = getCliInvocation();
  const commandLine = `cd ${shellQuote(workspaceRoot)} && ${formatCommand(invocation, ["init"])}`;

  getOutputChannel().appendLine(`$ ${formatCommand(invocation, ["init"])}`);
  getOutputChannel().appendLine("Running init in the CodeCouncil terminal.");
  codeCouncilTerminal.show(false);
  codeCouncilTerminal.sendText(commandLine);
}

async function runSimpleCliCommand(args: readonly string[]): Promise<void> {
  const workspaceRoot = await selectWorkspaceRoot();

  if (!workspaceRoot) {
    return;
  }

  if (!(await ensureCliAvailable(workspaceRoot))) {
    return;
  }

  await runCli(args, {
    cwd: workspaceRoot,
    revealOutput: true
  });
}

async function planTask(): Promise<void> {
  const workspaceRoot = await selectWorkspaceRoot();

  if (!workspaceRoot) {
    return;
  }

  if (!(await ensureCliAvailable(workspaceRoot))) {
    return;
  }

  const task = await vscode.window.showInputBox({
    ignoreFocusOut: true,
    placeHolder: "Add password reset flow",
    prompt: "What should CodeCouncil ask the agents to plan?",
    title: "CodeCouncil Plan Task",
    validateInput: (value) => (value.trim().length === 0 ? "Enter a task description." : undefined)
  });

  if (!task) {
    return;
  }

  const agentPick = await vscode.window.showQuickPick(
    [
      {
        agents: "codex,claude",
        description: "Run both configured real adapters",
        label: "Both"
      },
      {
        agents: "codex",
        description: "OpenAI Codex CLI",
        label: "Codex"
      },
      {
        agents: "claude",
        description: "Anthropic Claude Code CLI",
        label: "Claude"
      }
    ] satisfies AgentPick[],
    {
      ignoreFocusOut: true,
      placeHolder: "Select planning agent"
    }
  );

  if (!agentPick) {
    return;
  }

  const result = await runCli(["--json", "plan", "--agents", agentPick.agents, task], {
    cwd: workspaceRoot,
    revealOutput: true
  });
  const payload = parseJsonPayload<PlanCliPayload>(result.stdout);
  const comparisonPath = payload?.comparisonArtifact?.markdownPath;

  if (comparisonPath) {
    await openMarkdown(comparisonPath);
    return;
  }

  await openLatestArtifact(["plans", "comparison.md"], "Plan completed, but no comparison markdown was found.");
}

async function resumeSession(): Promise<void> {
  const workspaceRoot = await selectWorkspaceRoot();

  if (!workspaceRoot) {
    return;
  }

  if (!(await ensureCliAvailable(workspaceRoot))) {
    return;
  }

  const sessions = await listSessionIds(workspaceRoot);

  if (sessions.length === 0) {
    void vscode.window.showInformationMessage("No CodeCouncil sessions found.");
    return;
  }

  const pickedSession = await vscode.window.showQuickPick(
    sessions.map((sessionId) => ({
      label: sessionId,
      sessionId
    })) satisfies SessionPick[],
    {
      matchOnDescription: true,
      placeHolder: "Select a CodeCouncil session to resume"
    }
  );

  if (!pickedSession) {
    return;
  }

  await runCli(["resume", "--session", pickedSession.sessionId], {
    cwd: workspaceRoot,
    revealOutput: true
  });
}

async function openLatestArtifact(pathSegments: readonly string[], missingMessage: string): Promise<void> {
  const workspaceRoot = await selectWorkspaceRoot();

  if (!workspaceRoot) {
    return;
  }

  const artifactPath = await findLatestSessionArtifact(workspaceRoot, pathSegments);

  if (!artifactPath) {
    void vscode.window.showInformationMessage(missingMessage);
    return;
  }

  await openMarkdown(artifactPath);
}

async function runCli(
  args: readonly string[],
  options: {
    cwd: string;
    revealOutput: boolean;
  }
): Promise<CliRunResult> {
  const channel = getOutputChannel();
  const invocation = getCliInvocation();
  const commandArgs = [...invocation.args, ...args];

  channel.show(true);
  channel.appendLine("");
  channel.appendLine(`$ ${formatCommand(invocation, args)}`);
  channel.appendLine(`cwd: ${options.cwd}`);

  return new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(invocation.command, commandArgs, {
      cwd: options.cwd,
      env: process.env,
      shell: false
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      if (options.revealOutput) {
        channel.append(chunk.toString("utf8"));
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      if (options.revealOutput) {
        channel.append(chunk.toString("utf8"));
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        void showMissingCliMessage();
      }

      reject(error);
    });

    child.on("close", (exitCode) => {
      const result = {
        exitCode: exitCode ?? 1,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdout: Buffer.concat(stdoutChunks).toString("utf8")
      };

      if (result.exitCode === 0) {
        resolve(result);
        return;
      }

      const message = `CodeCouncil CLI exited with code ${result.exitCode}.`;
      void vscode.window.showErrorMessage(message);
      reject(new Error(message));
    });
  });
}

async function refreshAvailabilityStatus(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const available = await checkCliAvailable(workspaceRoot);
  const item = statusBarItem;

  if (!item) {
    return;
  }

  if (available) {
    item.text = "$(check) CodeCouncil";
    item.tooltip = "CodeCouncil CLI is available.";
    item.backgroundColor = undefined;
    return;
  }

  item.text = "$(warning) CodeCouncil";
  item.tooltip = "CodeCouncil CLI was not found. Click to run doctor after installing or linking the CLI.";
}

async function ensureCliAvailable(cwd: string): Promise<boolean> {
  if (await checkCliAvailable(cwd)) {
    return true;
  }

  await showMissingCliMessage();
  return false;
}

async function checkCliAvailable(cwd: string): Promise<boolean> {
  const invocation = getCliInvocation();

  return new Promise<boolean>((resolve) => {
    const child = spawn(invocation.command, [...invocation.args, "--version"], {
      cwd,
      env: process.env,
      shell: false
    });

    child.on("error", () => resolve(false));
    child.on("close", (exitCode) => resolve(exitCode === 0));
  });
}

async function showMissingCliMessage(): Promise<void> {
  const selection = await vscode.window.showWarningMessage(
    "CodeCouncil CLI was not found. Run `pnpm build && pnpm link --global` from the CodeCouncil repo, or set `codecouncil.cliPath`.",
    "Open Settings"
  );

  if (selection === "Open Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "codecouncil.cliPath");
  }
}

async function selectWorkspaceRoot(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    void vscode.window.showWarningMessage("Open a workspace folder before running CodeCouncil.");
    return undefined;
  }

  if (folders.length === 1) {
    return folders[0]?.uri.fsPath;
  }

  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      description: folder.uri.fsPath,
      fsPath: folder.uri.fsPath,
      label: folder.name
    })) satisfies WorkspacePick[],
    {
      matchOnDescription: true,
      placeHolder: "Select workspace folder"
    }
  );

  return picked?.fsPath;
}

function getCliInvocation(): CliInvocation {
  const cliPath = vscode.workspace
    .getConfiguration("codecouncil")
    .get<string>("cliPath", "codecouncil")
    .trim();

  if (cliPath.endsWith(".js")) {
    return {
      args: [cliPath],
      command: process.execPath
    };
  }

  return {
    args: [],
    command: cliPath || "codecouncil"
  };
}

function getConfiguredWorkspaceDir(): string {
  return vscode.workspace
    .getConfiguration("codecouncil")
    .get<string>("workspaceDir", ".codecouncil")
    .trim() || ".codecouncil";
}

function getOutputChannel(): vscode.OutputChannel {
  outputChannel ??= vscode.window.createOutputChannel("CodeCouncil");
  return outputChannel;
}

function getCodeCouncilTerminal(): vscode.Terminal {
  terminal ??= vscode.window.createTerminal("CodeCouncil");
  return terminal;
}

async function listSessionIds(workspaceRoot: string): Promise<string[]> {
  const runsDir = path.join(workspaceRoot, getConfiguredWorkspaceDir(), "runs");

  try {
    const entries = await readdir(runsDir, {
      withFileTypes: true
    });

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

async function findLatestSessionArtifact(
  workspaceRoot: string,
  pathSegments: readonly string[]
): Promise<string | undefined> {
  const sessions = await listSessionIds(workspaceRoot);

  for (const sessionId of sessions) {
    const candidate = path.join(
      workspaceRoot,
      getConfiguredWorkspaceDir(),
      "runs",
      sessionId,
      ...pathSegments
    );

    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function openMarkdown(filePath: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(document, {
    preview: false
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseJsonPayload<T>(source: string): T | undefined {
  try {
    return JSON.parse(source) as T;
  } catch {
    return undefined;
  }
}

function formatCommand(invocation: CliInvocation, args: readonly string[]): string {
  return shellJoin([invocation.command, ...invocation.args, ...args]);
}

function shellJoin(parts: readonly string[]): string {
  return parts.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/u.test(value)) {
    return value;
  }

  return `'${value.replace(/'/gu, "'\\''")}'`;
}
