import type { PrHint } from "@/git/pr-hint";

/**
 * Where a change request's review stands, reduced to the two verdicts that decide a merge. Both
 * can be true at once: one reviewer approved while another asked for changes, and the row shows
 * both rather than letting one hide the other.
 *
 * The names are empty when the forge reports only the overall decision.
 */
export interface ReviewSummary {
  approvedBy: string[];
  changesRequestedBy: string[];
  approved: boolean;
  changesRequested: boolean;
}

/**
 * Per-reviewer verdicts name who decided; the forge's overall decision still counts when it
 * names nobody, which is all a daemon from before per-reviewer verdicts, or a forge that does
 * not report them, can say. A review that only comments says nothing about the merge, so a
 * change request with nothing but comments has no summary.
 */
export function selectReviewSummary(hint: PrHint | null): ReviewSummary | null {
  if (!hint) return null;

  const approvedBy: string[] = [];
  const changesRequestedBy: string[] = [];
  for (const review of hint.reviews ?? []) {
    if (review.state === "approved") approvedBy.push(review.author);
    else if (review.state === "changes_requested") changesRequestedBy.push(review.author);
  }

  const approved = approvedBy.length > 0 || hint.reviewDecision === "approved";
  const changesRequested =
    changesRequestedBy.length > 0 || hint.reviewDecision === "changes_requested";
  if (!approved && !changesRequested) return null;

  return { approvedBy, changesRequestedBy, approved, changesRequested };
}
