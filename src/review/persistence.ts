import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ReviewOutput } from "../agents/index.js";
import type { TaskSession } from "../session/index.js";
import type { TargetReviewAggregate } from "./aggregation.js";

export interface SavedReviewArtifacts {
  jsonPath: string;
  markdownPath: string;
  rawOutputPath?: string;
}

export async function saveReviewArtifacts(options: {
  review: ReviewOutput;
  session: TaskSession;
}): Promise<SavedReviewArtifacts> {
  await mkdir(options.session.paths.reviewsDir, { recursive: true });

  const baseName = `${options.review.reviewerAgentId}-reviews-${options.review.targetAgentId}`;
  const jsonPath = path.join(options.session.paths.reviewsDir, `${baseName}.json`);
  const markdownPath = path.join(options.session.paths.reviewsDir, `${baseName}.md`);
  const rawOutputPath = path.join(options.session.paths.reviewsDir, `${baseName}.raw.txt`);

  await writeFile(jsonPath, `${JSON.stringify(options.review, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderReviewMarkdown(options.review), "utf8");

  if (options.review.rawOutput) {
    await writeFile(
      rawOutputPath,
      [
        "STDOUT",
        options.review.rawOutput.stdout,
        "",
        "STDERR",
        options.review.rawOutput.stderr,
        ""
      ].join("\n"),
      "utf8"
    );

    return {
      jsonPath,
      markdownPath,
      rawOutputPath
    };
  }

  return {
    jsonPath,
    markdownPath
  };
}

export async function saveReviewSummary(options: {
  aggregates: readonly TargetReviewAggregate[];
  reviews: readonly ReviewOutput[];
  session: TaskSession;
}): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(options.session.paths.reviewsDir, { recursive: true });

  const jsonPath = path.join(options.session.paths.reviewsDir, "summary.json");
  const markdownPath = path.join(options.session.paths.reviewsDir, "summary.md");
  const payload = {
    aggregates: options.aggregates,
    generatedAt: new Date().toISOString(),
    reviewCount: options.reviews.length,
    reviews: options.reviews.map((review) => ({
      blockingIssues: review.blockingIssues.length,
      reviewerAgentId: review.reviewerAgentId,
      securityConcerns: review.securityConcerns.length,
      targetAgentId: review.targetAgentId,
      verdict: review.verdict
    })),
    sessionId: options.session.id
  };

  await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderReviewSummaryMarkdown(options.aggregates, options.reviews), "utf8");

  return {
    jsonPath,
    markdownPath
  };
}

export function renderReviewMarkdown(review: ReviewOutput): string {
  return `${[
    `# Review: ${review.reviewerAgentId} reviews ${review.targetAgentId}`,
    "",
    `Verdict: ${review.verdict}`,
    `Confidence: ${review.confidence}`,
    "",
    "## Summary",
    "",
    review.summary,
    "",
    renderList("Blocking Issues", review.blockingIssues),
    renderList("Non-Blocking Issues", review.nonBlockingIssues),
    renderList("Security Concerns", review.securityConcerns),
    renderList("Missing Tests", review.missingTests),
    renderList("Edge Cases", review.edgeCases),
    renderList("Maintainability Concerns", review.maintainabilityConcerns),
    renderList("Suggested Fixes", review.suggestedFixes),
    "## Recommendation",
    "",
    review.recommendation,
    ""
  ].join("\n")}\n`;
}

function renderReviewSummaryMarkdown(
  aggregates: readonly TargetReviewAggregate[],
  reviews: readonly ReviewOutput[]
): string {
  const lines = [
    "# Review Summary",
    "",
    "| Target | Reviews | Approvals | Request Changes | Rejections | Blocking | Security | Missing Tests |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];

  for (const aggregate of aggregates) {
    lines.push(
      `| ${aggregate.targetAgentId} | ${aggregate.reviewCount} | ${aggregate.approvals} | ${aggregate.requestChangesCount} | ${aggregate.rejectionCount} | ${aggregate.blockingIssueCount} | ${aggregate.securityConcernCount} | ${aggregate.missingTestCount} |`
    );
  }

  lines.push("", "## Pair Reviews", "");

  for (const review of reviews) {
    lines.push(
      `- ${review.reviewerAgentId} reviewed ${review.targetAgentId}: ${review.verdict} (${review.blockingIssues.length} blocking, ${review.securityConcerns.length} security)`
    );
  }

  return `${lines.join("\n")}\n`;
}

function renderList(title: string, items: readonly string[]): string {
  return [
    `## ${title}`,
    "",
    ...(items.length > 0 ? items.map((item) => `- ${item}`) : ["- None reported."]),
    ""
  ].join("\n");
}
