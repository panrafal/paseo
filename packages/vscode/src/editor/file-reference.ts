export interface ComposerFileReferenceSelection {
  /** 1-based, to match how editors and agents talk about positions. */
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface ComposerFileReference {
  path: string;
  selection?: ComposerFileReferenceSelection;
}

/** The parts of a `vscode.TextEditor` this needs, so the rule stays testable without vscode. */
export interface TextEditorLike {
  document: { uri: { scheme: string; fsPath: string } };
  selection: {
    isEmpty: boolean;
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/**
 * Builds the reference "Send to Paseo" hands the composer. Returns null for anything without a
 * path on disk — an untitled buffer, a diff's virtual side, an output channel — since a mention
 * the agent cannot open is worse than telling the user nothing happened.
 */
export function buildComposerFileReference(editor: TextEditorLike): ComposerFileReference | null {
  if (editor.document.uri.scheme !== "file") {
    return null;
  }
  const path = editor.document.uri.fsPath.trim();
  if (!path) {
    return null;
  }
  if (editor.selection.isEmpty) {
    return { path };
  }
  return {
    path,
    selection: {
      startLine: editor.selection.start.line + 1,
      startColumn: editor.selection.start.character + 1,
      endLine: editor.selection.end.line + 1,
      endColumn: editor.selection.end.character + 1,
    },
  };
}
