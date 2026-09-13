import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionClient, CompanionClientError, type NativePortLike } from "@/core/companion/client";

class FakePort implements NativePortLike {
  messages: unknown[] = [];
  disconnects = 0;
  messageListener: (message: unknown) => void = () => undefined;
  disconnectListener: () => void = () => undefined;
  postMessage(message: unknown): void { this.messages.push(message); }
  disconnect(): void { this.disconnects += 1; this.disconnectListener(); }
  onMessage = { addListener: (listener: (message: unknown) => void) => { this.messageListener = listener; } };
  onDisconnect = { addListener: (listener: () => void) => { this.disconnectListener = listener; } };
}

describe("CompanionClient", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: () => ({ version: "1.12.0" }),
        lastError: undefined,
      },
    });
  });

  it("uses one long-lived port and correlates structured replies", async () => {
    const port = new FakePort();
    const connect = vi.fn(() => port);
    const client = new CompanionClient(connect);
    const pending = client.hello("brave");
    const request = port.messages[0] as { requestId: string; protocolVersion: number; type: string };
    expect(request.type).toBe("hello");
    expect(request.protocolVersion).toBe(1);
    port.messageListener({
      protocolVersion: 1,
      requestId: request.requestId,
      type: "hello_result",
      payload: {
        protocolVersion: 1, companionVersion: "1.0.0", browserTarget: "brave", platform: "macos",
        healthy: true, issues: [], braveProfiles: [], capabilities: {
          probe: true, download: true, sectionDownload: true, exactClip: true,
          currentTabCookies: true, braveProfileCookies: true, revealOutput: true,
        },
      },
    });
    await expect(pending).resolves.toMatchObject({ healthy: true });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("rejects pending work when the native port disconnects", async () => {
    const port = new FakePort();
    const client = new CompanionClient(() => port);
    const pending = client.request("probe", { pageUrl: "https://example.test", auth: { mode: "anonymous" } });
    port.disconnectListener();
    await expect(pending).rejects.toBeInstanceOf(CompanionClientError);
  });

  it("treats malformed native output as a protocol mismatch", async () => {
    const port = new FakePort();
    const client = new CompanionClient(() => port);
    const pending = client.request("probe", { pageUrl: "https://example.test", auth: { mode: "anonymous" } });
    port.messageListener({ command: "not-framed" });
    await expect(pending).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
    expect(port.disconnects).toBe(1);
  });

  it("normalizes a synchronous native connection failure", async () => {
    const client = new CompanionClient(() => { throw new Error("host missing"); });
    await expect(client.hello("brave")).rejects.toMatchObject({ code: "COMPANION_NOT_INSTALLED" });
  });

  it("rejects invalid outbound payloads before opening or posting to a native port", async () => {
    const port = new FakePort();
    const connect = vi.fn(() => port);
    const client = new CompanionClient(connect);
    await expect(client.request("probe", {
      pageUrl: "https://example.test/watch",
      auth: {
        mode: "current-tab",
        pageUrl: "https://example.test/watch",
        referer: "https://example.test/watch",
        userAgent: "Brave",
        cookieStoreId: "0",
        incognito: false,
        cookies: [{
          name: "x".repeat(257), value: "secret", domain: ".example.test", path: "/",
          secure: true, httpOnly: true, sameSite: "lax", hostOnly: false, session: true,
        }],
      },
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(connect).not.toHaveBeenCalled();
    expect(port.messages).toHaveLength(0);
  });
});
