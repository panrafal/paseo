import { resolveWorkspaceFilePaths } from "@/workspace/file-open";
import { isAbsolutePath } from "@/utils/path";

/**
 * VS Code's own drag type. Its `text/uri-list` carries only the *first* dragged resource, and
 * editor-tab drags leave it out entirely, so this is the only complete list of what was dragged.
 * Undocumented (`DataTransfers.INTERNAL_URI_LIST` in the workbench) — treat it as a bonus source,
 * never as the one that has to be there.
 */
export const VSCODE_URI_LIST_MIME = "application/vnd.code.uri-list";

/**
 * VS Code's oldest resource type: a JSON array of URI strings. Present on Explorer and tab drags
 * alike, and the fallback for VS Code versions that predate `VSCODE_URI_LIST_MIME`. Chromium
 * lowercases custom drag types, so this reads `resourceurls`, not the `ResourceURLs` the workbench
 * writes.
 */
export const VSCODE_RESOURCES_MIME = "resourceurls";

export interface ParseDroppedFilePathsInput {
  uriList?: string | null;
  vscodeUriList?: string | null;
  vscodeResources?: string | null;
}

function decodeUriComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function normalizeDroppedPath(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, "/");
  return normalized.length > 0 ? normalized : null;
}

function normalizeUrlPath(pathname: string): string | null {
  const windowsPath = /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  return normalizeDroppedPath(windowsPath);
}

function normalizeWslFileUriPath(hostname: string, pathname: string): string | null {
  const host = hostname.toLowerCase();
  if (host === "wsl.localhost" || host === "wsl$") {
    const match = /^\/[^/]+(\/.*)$/.exec(pathname);
    return match ? normalizeDroppedPath(match[1]) : null;
  }

  const uncMatch = /^\/+wsl(?:\.localhost|\$)\/[^/]+(\/.*)$/i.exec(pathname);
  return uncMatch ? normalizeDroppedPath(uncMatch[1]) : null;
}

function parseFileUri(value: string): string | null {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol === "vscode-remote:") {
    const decodedPath = decodeUriComponent(url.pathname);
    return decodedPath ? normalizeUrlPath(decodedPath) : null;
  }

  if (url.protocol !== "file:") {
    return null;
  }

  const decodedPath = decodeUriComponent(url.pathname);
  if (!decodedPath) {
    return null;
  }

  const decodedHost = decodeUriComponent(url.hostname) ?? "";
  const wslPath = normalizeWslFileUriPath(decodedHost, decodedPath);
  if (wslPath) {
    return wslPath;
  }

  if (decodedHost && decodedHost !== "localhost") {
    return normalizeDroppedPath(`//${decodedHost}${decodedPath}`);
  }

  return normalizeUrlPath(decodedPath);
}

function parseUriList(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .flatMap((line) => {
      const path = parseFileUri(line);
      return path ? [path] : [];
    });
}

function parseResourceUrls(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }
    const path = parseFileUri(entry);
    return path ? [path] : [];
  });
}

export function parseDroppedFilePaths(input: ParseDroppedFilePathsInput): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  // VS Code's lists first: they hold every dragged resource, while `text/uri-list` holds one.
  for (const path of [
    ...parseUriList(input.vscodeUriList),
    ...parseResourceUrls(input.vscodeResources),
    ...parseUriList(input.uriList),
  ]) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/**
 * The path to write into the prompt for a dropped file. Relative to the agent's cwd when the file
 * lives there, absolute otherwise — a second VS Code folder, a sibling worktree, a file picked from
 * outside the project, or a composer with no cwd yet. An absolute path is still a reference the
 * agent can read, and requiring a cwd-relative one silently turned those drops into uploads.
 */
export function resolveDroppedFileMentionPath(input: { path: string; cwd: string }): string | null {
  const path = input.path.trim().replace(/\\/g, "/");
  if (!path) {
    return null;
  }
  const resolved = resolveWorkspaceFilePaths({ path, workspaceRoot: input.cwd });
  if (resolved?.relativePath) {
    return resolved.relativePath;
  }
  if (!isAbsolutePath(path)) {
    return null;
  }
  return resolved?.absolutePath ?? path;
}
