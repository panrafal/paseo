import { describe, expect, it } from "vitest";
import { resolveFileDropIntent } from "./intent";

describe("resolveFileDropIntent", () => {
  it("references a plain drop", () => {
    expect(resolveFileDropIntent({ altKey: false, shiftKey: false, isVscode: false })).toBe(
      "reference",
    );
  });

  it("attaches on Shift outside VS Code", () => {
    expect(resolveFileDropIntent({ altKey: false, shiftKey: true, isVscode: false })).toBe(
      "attach",
    );
  });

  it("still references a Shift drop in VS Code, where Shift is the only way in", () => {
    expect(resolveFileDropIntent({ altKey: false, shiftKey: true, isVscode: true })).toBe(
      "reference",
    );
  });

  it("attaches on Option everywhere", () => {
    expect(resolveFileDropIntent({ altKey: true, shiftKey: false, isVscode: false })).toBe(
      "attach",
    );
    expect(resolveFileDropIntent({ altKey: true, shiftKey: true, isVscode: true })).toBe("attach");
  });
});
