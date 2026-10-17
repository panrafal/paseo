import type { ImageAttachment } from "@/composer/types";
import type { WorkspaceFileDragPayload } from "@/attachments/workspace-file-drag";

export interface DroppedFileItem {
  kind: "web-file";
  file: File;
}
export interface DroppedPathItem {
  kind: "desktop-path";
  path: string;
}
export interface DroppedFileUriItem {
  kind: "file-uri";
  path: string;
}
export type DroppedItem = DroppedFileItem | DroppedPathItem | DroppedFileUriItem;

/**
 * What the user asked for by holding a modifier while dropping. `reference` (no modifier) writes
 * a file mention into the prompt and is the default, because a path the agent can read beats a
 * copy of the bytes. `attach` uploads a copy instead. Only path-bearing drops can honour
 * `reference` — a file dragged from the OS arrives as bytes with no path, so it is always attached.
 */
export type FileDropIntent = "reference" | "attach";

/**
 * What a consumer (e.g. a composer) registers to receive files dropped onto the
 * surrounding FileDropZone. Raster images arrive already persisted via `onFiles`;
 * everything else arrives raw via `onGenericFiles`.
 */
export interface FileDropSink {
  onFiles: (images: ImageAttachment[]) => void;
  onGenericFiles?: (items: DroppedItem[], intent: FileDropIntent) => void;
  onWorkspaceFile?: (payload: WorkspaceFileDragPayload) => void;
}
