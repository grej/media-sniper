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
    await initializeCompanionPopup();
    expect(document.body.textContent).toContain("Install companion");
    expect(document.body.textContent).toContain("Check again");
    expect(document.body.textContent).not.toMatch(/terminal command|run yt-dlp|brew install/i);
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
    await initializeCompanionPopup();
    const analyze = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Analyze"));
    analyze?.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>("#companion-quality")?.options.length).toBe(2));
    const options = [...document.querySelectorAll<HTMLOptionElement>("#companion-quality option")];
    expect(options.map((item) => item.value)).toEqual(["best", "audio-only"]);
    expect(document.body.textContent).toContain("Page via companion");
    expect(document.querySelector("input[placeholder*='argument']")).toBeNull();
  });
});
