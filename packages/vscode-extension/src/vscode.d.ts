declare module "vscode" {
  export interface Disposable {
    dispose(): void;
  }

  export interface ExtensionContext {
    subscriptions: Disposable[];
  }

  export class ThemeColor {
    public constructor(id: string);
  }

  export enum StatusBarAlignment {
    Left = 1,
    Right = 2
  }

  export interface StatusBarItem extends Disposable {
    text: string;
    tooltip?: string;
    command?: string;
    backgroundColor?: ThemeColor | undefined;
    show(): void;
    hide(): void;
  }

  export interface OutputChannel extends Disposable {
    append(value: string): void;
    appendLine(value: string): void;
    clear(): void;
    show(preserveFocus?: boolean): void;
  }

  export interface Terminal extends Disposable {
    name: string;
    sendText(text: string, addNewLine?: boolean): void;
    show(preserveFocus?: boolean): void;
  }

  export interface Uri {
    fsPath: string;
  }

  export namespace Uri {
    function file(path: string): Uri;
  }

  export interface TextDocument {
    uri: Uri;
  }

  export interface WorkspaceFolder {
    index: number;
    name: string;
    uri: Uri;
  }

  export interface WorkspaceConfiguration {
    get<T>(section: string, defaultValue: T): T;
  }

  export interface QuickPickItem {
    alwaysShow?: boolean;
    description?: string;
    detail?: string;
    label: string;
    picked?: boolean;
  }

  export interface QuickPickOptions {
    ignoreFocusOut?: boolean;
    matchOnDescription?: boolean;
    matchOnDetail?: boolean;
    placeHolder?: string;
  }

  export interface InputBoxOptions {
    ignoreFocusOut?: boolean;
    placeHolder?: string;
    prompt?: string;
    title?: string;
    validateInput?(value: string): string | undefined | null;
  }

  export interface TextDocumentShowOptions {
    preview?: boolean;
  }

  export namespace commands {
    function executeCommand<T = unknown>(command: string, ...rest: unknown[]): Promise<T>;
    function registerCommand(
      command: string,
      callback: (...args: unknown[]) => unknown,
      thisArg?: unknown
    ): Disposable;
  }

  export namespace window {
    function createOutputChannel(name: string): OutputChannel;
    function createStatusBarItem(alignment?: StatusBarAlignment, priority?: number): StatusBarItem;
    function createTerminal(name: string): Terminal;
    function showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
    function showInformationMessage(message: string, ...items: string[]): Promise<string | undefined>;
    function showInputBox(options?: InputBoxOptions): Promise<string | undefined>;
    function showQuickPick<T extends QuickPickItem>(
      items: readonly T[],
      options?: QuickPickOptions
    ): Promise<T | undefined>;
    function showTextDocument(
      document: TextDocument,
      columnOrOptions?: TextDocumentShowOptions
    ): Promise<unknown>;
    function showWarningMessage(message: string, ...items: string[]): Promise<string | undefined>;
  }

  export namespace workspace {
    const workspaceFolders: readonly WorkspaceFolder[] | undefined;
    function getConfiguration(section?: string): WorkspaceConfiguration;
    function openTextDocument(uri: Uri): Promise<TextDocument>;
  }
}
