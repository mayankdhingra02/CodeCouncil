import { CodeCouncilError } from "../core/errors.js";

export interface ParsedCommandLine {
  args: string[];
  command: string;
}

const UNSUPPORTED_SHELL_TOKENS = new Set([
  "&&",
  "||",
  "|",
  ";",
  ">",
  ">>",
  "<"
]);

export function parseCommandLine(commandLine: string): ParsedCommandLine {
  const tokens = tokenize(commandLine);

  if (tokens.length === 0) {
    throw new CodeCouncilError("Test command cannot be empty.", {
      code: "EMPTY_TEST_COMMAND",
      exitCode: 2
    });
  }

  const unsupportedToken = tokens.find((token) => UNSUPPORTED_SHELL_TOKENS.has(token));

  if (unsupportedToken) {
    throw new CodeCouncilError(
      `Compound shell test commands are not supported: found "${unsupportedToken}". Configure one test command per entry.`,
      {
        code: "UNSUPPORTED_TEST_COMMAND",
        exitCode: 2
      }
    );
  }

  const [command, ...args] = tokens;

  if (!command) {
    throw new CodeCouncilError("Test command cannot be empty.", {
      code: "EMPTY_TEST_COMMAND",
      exitCode: 2
    });
  }

  return {
    args,
    command
  };
}

function tokenize(commandLine: string): string[] {
  const tokens = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  let escaping = false;

  for (const char of commandLine.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }

      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }

      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (quote) {
    throw new CodeCouncilError("Unterminated quote in test command.", {
      code: "INVALID_TEST_COMMAND",
      exitCode: 2
    });
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}
