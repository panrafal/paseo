import type { ILinkHandler } from "@xterm/xterm";

export interface TerminalUrlOpenOptions {
  // Cmd/Ctrl-click opens the link on the other side of the Service URLs setting.
  invertBehavior: boolean;
}

export type TerminalUrlOpener = (
  url: string,
  options: TerminalUrlOpenOptions,
) => Promise<void> | void;

type LinkActivationEvent = Pick<MouseEvent, "preventDefault" | "metaKey" | "ctrlKey">;

export function activateTerminalUrl(
  event: LinkActivationEvent,
  uri: string,
  opener: TerminalUrlOpener | undefined,
): void {
  event.preventDefault();
  void opener?.(uri, { invertBehavior: event.metaKey === true || event.ctrlKey === true });
}

// OSC 8 hyperlinks bypass the web-links addon. Without a linkHandler xterm falls back to
// confirm() + window.open(), which on Electron spawns a new Paseo window. Route them
// through the same opener plain-text URLs already use.
export function createTerminalLinkHandler(
  getOpener: () => TerminalUrlOpener | undefined,
): ILinkHandler {
  return {
    activate: (event, uri) => activateTerminalUrl(event, uri, getOpener()),
  };
}
