import { useEffect, useRef } from "react";
import { useFileDropContext } from "./context";
import type { FileDropSink } from "./types";

interface UseFileDropOptions {
  /** When true, the zone hides the backdrop and rejects drops atomically (e.g. while submitting). */
  disabled?: boolean;
  /**
   * Whether this consumer is the one the user is working in. With several consumers under one
   * zone, the active one takes the drop. Defaults to true for zones with a single consumer.
   */
  active?: boolean;
}

/**
 * Receive files dropped onto the surrounding FileDropZone. The sink is read through
 * a ref, so passing a fresh object every render neither re-registers nor re-renders.
 * No-ops when rendered without a FileDropZone ancestor.
 */
export function useFileDrop(sink: FileDropSink, options?: UseFileDropOptions): void {
  const ctx = useFileDropContext();
  const sinkRef = useRef(sink);
  sinkRef.current = sink;
  const disabled = options?.disabled ?? false;
  const active = options?.active ?? true;

  const activeRef = useRef(active);
  activeRef.current = active;

  const registerSink = ctx?.registerSink;
  useEffect(() => {
    if (!registerSink) return;
    return registerSink(
      () => sinkRef.current,
      () => activeRef.current,
    );
  }, [registerSink]);

  const suppressed = ctx?.suppressed;
  useEffect(() => {
    // Only the consumer that would take the drop gets to reject it. A background composer
    // mid-submit must not suppress drops on the one the user is looking at.
    if (!suppressed || !active) return;
    suppressed.value = disabled;
    return () => {
      suppressed.value = false;
    };
  }, [suppressed, disabled, active]);
}
