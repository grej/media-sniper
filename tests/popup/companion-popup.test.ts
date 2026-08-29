import { beforeEach, describe, expect, it, vi } from "vitest";

function installDom(): void {
  document.body.innerHTML = `<main><div id="detectedVideosList"></div></main>`;
  const constants = globalThis as typeof globalThis & {
    __COMPANION_BUILD__: boolean;
    __COMPANION_INSTALL_URL__: string;
  };
  constants.__COMPANION_BUILD__ = true;
  constants.__COMPANION_INSTALL_URL__ = "https://example.test/install";
}

function installChrome(sendMessage: (message: { type: string; payload?: unknown }) => Promise<unknown>): void {
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage,
      onMessage: { addListener: vi.fn() },
    },
    tabs: { create: vi.fn(async () => ({})) },
    permissions: { request: vi.fn(async () => true) },
  });
}

describe("companion popup", () => {
  beforeEach(() => {
    vi.resetModules();
    installDom();
  });

  it("shows a graphical recovery path when the native host is missing", async () => {
    installChrome(async ({ type }) => {
      if (type === "COMPANION_HEALTH") {
        return { success: false, error: { code: "COMPANION_NOT_INSTALLED", message: "Companion is not connected.", recoverable: true } };
      }
      return { success: true, data: {} };
    });
    const { initializeCompanionPopup } = await import("@/popup/companion-popup");
    await initializeCompanionPopup({ browserMediaDetected: false });
    expect(document.body.textContent).toContain("Install companion");
    expect(document.body.textContent).toContain("Check again");
    expect(document.body.textContent).not.toMatch(/terminal command|run yt-dlp|brew install/i);
  });

  it("keeps browser detection primary and opens yt-dlp only when requested", async () => {
    const health = {
      protocolVersion: 1, companionVersion: "1.0.0", browserTarget: "brave", platform: "macos",
      healthy: true, issues: [], ytDlpVersion: "2026.08.19", ffmpegVersion: "8.0",
      capabilities: {
        probe: true, download: true, sectionDownload: true, exactClip: true,
        currentTabCookies: true, braveProfileCookies: true, revealOutput: true,
      },
    };
    const send = vi.fn(async ({ type }: { type: string }) => {
      if (type === "COMPANION_HEALTH") return { success: true, data: health };
      if (type === "COMPANION_GET_STATE") return { success: true, data: { summaries: [] } };
      if (type === "COMPANION_PROBE") return {
        success: true,
        data: {
          extractorKey: "Twitter", mediaId: "post", webpageUrl: "https://x.com/example/status/1",
          title: "Fallback result", durationMs: 10_000, isLive: false, probeToken: "opaque",
          probedAt: Date.now(), selections: [{ kind: "preset", key: "best", label: "Best" }],
        },
      };
      return { success: true, data: {} };
    });
    installChrome(send);
    const { initializeCompanionPopup } = await import("@/popup/companion-popup");
    await initializeCompanionPopup({ browserMediaDetected: true });

    expect(document.body.textContent).toContain("Try yt-dlp for this page");
    expect(document.getElementById("detectedVideosList")?.hidden).toBe(false);
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "COMPANION_HEALTH" }));
    expect(document.body.textContent).not.toContain("Media Sniper Companion");

    const fallback = [...document.querySelectorAll("button")]
      .find((item) => item.textContent === "Try yt-dlp for this page");
    fallback?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Fallback result"));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "COMPANION_HEALTH" }));
    expect(document.getElementById("detectedVideosList")?.hidden).toBe(true);
    expect(document.body.textContent).toContain("Back to detected media");
    expect([...document.querySelectorAll("button")].filter((item) => item.textContent === "Clip"))
      .toHaveLength(1);

    const back = [...document.querySelectorAll("button")]
      .find((item) => item.textContent === "Back to detected media");
    back?.click();
    await vi.waitFor(() => expect(document.getElementById("detectedVideosList")?.hidden).toBe(false));
    expect(document.body.textContent).not.toContain("Fallback result");
    expect(document.body.textContent).toContain("Try yt-dlp for this page");
  });

  it("renders only allowlisted selections returned by a sanitized probe", async () => {
    const health = {
      protocolVersion: 1, companionVersion: "1.0.0", browserTarget: "brave", platform: "macos",
      healthy: true, issues: [], ytDlpVersion: "2026.08.01", ffmpegVersion: "8.0",
      capabilities: { probe: true, download: true, sectionDownload: true, exactClip: true, currentTabCookies: true, braveProfileCookies: true, revealOutput: true },
    };
    const send = vi.fn(async ({ type }: { type: string }) => {
      if (type === "COMPANION_HEALTH") return { success: true, data: health };
      if (type === "COMPANION_PROBE") return {
        success: true,
        data: {
          extractorKey: "Generic", mediaId: "fixture", webpageUrl: "https://example.test/watch",
          title: "Fixture media", durationMs: 10_000, isLive: false, probeToken: "opaque",
          probedAt: Date.now(), selections: [
            { kind: "preset", key: "best", label: "Best available" },
            { kind: "preset", key: "audio-only", label: "Audio only" },
          ],
        },
      };
      return { success: true, data: {} };
    });
    installChrome(send);
    const { initializeCompanionPopup } = await import("@/popup/companion-popup");
    await initializeCompanionPopup({ browserMediaDetected: false });
    await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>("#companion-quality")?.options.length).toBe(2));
    expect(document.getElementById("detectedVideosList")?.hidden).toBe(true);
    const options = [...document.querySelectorAll<HTMLOptionElement>("#companion-quality option")];
    expect(options.map((item) => item.value)).toEqual(["best", "audio-only"]);
    expect(document.body.textContent).toContain("Fixture media");
    expect(document.querySelector(".clip-editor-slot")).not.toBeNull();
    expect([...document.querySelectorAll("button")].filter((item) => item.textContent === "Clip"))
      .toHaveLength(1);
    expect(document.querySelector("input[placeholder*='argument']")).toBeNull();
  });

  it("turns stale media tools into a friendly graphical update path", async () => {
    installChrome(async ({ type }) => {
      if (type === "COMPANION_HEALTH") {
        return {
          success: true,
          data: {
            protocolVersion: 1,
            companionVersion: "1.0.0",
            browserTarget: "brave",
            platform: "macos",
            healthy: false,
            issues: [{
              code: "TOOLS_INCOMPATIBLE",
              message: "Media Sniper's media tools need an update to keep up with this site",
              recoverable: true,
            }],
            capabilities: {
              probe: false, download: false, sectionDownload: false, exactClip: false,
              currentTabCookies: true, braveProfileCookies: true, revealOutput: true,
            },
          },
        };
      }
      return { success: true, data: {} };
    });
    const { initializeCompanionPopup } = await import("@/popup/companion-popup");
    await initializeCompanionPopup({ browserMediaDetected: false });
    expect(document.body.textContent).toContain("Update needed");
    expect(document.body.textContent).toContain("Get update");
    expect(document.body.textContent).not.toMatch(/older than 90 days|HTTP Error|403|pip|terminal/i);
  });

  it("keeps the first signed-in retry focused on the active Brave session", async () => {
    const health = {
      protocolVersion: 1, companionVersion: "1.0.0", browserTarget: "brave", platform: "macos",
      healthy: true, issues: [], ytDlpVersion: "2026.08.19", ffmpegVersion: "8.0",
      braveProfiles: [{ id: "Default", name: "Person 1" }],
      capabilities: {
        probe: true, download: true, sectionDownload: true, exactClip: true,
        currentTabCookies: true, braveProfileCookies: true, revealOutput: true,
      },
    };
    installChrome(async ({ type }) => {
      if (type === "COMPANION_HEALTH") return { success: true, data: health };
      if (type === "COMPANION_PROBE") {
        return {
          success: false,
          error: { code: "AUTH_REQUIRED", message: "raw authentication diagnostic", recoverable: true },
        };
      }
      return { success: true, data: { summaries: [] } };
    });
    const { initializeCompanionPopup } = await import("@/popup/companion-popup");
    await initializeCompanionPopup({ browserMediaDetected: false });
    await vi.waitFor(() => expect(document.body.textContent).toContain("This video needs your YouTube session."));
    expect(document.body.textContent).toContain("Retry using this Brave session");
    expect(document.body.textContent).toContain("discarded afterward and never saved in history");
    expect(document.body.textContent).not.toContain("raw authentication diagnostic");
    expect(document.body.textContent).not.toContain("Advanced:");
    expect(document.body.textContent).not.toContain("Person 1");
    expect(document.querySelector("input[type='checkbox']")).toBeNull();
  });

  it("redacts raw diagnostics saved by an older companion build", async () => {
    vi.doMock("@/core/database/downloads", () => ({
      getAllDownloads: vi.fn(async () => [{
        id: "legacy-failure",
        url: "https://www.youtube.com/watch?v=fixture",
        progress: {
          stage: "failed",
          message: "Companion operation failed",
          error: "WARNING: Your yt-dlp version is older than 90 days. HTTP Error 403: Forbidden",
        },
        operation: {
          backend: "yt-dlp",
          companion: { title: "Fixture media", errorCode: "TOOLS_INCOMPATIBLE" },
        },
      }]),
    }));
    installChrome(async ({ type }) => {
      if (type === "COMPANION_HEALTH") {
        return {
          success: true,
          data: {
            protocolVersion: 1, companionVersion: "1.0.0", browserTarget: "brave", platform: "macos",
            healthy: true, issues: [], ytDlpVersion: "2026.08.19", ffmpegVersion: "8.0",
            capabilities: {
              probe: true, download: true, sectionDownload: true, exactClip: true,
              currentTabCookies: true, braveProfileCookies: true, revealOutput: true,
            },
          },
        };
      }
      if (type === "COMPANION_PROBE") {
        return {
          success: false,
          error: { code: "FORMAT_UNAVAILABLE", message: "No supported format", recoverable: true },
        };
      }
      return { success: true, data: { summaries: [] } };
    });
    const { initializeCompanionPopup } = await import("@/popup/companion-popup");
    await initializeCompanionPopup({ browserMediaDetected: false });
    expect(document.body.textContent).toContain("Media Sniper's media tools need an update");
    expect(document.body.textContent).not.toMatch(/older than 90 days|HTTP Error|403|pip|terminal/i);
  });

  it("features a saved clip for the current page and collapses prior activity", async () => {
    const currentSummary = {
      extractorKey: "Youtube", mediaId: "current", webpageUrl: "https://www.youtube.com/watch?v=current",
      title: "Current video", durationMs: 60_000, isLive: false, isDrm: false, probeToken: "current-token",
      probedAt: Date.now(), selections: [{ kind: "preset", key: "best", label: "Best" }],
    };
    vi.doMock("@/core/database/downloads", () => ({
      getAllDownloads: vi.fn(async () => [{
        id: "current-clip", url: currentSummary.webpageUrl, createdAt: 2, updatedAt: 2,
        metadata: {}, progress: { stage: "completed", percentage: 100 },
        operation: {
          backend: "yt-dlp", kind: "clip", operationKey: "current-key",
          companion: { extractorKey: "Youtube", mediaId: "current", title: "Current video" },
        },
      }, {
        id: "old-download", url: "https://www.youtube.com/watch?v=old", createdAt: 1, updatedAt: 1,
        metadata: {}, progress: { stage: "completed", percentage: 100 },
        operation: {
          backend: "yt-dlp", kind: "download", operationKey: "old-key",
          companion: { extractorKey: "Youtube", mediaId: "old", title: "Old video" },
        },
      }]),
    }));
    installChrome(async ({ type }) => {
      if (type === "COMPANION_GET_STATE") return { success: true, data: { summaries: [currentSummary] } };
      if (type === "COMPANION_HEALTH") return {
        success: true,
        data: {
          protocolVersion: 1, companionVersion: "1.0.0", browserTarget: "brave", platform: "macos",
          healthy: true, issues: [], ytDlpVersion: "2026.08.19", ffmpegVersion: "8.0",
          capabilities: {
            probe: true, download: true, sectionDownload: true, exactClip: true,
            currentTabCookies: true, braveProfileCookies: true, revealOutput: true,
          },
        },
      };
      return { success: true, data: {} };
    });

    const { initializeCompanionPopup } = await import("@/popup/companion-popup");
    await initializeCompanionPopup({ browserMediaDetected: false });

    expect(document.body.textContent).toContain("Clip saved");
    expect(document.body.textContent).toContain("Saved to Downloads/Media Sniper");
    const history = document.querySelector<HTMLDetailsElement>("details.companion-history");
    expect(history?.open).toBe(false);
    expect(history?.querySelector("summary")?.textContent).toBe("Previous companion activity (1)");
  });
});
