export {
  GitCommandError,
  GitManager,
  assertSafeWorktreeRemovalPath,
  createAgentBranchName,
  getAgentWorktreePath,
  sanitizeGitPathSegment,
  type CommitAgentChangesOptions,
  type CommitAgentChangesResult,
  type CreatePatchFileOptions,
  type CreatePatchFileResult,
  type CreateWorktreeOptions,
  type GitCommandResult,
  type GitRepositoryStatus,
  type GitWorktreeInfo,
  type RemoveWorktreeOptions,
  type WorktreeOperationResult
} from "./GitManager.js";
