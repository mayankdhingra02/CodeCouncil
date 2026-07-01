import type { ReviewOutput, ReviewVerdict } from "../agents/index.js";
import type { AgentId } from "../config/schema.js";

export interface TargetReviewAggregate {
  approvals: number;
  blockingIssueCount: number;
  missingTestCount: number;
  nonBlockingIssueCount: number;
  rejectionCount: number;
  requestChangesCount: number;
  reviewCount: number;
  securityConcernCount: number;
  targetAgentId: AgentId;
  verdicts: Record<ReviewVerdict, number>;
}

export function aggregateReviews(reviews: readonly ReviewOutput[]): TargetReviewAggregate[] {
  const byTarget = new Map<AgentId, ReviewOutput[]>();

  for (const review of reviews) {
    byTarget.set(review.targetAgentId, [...(byTarget.get(review.targetAgentId) ?? []), review]);
  }

  return [...byTarget.entries()]
    .map(([targetAgentId, targetReviews]) => aggregateTargetReviews(targetAgentId, targetReviews))
    .sort((a, b) => a.targetAgentId.localeCompare(b.targetAgentId));
}

export function aggregateTargetReviews(
  targetAgentId: AgentId,
  reviews: readonly ReviewOutput[]
): TargetReviewAggregate {
  const verdicts: Record<ReviewVerdict, number> = {
    approve: 0,
    reject: 0,
    request_changes: 0
  };

  for (const review of reviews) {
    verdicts[review.verdict] = (verdicts[review.verdict] ?? 0) + 1;
  }

  return {
    approvals: verdicts.approve ?? 0,
    blockingIssueCount: sum(reviews, (review) => review.blockingIssues.length),
    missingTestCount: sum(reviews, (review) => review.missingTests.length),
    nonBlockingIssueCount: sum(reviews, (review) => review.nonBlockingIssues.length),
    rejectionCount: verdicts.reject ?? 0,
    requestChangesCount: verdicts.request_changes ?? 0,
    reviewCount: reviews.length,
    securityConcernCount: sum(reviews, (review) => review.securityConcerns.length),
    targetAgentId,
    verdicts
  };
}

function sum<T>(values: readonly T[], selector: (value: T) => number): number {
  return values.reduce((total, value) => total + selector(value), 0);
}
