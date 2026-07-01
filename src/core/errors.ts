export interface CodeCouncilErrorOptions {
  code?: string;
  exitCode?: number;
  cause?: unknown;
}

export class CodeCouncilError extends Error {
  public readonly code: string;
  public readonly exitCode: number;

  public constructor(message: string, options: CodeCouncilErrorOptions = {}) {
    super(
      message,
      options.cause === undefined
        ? undefined
        : {
            cause: options.cause
          }
    );

    this.name = new.target.name;
    this.code = options.code ?? "CODECOUNCIL_ERROR";
    this.exitCode = options.exitCode ?? 1;
  }
}

export class ConfigError extends CodeCouncilError {
  public constructor(message: string, cause?: unknown) {
    super(message, {
      cause,
      code: "CONFIG_ERROR",
      exitCode: 2
    });
  }
}

export function toCodeCouncilError(error: unknown): CodeCouncilError {
  if (error instanceof CodeCouncilError) {
    return error;
  }

  if (error instanceof Error) {
    return new CodeCouncilError(error.message, {
      cause: error,
      code: "UNEXPECTED_ERROR",
      exitCode: 1
    });
  }

  return new CodeCouncilError("An unknown error occurred.", {
    cause: error,
    code: "UNEXPECTED_ERROR",
    exitCode: 1
  });
}

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function handleCliError(error: unknown): never {
  const normalized = toCodeCouncilError(error);
  process.stderr.write(`codecouncil: ${normalized.message}\n`);

  if (process.env["CODECOUNCIL_DEBUG"] === "1" && normalized.stack) {
    process.stderr.write(`${normalized.stack}\n`);
  }

  process.exit(normalized.exitCode);
}
