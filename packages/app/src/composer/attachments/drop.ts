import {
  getMimeTypeFromPath,
  isRasterImageFile,
  isRasterImagePath,
} from "@/attachments/file-types";
import { readDesktopFileBytes, type SelectedFile } from "@/attachments/selected-file";
import type { DroppedItem } from "@/components/file-drop/types";

interface DroppedAttachmentsRuntime {
  readDesktopFileBytes(path: string): Promise<Uint8Array>;
}

const defaultRuntime: DroppedAttachmentsRuntime = {
  readDesktopFileBytes,
};

function fileNameFromPath(path: string): string {
  const segments = path.split(/[/\\]/);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment) {
      return segment;
    }
  }
  return path;
}

/**
 * Separates dropped paths that point at a raster image. `droppedItemsToSelectedFiles` skips those —
 * an image belongs in the composer as an image attachment, not as an uploaded file — so a caller
 * that does not persist them first drops the image on the floor.
 */
export function splitDroppedImagePaths(items: readonly DroppedItem[]): {
  imagePaths: string[];
  otherItems: DroppedItem[];
} {
  const imagePaths: string[] = [];
  const otherItems: DroppedItem[] = [];
  for (const item of items) {
    if (item.kind !== "web-file" && isRasterImagePath(item.path)) {
      imagePaths.push(item.path);
      continue;
    }
    otherItems.push(item);
  }
  return { imagePaths, otherItems };
}

export function droppedItemsToSelectedFiles(
  items: DroppedItem[],
  runtime: DroppedAttachmentsRuntime = defaultRuntime,
): SelectedFile[] {
  const files: SelectedFile[] = [];

  for (const item of items) {
    if (item.kind === "web-file") {
      if (isRasterImageFile(item.file)) {
        continue;
      }
      const file = item.file;
      files.push({
        fileName: file.name,
        mimeType: file.type || getMimeTypeFromPath(file.name),
        readBytes: async () => new Uint8Array(await file.arrayBuffer()),
      });
      continue;
    }

    if (isRasterImagePath(item.path)) {
      continue;
    }
    const path = item.path;
    files.push({
      fileName: fileNameFromPath(path),
      mimeType: getMimeTypeFromPath(path),
      readBytes: () => runtime.readDesktopFileBytes(path),
    });
  }

  return files;
}
