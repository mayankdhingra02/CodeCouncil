import type { AgentId } from "../config/schema.js";

export interface ReviewPair {
  reviewerAgentId: AgentId;
  targetAgentId: AgentId;
}

export function createReviewPairs(options: {
  reviewers: readonly AgentId[];
  selfReview: boolean;
  targets: readonly AgentId[];
}): ReviewPair[] {
  const pairs: ReviewPair[] = [];

  for (const reviewerAgentId of unique(options.reviewers)) {
    for (const targetAgentId of unique(options.targets)) {
      if (!options.selfReview && reviewerAgentId === targetAgentId) {
        continue;
      }

      pairs.push({
        reviewerAgentId,
        targetAgentId
      });
    }
  }

  return pairs;
}

function unique(values: readonly AgentId[]): AgentId[] {
  return [...new Set(values)];
}
