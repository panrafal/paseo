import { describe, expect, it } from "vitest";
import { parseDroppedFilePaths, resolveDroppedFileMentionPath } from "./file-drop-mentions";

describe("parseDroppedFilePaths", () => {
  it("parses text/uri-list file entries and ignores comments", () => {
    expect(
      parseDroppedFilePaths({
        uriList: [
          "# dragged from VS Code",
          "file:///home/dev/repo/packages/app/src/foo.tsx",
          "file:///home/dev/repo/packages/app/src/bar%20baz.ts",
          "https://example.com/not-a-file",
        ].join("\n"),
      }),
    ).toEqual([
      "/home/dev/repo/packages/app/src/foo.tsx",
      "/home/dev/repo/packages/app/src/bar baz.ts",
    ]);
  });

  it("deduplicates repeated file URIs", () => {
    expect(
      parseDroppedFilePaths({
        uriList:
          "file:///home/dev/repo/a.ts\nfile:///home/dev/repo/a.ts\nfile:///home/dev/repo/b.ts",
      }),
    ).toEqual(["/home/dev/repo/a.ts", "/home/dev/repo/b.ts"]);
  });

  it("takes every file from VS Code's list, which its text/uri-list truncates to the first", () => {
    expect(
      parseDroppedFilePaths({
        uriList: "file:///home/dev/repo/a.ts",
        vscodeUriList:
          "file:///home/dev/repo/a.ts\r\nfile:///home/dev/repo/b.ts\r\nfile:///home/dev/repo/c.ts",
      }),
    ).toEqual(["/home/dev/repo/a.ts", "/home/dev/repo/b.ts", "/home/dev/repo/c.ts"]);
  });

  it("reads an editor-tab drag, which sets only VS Code's list", () => {
    expect(
      parseDroppedFilePaths({
        uriList: "",
        vscodeUriList: "file:///home/dev/repo/a.ts",
      }),
    ).toEqual(["/home/dev/repo/a.ts"]);
  });

  it("falls back to the ResourceURLs JSON array", () => {
    expect(
      parseDroppedFilePaths({
        vscodeResources: JSON.stringify([
          "file:///home/dev/repo/a.ts",
          "file:///home/dev/repo/b.ts",
          42,
        ]),
      }),
    ).toEqual(["/home/dev/repo/a.ts", "/home/dev/repo/b.ts"]);
  });

  it("ignores a ResourceURLs value that is not a JSON array of strings", () => {
    expect(parseDroppedFilePaths({ vscodeResources: "not json" })).toEqual([]);
    expect(parseDroppedFilePaths({ vscodeResources: '{"resource":"file:///a.ts"}' })).toEqual([]);
  });

  it("normalizes Windows file URIs", () => {
    expect(
      parseDroppedFilePaths({
        uriList: "file:///C:/Users/dev/repo/packages/app/src/foo.tsx",
      }),
    ).toEqual(["C:/Users/dev/repo/packages/app/src/foo.tsx"]);
  });

  it("normalizes VS Code Remote WSL URIs to Linux paths", () => {
    expect(
      parseDroppedFilePaths({
        uriList: "vscode-remote://wsl+Ubuntu/home/dev/repo/packages/app/src/foo.tsx",
      }),
    ).toEqual(["/home/dev/repo/packages/app/src/foo.tsx"]);
  });

  it("normalizes WSL UNC file URIs to Linux paths", () => {
    expect(
      parseDroppedFilePaths({
        uriList: [
          "file://wsl.localhost/Ubuntu/home/dev/repo/packages/app/src/foo.tsx",
          "file://wsl$/Ubuntu/home/dev/repo/packages/app/src/bar.tsx",
          "file://///wsl.localhost/Ubuntu/home/dev/repo/packages/app/src/baz.tsx",
          "file:/wsl.localhost/Ubuntu/home/dev/repo/packages/app/src/qux.tsx",
        ].join("\n"),
      }),
    ).toEqual([
      "/home/dev/repo/packages/app/src/foo.tsx",
      "/home/dev/repo/packages/app/src/bar.tsx",
      "/home/dev/repo/packages/app/src/baz.tsx",
      "/home/dev/repo/packages/app/src/qux.tsx",
    ]);
  });
});

describe("resolveDroppedFileMentionPath", () => {
  it("resolves an absolute dropped path to a cwd-relative mention path", () => {
    expect(
      resolveDroppedFileMentionPath({
        cwd: "/home/dev/repo",
        path: "/home/dev/repo/packages/app/src/foo.tsx",
      }),
    ).toBe("packages/app/src/foo.tsx");
  });

  it("mentions a file outside the cwd by absolute path instead of uploading a copy", () => {
    expect(
      resolveDroppedFileMentionPath({
        cwd: "/home/dev/repo",
        path: "/home/dev/other/foo.tsx",
      }),
    ).toBe("/home/dev/other/foo.tsx");
  });

  it("mentions an absolute path when the composer has no cwd yet", () => {
    expect(resolveDroppedFileMentionPath({ cwd: "", path: "/home/dev/other/foo.tsx" })).toBe(
      "/home/dev/other/foo.tsx",
    );
  });

  it("normalizes the absolute path it falls back to", () => {
    expect(
      resolveDroppedFileMentionPath({
        cwd: "/home/dev/repo",
        path: "/home/dev/other/../other/foo.tsx",
      }),
    ).toBe("/home/dev/other/foo.tsx");
  });

  it("returns null for a relative path with nothing to anchor it", () => {
    expect(resolveDroppedFileMentionPath({ cwd: "", path: "packages/app/foo.tsx" })).toBeNull();
  });
});
