import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";

import {
  createBenchmarkRunId,
  loadBenchmarkTasks,
  parseBenchmarkStrategies,
  readBenchmarkResults,
  requiresRealBenchmarkConfirmation,
  runBenchmark,
  writeBenchmarkOutputs
} from "../benchmark/index.js";
import { CodeCouncilError } from "../core/errors.js";
import { getCommandContext, writeResult } from "./context.js";
import { parseAgentsOption, relativeToCwd } from "./shared.js";
import type { AgentId } from "../config/schema.js";
import type { BenchmarkMetricResult } from "../benchmark/index.js";

interface BenchmarkOptions {
  agents?: string;
  outputDir?: string;
  strategies?: string;
  tasks?: string;
  yes?: boolean;
}

interface BenchmarkLabelOptions {
  accepted?: string;
  notes?: string;
  outputDir?: string;
  run?: string;
  strategy?: string;
  task?: string;
}

export function registerBenchmarkCommand(program: Command): void {
  const benchmark = program
    .command("benchmark")
    .description("Run reproducible benchmark strategies across local repositories.")
    .option("--tasks <path>", "path to benchmark task JSON file")
    .option("--agents <agents>", "comma-separated agent ids, for example codex,claude")
    .option("--strategies <strategies>", "comma-separated strategy ids; defaults to all")
    .option("--output-dir <path>", "benchmark output directory", "benchmark")
    .option("--yes", "confirm real-agent benchmark execution")
    .action(async (options: BenchmarkOptions, command: Command) => {
      const context = getCommandContext(command);

      if (!options.tasks) {
        throw new CodeCouncilError("Benchmark requires --tasks <tasks.json>.", {
          code: "MISSING_BENCHMARK_TASKS",
          exitCode: 2
        });
      }

      if (!options.agents) {
        throw new CodeCouncilError("Benchmark requires --agents codex,claude.", {
          code: "MISSING_BENCHMARK_AGENTS",
          exitCode: 2
        });
      }

      const agentIds = parseAgentsOption(options.agents) as AgentId[];

      if (requiresRealBenchmarkConfirmation(agentIds) && options.yes !== true) {
        throw new CodeCouncilError(
          "Real-agent benchmark runs can execute many local CLI calls. Re-run with --yes after reviewing the task file.",
          {
            code: "BENCHMARK_CONFIRMATION_REQUIRED",
            exitCode: 2
          }
        );
      }

      const tasksPath = path.resolve(context.cwd, options.tasks);
      const outputRoot = path.resolve(context.cwd, options.outputDir ?? "benchmark");
      const runId = createBenchmarkRunId();
      const outputDir = path.join(outputRoot, runId);
      const tasks = await loadBenchmarkTasks(tasksPath);
      const strategies = parseBenchmarkStrategies(options.strategies);
      const results = await runBenchmark({
        agentIds,
        outputDir,
        runId,
        strategies,
        tasks,
        tasksPath
      });
      const outputs = await writeBenchmarkOutputs({
        outputDir,
        results,
        runId
      });
      const latestPath = path.join(outputRoot, "latest.json");

      await mkdir(outputRoot, { recursive: true });
      await writeFile(
        latestPath,
        `${JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            runId,
            outputDir,
            tasksPath
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      writeResult(
        context,
        {
          agents: agentIds,
          command: "benchmark",
          outputDir,
          outputs,
          resultCount: results.length,
          runId,
          status: "success",
          strategies,
          taskCount: tasks.length
        },
        [
          "Benchmark complete.",
          `Run: ${runId}`,
          `Tasks: ${tasks.length}`,
          `Strategies: ${strategies.join(", ")}`,
          `Results: ${results.length}`,
          `Output: ${relativeToCwd(context, outputDir)}`,
          `Summary: ${relativeToCwd(context, outputs.summaryMarkdownPath)}`,
          `CSV: ${relativeToCwd(context, outputs.tableCsvPath)}`,
          "",
          `Label later: codecouncil benchmark label --run ${runId} --accepted true --notes "..."`
        ]
      );
    });

  benchmark
    .command("label")
    .description("Add or update human inspection labels for a benchmark run.")
    .requiredOption("--run <id>", "benchmark run id")
    .requiredOption("--accepted <true|false>", "whether the inspected result was accepted")
    .option("--notes <notes>", "human inspection notes")
    .option("--task <id>", "optional task id to label")
    .option("--strategy <strategy>", "optional strategy id to label")
    .option("--output-dir <path>", "benchmark output directory", "benchmark")
    .action(async (options: BenchmarkLabelOptions, command: Command) => {
      const context = getCommandContext(command);
      const runId = requireOption(options.run, "--run");
      const accepted = parseBooleanOption(requireOption(options.accepted, "--accepted"));
      const outputDir = path.resolve(context.cwd, options.outputDir ?? "benchmark", runId);
      const resultsPath = path.join(outputDir, "results.jsonl");
      const results = await readBenchmarkResults(resultsPath);
      const updated = applyBenchmarkLabel(results, {
        accepted,
        ...(options.notes ? { notes: options.notes } : {}),
        ...(options.strategy ? { strategy: options.strategy } : {}),
        ...(options.task ? { taskId: options.task } : {})
      });
      const outputs = await writeBenchmarkOutputs({
        outputDir,
        results: updated.results,
        runId
      });
      const labelPath = path.join(outputDir, "labels.jsonl");

      await appendFile(
        labelPath,
        `${JSON.stringify({
          accepted,
          labeledAt: new Date().toISOString(),
          notes: options.notes ?? "",
          runId,
          strategy: options.strategy ?? null,
          taskId: options.task ?? null
        })}\n`,
        "utf8"
      );

      writeResult(
        context,
        {
          command: "benchmark.label",
          labeledResults: updated.labeledResults,
          labelPath,
          outputs,
          runId,
          status: "success"
        },
        [
          "Benchmark label saved.",
          `Run: ${runId}`,
          `Updated results: ${updated.labeledResults}`,
          `Labels: ${relativeToCwd(context, labelPath)}`,
          `Summary: ${relativeToCwd(context, outputs.summaryMarkdownPath)}`
        ]
      );
    });
}

function applyBenchmarkLabel(
  results: readonly BenchmarkMetricResult[],
  label: {
    accepted: boolean;
    notes?: string;
    strategy?: string;
    taskId?: string;
  }
): { labeledResults: number; results: BenchmarkMetricResult[] } {
  let labeledResults = 0;
  const updated = results.map((result) => {
    const matchesTask = !label.taskId || result.taskId === label.taskId;
    const matchesStrategy = !label.strategy || result.strategy === label.strategy;

    if (!matchesTask || !matchesStrategy) {
      return result;
    }

    labeledResults += 1;
    return {
      ...result,
      acceptedByHuman: label.accepted,
      ...(label.notes ? { humanNotes: label.notes } : {})
    };
  });

  if (labeledResults === 0) {
    throw new CodeCouncilError("No benchmark results matched the requested label filter.", {
      code: "BENCHMARK_LABEL_NO_MATCH",
      exitCode: 2
    });
  }

  return {
    labeledResults,
    results: updated
  };
}

function parseBooleanOption(value: string): boolean {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new CodeCouncilError("--accepted must be true or false.", {
    code: "INVALID_BOOLEAN",
    exitCode: 2
  });
}

function requireOption(value: string | undefined, name: string): string {
  if (!value) {
    throw new CodeCouncilError(`Missing ${name}.`, {
      code: "MISSING_OPTION",
      exitCode: 2
    });
  }

  return value;
}
