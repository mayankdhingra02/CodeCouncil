export {
  classifyFilePath,
  classifyChangedFiles,
  type FileChangeSafetyOptions,
  type FilePathSafetyClassification,
  type FileChangeSafetyResult
} from "./fileChanges.js";
export {
  classifyDangerousCommand,
  hasHighRiskCommand,
  scanTextForDangerousCommands,
  type CommandRiskSeverity,
  type DangerousCommandFinding
} from "./commands.js";
export {
  generateSafetySummary,
  renderSafetySummaryMarkdown,
  saveSafetySummary,
  type SafetySummary,
  type SaveSafetySummaryResult
} from "./report.js";
