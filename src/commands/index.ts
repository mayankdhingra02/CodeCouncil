import type { Command } from "commander";

import { registerApplyCommand } from "./apply.js";
import { registerApproveCommand } from "./approve.js";
import { registerBenchmarkCommand } from "./benchmark.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerImplementCommand } from "./implement.js";
import { registerInitCommand } from "./init.js";
import { registerModelsCommand } from "./models.js";
import { registerPlanCommand } from "./plan.js";
import { registerReportCommand } from "./report.js";
import { registerReviewCommand } from "./review.js";
import { registerSafetyCommand } from "./safety.js";
import { registerSessionsCommand } from "./sessions.js";
import { registerResumeCommand, registerSolveCommand } from "./solve.js";
import { registerTestCommand } from "./test.js";
import { registerWorktreeCommand } from "./worktree.js";

export function registerCommands(program: Command): void {
  registerInitCommand(program);
  registerDoctorCommand(program);
  registerApplyCommand(program);
  registerApproveCommand(program);
  registerBenchmarkCommand(program);
  registerModelsCommand(program);
  registerPlanCommand(program);
  registerSolveCommand(program);
  registerImplementCommand(program);
  registerReviewCommand(program);
  registerTestCommand(program);
  registerReportCommand(program);
  registerSafetyCommand(program);
  registerResumeCommand(program);
  registerWorktreeCommand(program);
  registerSessionsCommand(program);
}
