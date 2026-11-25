import { describe, expect, it } from "vitest";
import type { PrHint } from "@/git/pr-hint";
import { selectReviewSummary } from "./review-summary";

function hint(overrides: Partial<PrHint> = {}): PrHint {
  return {
    url: "https://github.com/acme/app/pull/7",
    number: 7,
    state: "open",
    forge: "github",
    ...overrides,
  };
}

describe("selectReviewSummary", () => {
  it("has nothing to say without a change request", () => {
    expect(selectReviewSummary(null)).toBeNull();
  });

  it("has nothing to say while review is pending or only commented", () => {
    expect(selectReviewSummary(hint({ reviewDecision: "pending" }))).toBeNull();
    expect(
      selectReviewSummary(hint({ reviews: [{ author: "alice", state: "commented" }] })),
    ).toBeNull();
  });

  it("names every approver", () => {
    expect(
      selectReviewSummary(
        hint({
          reviewDecision: "approved",
          reviews: [
            { author: "alice", state: "approved" },
            { author: "bob", state: "approved" },
          ],
        }),
      ),
    ).toEqual({
      approvedBy: ["alice", "bob"],
      changesRequestedBy: [],
      approved: true,
      changesRequested: false,
    });
  });

  it("keeps an approval and a change request side by side", () => {
    expect(
      selectReviewSummary(
        hint({
          reviewDecision: "changes_requested",
          reviews: [
            { author: "alice", state: "approved" },
            { author: "carol", state: "changes_requested" },
          ],
        }),
      ),
    ).toEqual({
      approvedBy: ["alice"],
      changesRequestedBy: ["carol"],
      approved: true,
      changesRequested: true,
    });
  });

  it("falls back to the overall decision when no reviewer is named", () => {
    expect(selectReviewSummary(hint({ reviewDecision: "changes_requested" }))).toEqual({
      approvedBy: [],
      changesRequestedBy: [],
      approved: false,
      changesRequested: true,
    });
  });
});
