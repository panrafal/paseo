import { describe, expect, it } from "vitest";
import {
  buildDesktopNavigationRoute,
  buildForwardedDeepLinkData,
  DesktopNavigationInbox,
  findDesktopDeepLink,
  parseDesktopDeepLink,
  readForwardedDeepLink,
} from "./desktop-navigation.js";

describe("desktop navigation", () => {
  it("parses agent and new-workspace deep links into navigation targets", () => {
    expect(parseDesktopDeepLink("paseo://h/server-1/agent/agent-2")).toEqual({
      kind: "agent",
      serverId: "server-1",
      agentId: "agent-2",
    });
    expect(parseDesktopDeepLink("paseo://new?serverId=server-1&q=Start")).toEqual({
      kind: "new-workspace",
      route: "/new?serverId=server-1&q=Start",
    });
    expect(parseDesktopDeepLink("paseo://settings")).toBeNull();
    expect(parseDesktopDeepLink(undefined)).toBeNull();
  });

  it("finds a deep link among Electron launch arguments", () => {
    expect(
      findDesktopDeepLink([
        "/Applications/Paseo.app/Contents/MacOS/Paseo",
        "--no-sandbox",
        "paseo://new?q=Start",
      ]),
    ).toBe("paseo://new?q=Start");
    expect(findDesktopDeepLink(["/usr/bin/paseo", "/home/me/project"])).toBeNull();
  });

  it("builds the renderer route a new window opens at", () => {
    expect(
      buildDesktopNavigationRoute({ kind: "agent", serverId: "server 1", agentId: "agent-2" }),
    ).toBe("/h/server%201/agent/agent-2");
    expect(buildDesktopNavigationRoute({ kind: "new-workspace", route: "/new?q=Start" })).toBe(
      "/new?q=Start",
    );
  });

  it("round-trips a deep link through single-instance lock data", () => {
    expect(buildForwardedDeepLinkData(null)).toBeUndefined();
    expect(readForwardedDeepLink(buildForwardedDeepLinkData("paseo://new?q=Start"))).toBe(
      "paseo://new?q=Start",
    );
    expect(readForwardedDeepLink({})).toBeNull();
    expect(readForwardedDeepLink({ deepLink: 7 })).toBeNull();
    expect(readForwardedDeepLink(null)).toBeNull();
  });

  it("holds navigation until the existing renderer is ready", () => {
    const inbox = new DesktopNavigationInbox();
    const target = { kind: "new-workspace", route: "/new?q=Start" } as const;

    expect(inbox.deliverOrQueue(7, target)).toBeNull();
    expect(inbox.windowReady(7)).toEqual(target);
    expect(inbox.deliverOrQueue(7, target)).toEqual(target);
  });

  it("returns only the newest navigation queued during startup", () => {
    const inbox = new DesktopNavigationInbox();

    inbox.deliverOrQueue(7, { kind: "agent", serverId: "server-1", agentId: "agent-1" });
    inbox.deliverOrQueue(7, { kind: "new-workspace", route: "/new?q=Start" });

    expect(inbox.windowReady(7)).toEqual({ kind: "new-workspace", route: "/new?q=Start" });
    expect(inbox.windowReady(7)).toBeNull();
  });
});
