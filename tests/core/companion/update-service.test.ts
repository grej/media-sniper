import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEDIA_SNIPER_UPDATE_API,
  PENDING_UPDATE_TTL_MS,
} from "../../../src/core/companion/update";

type MessageListener = (
  message: { type: string },
  sender: unknown,
  respond: (value: unknown) => void,
) => boolean | void;

const storage = new Map<string, unknown>();
const messageListeners: MessageListener[] = [];
const installedListeners: Array<(details: { reason: string }) => void> = [];
const alarmListeners: Array<(alarm: { name: string }) => void> = [];
const activeDownloads = vi.fn(async () => [] as unknown[]);
const restart = vi.fn(async () => ({
  protocolVersion: 1,
  companionVersion: "1.13.0",
  installedRelease: {
    releaseVersion: "1.13.0",
    extensionVersion: "1.13.0",
    companionVersion: "1.13.0",
    toolReleaseId: "fixture",
    installedAt: "2026-08-29T15:00:00Z",
  },
  browserTarget: "brave",
  platform: "macos",
  healthy: true,
  issues: [],
  capabilities: {},
}));

function metadata(): string {
  return JSON.stringify({
    name: "media-sniper-installer",
    full_name: "gjennings/media-sniper-installer",
    owner: { login: "gjennings" },
    latest_version: "1.13.0",
    files: [{
      owner: "gjennings",
      version: "1.13.0",
      basename: "osx-arm64/media-sniper-installer-1.13.0-h1_0.conda",
      upload_time: "2026-08-29T15:00:00Z",
      labels: ["main"],
      attrs: { subdir: "osx-arm64" },
    }],
  });
}

async function send(type: string): Promise<any> {
  const listener = messageListeners[0];
  expect(listener).toBeDefined();
  return await new Promise((resolve) => {
    listener!({ type }, {}, resolve);
  });
}

describe("companion update background service", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    storage.clear();
    messageListeners.splice(0);
    installedListeners.splice(0);
    alarmListeners.splice(0);
    activeDownloads.mockResolvedValue([]);
    vi.doMock("../../../src/core/database/downloads", () => ({ getActiveDownloads: activeDownloads }));
    vi.doMock("../../../src/core/companion/service", () => ({ restartCompanionConnection: restart }));
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      url: MEDIA_SNIPER_UPDATE_API,
      headers: { get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null },
      text: async () => metadata(),
    })));
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: vi.fn(() => ({ version: "1.12.0" })),
        getPlatformInfo: vi.fn(async () => ({ os: "mac", arch: "arm" })),
        sendMessage: vi.fn(async () => undefined),
        reload: vi.fn(),
        onMessage: { addListener: (listener: MessageListener) => messageListeners.push(listener) },
        onInstalled: { addListener: (listener: (details: { reason: string }) => void) => installedListeners.push(listener) },
      },
      storage: { local: {
        get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) storage.set(key, value);
        }),
        remove: vi.fn(async (key: string) => { storage.delete(key); }),
      } },
      action: {
        setBadgeText: vi.fn(async () => undefined),
        setBadgeBackgroundColor: vi.fn(async () => undefined),
      },
      alarms: {
        get: vi.fn(async () => undefined),
        create: vi.fn(),
        onAlarm: { addListener: (listener: (alarm: { name: string }) => void) => alarmListeners.push(listener) },
      },
      tabs: {
        query: vi.fn(async () => [{ id: 42, url: "https://example.com/watch" }]),
        get: vi.fn(async () => ({ id: 42, url: "https://example.com/watch" })),
        reload: vi.fn(async () => undefined),
      },
    });
  });

  it("creates one jittered daily alarm and performs a strict manual check", async () => {
    const { registerCompanionUpdateService } = await import("../../../src/core/companion/update-service");
    registerCompanionUpdateService();
    await vi.waitFor(() => expect(chrome.alarms.create).toHaveBeenCalledTimes(1));
    const schedule = vi.mocked(chrome.alarms.create).mock.calls[0][1];
    expect(schedule.delayInMinutes).toBeGreaterThanOrEqual(5);
    expect(schedule.delayInMinutes).toBeLessThan(30);
    expect(schedule.periodInMinutes).toBe(1440);
    const response = await send("COMPANION_UPDATE_CHECK");
    expect(response.success).toBe(true);
    expect(response.data.latestVersion).toBe("1.13.0");
    expect(response.data.updateAvailable).toBe(true);
    expect(fetch).toHaveBeenCalledWith(MEDIA_SNIPER_UPDATE_API, expect.objectContaining({
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    }));
  });

  it("restarts the native connection but blocks finishing while work is active", async () => {
    const { registerCompanionUpdateService } = await import("../../../src/core/companion/update-service");
    registerCompanionUpdateService();
    const checked = await send("COMPANION_UPDATE_CHECK_INSTALLATION");
    expect(restart).toHaveBeenCalled();
    expect(checked.data.finishReady).toBe(true);
    activeDownloads.mockResolvedValueOnce([{ id: "active" }]);
    const blocked = await send("COMPANION_UPDATE_FINISH");
    expect(blocked.data.busyReason).toContain("active download or clip");
    expect(chrome.runtime.reload).not.toHaveBeenCalled();
  });

  it("refreshes only the marker-approved tab after a verified reload", async () => {
    vi.mocked(chrome.runtime.getManifest).mockReturnValue({ version: "1.13.0" } as chrome.runtime.Manifest);
    const now = Date.now();
    storage.set("mediaSniperPendingPostUpdate", {
      expectedVersion: "1.13.0",
      tabId: 42,
      normalizedUrl: "https://example.com/watch",
      createdAt: now,
      expiresAt: now + PENDING_UPDATE_TTL_MS,
    });
    const { registerCompanionUpdateService } = await import("../../../src/core/companion/update-service");
    registerCompanionUpdateService();
    await vi.waitFor(() => expect(chrome.tabs.reload).toHaveBeenCalledWith(42));
    expect(chrome.tabs.reload).toHaveBeenCalledTimes(1);
    expect(storage.has("mediaSniperPendingPostUpdate")).toBe(false);
  });
});
