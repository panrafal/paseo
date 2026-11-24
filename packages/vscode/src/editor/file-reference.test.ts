import { describe, expect, it } from "vitest";
import { buildComposerFileReference, type TextEditorLike } from "./file-reference";

function editor(input: {
  scheme?: string;
  fsPath?: string;
  isEmpty?: boolean;
  start?: { line: number; character: number };
  end?: { line: number; character: number };
}): TextEditorLike {
  return {
    document: { uri: { scheme: input.scheme ?? "file", fsPath: input.fsPath ?? "/repo/src/a.ts" } },
    selection: {
      isEmpty: input.isEmpty ?? true,
      start: input.start ?? { line: 0, character: 0 },
      end: input.end ?? { line: 0, character: 0 },
    },
  };
}

describe("buildComposerFileReference", () => {
  it("references the whole file when nothing is selected", () => {
    expect(buildComposerFileReference(editor({}))).toEqual({ path: "/repo/src/a.ts" });
  });

  it("converts a selection to 1-based lines and columns", () => {
    expect(
      buildComposerFileReference(
        editor({
          isEmpty: false,
          start: { line: 11, character: 4 },
          end: { line: 19, character: 2 },
        }),
      ),
    ).toEqual({
      path: "/repo/src/a.ts",
      selection: { startLine: 12, startColumn: 5, endLine: 20, endColumn: 3 },
    });
  });

  it("keeps a selection that stays inside one line", () => {
    expect(
      buildComposerFileReference(
        editor({
          isEmpty: false,
          start: { line: 4, character: 0 },
          end: { line: 4, character: 9 },
        }),
      ),
    ).toEqual({
      path: "/repo/src/a.ts",
      selection: { startLine: 5, startColumn: 1, endLine: 5, endColumn: 10 },
    });
  });

  it("refuses a buffer with no file on disk", () => {
    expect(buildComposerFileReference(editor({ scheme: "untitled" }))).toBeNull();
    expect(buildComposerFileReference(editor({ scheme: "vscode-diff" }))).toBeNull();
    expect(buildComposerFileReference(editor({ fsPath: "  " }))).toBeNull();
  });
});
