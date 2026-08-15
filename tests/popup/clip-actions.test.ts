import { afterEach, describe, expect, it, vi } from "vitest";
import { VideoFormat, type VideoMetadata } from "../../src/core/types";
import { MessageType } from "../../src/shared/messages";
import { destroyClipEditors, toggleDetectedClipEditor } from "../../src/popup/clip-actions";

afterEach(() => {
  destroyClipEditors();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function candidate(pageVideoId: string, currentTimeMs: number) {
  return {
    pageVideoId,
    frameId: 0,
    frameUrl: "https://page.test/watch",
    currentSrc: "https://cdn.test/video.mp4",
    currentTimeMs,
    durationMs: 90_000,
    paused: false,
    ended: false,
    readyState: 4,
    visible: true,
    intersectionRatio: 1,
    renderedArea: 1280 * 720,
    muted: false,
    volume: 1,
    playbackRate: 1,
    seekableRanges: [{ startMs: 0, endMs: 90_000 }],
  };
}

describe("popup clip actions", () => {
  it("restores a draft, queries playback, and emits a typed ClipRequest", async () => {
    const messages: any[] = [];
    const chromeMock = {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 17, url: "https://page.test/watch" }]) },
      runtime: {
        lastError: undefined,
        sendMessage: (message: any, callback: (response: any) => void) => {
          messages.push(message);
          if (message.type === MessageType.GET_CLIP_DRAFT) {
            callback({
              success: true,
              draft: {
                locator: message.payload.locator,
                startMs: 4_000,
                endMs: 8_000,
                mode: "exact",
                updatedAt: Date.now(),
              },
            });
          } else if (message.type === MessageType.GET_PLAYBACK_CANDIDATES) {
            callback({ success: true, candidates: [candidate("video-1", 5_500)] });
          } else if (message.type === MessageType.CLIP_REQUEST) {
            callback({ success: true, request: message.payload, plannedOnly: true });
          } else {
            callback({ success: true });
          }
        },
      },
    };
    vi.stubGlobal("chrome", chromeMock);

    document.body.innerHTML = '<div class="video-item"><button class="video-btn-clip"></button><div class="clip-editor-slot"></div></div>';
    const button = document.querySelector<HTMLElement>(".video-btn-clip")!;
    const video: VideoMetadata = {
      url: "https://cdn.test/video.mp4#fragment",
      format: VideoFormat.DIRECT,
      pageUrl: "https://page.test/watch",
      pageVideoId: "video-1",
      frameId: 0,
    };
    await toggleDetectedClipEditor(button, video);
    await Promise.resolve();

    const inputs = document.querySelectorAll<HTMLInputElement>(".clip-time-input");
    expect([...inputs].map((input) => input.value)).toEqual(["00:04.000", "00:08.000"]);
    expect(document.querySelector<HTMLSelectElement>(".clip-mode-select")?.value).toBe("exact");
    document.querySelector<HTMLButtonElement>(".clip-submit-btn")!.click();

    await vi.waitFor(() => {
      expect(messages.some((message) => message.type === MessageType.CLIP_REQUEST)).toBe(true);
      expect(messages.filter((message) => message.type === MessageType.SET_CLIP_MARK)).toHaveLength(2);
    });
    const request = messages.find((message) => message.type === MessageType.CLIP_REQUEST).payload;
    expect(request).toMatchObject({
      url: "https://cdn.test/video.mp4",
      format: VideoFormat.DIRECT,
      tabId: 17,
      pageVideoId: "video-1",
      clip: { startMs: 4_000, endMs: 8_000, mode: "exact", markSource: "manual" },
      outputContainer: "mp4",
    });
  });

  it("shows a player selector when candidates are ambiguous", async () => {
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 3, url: "https://page.test" }]) },
      runtime: {
        lastError: undefined,
        sendMessage: (message: any, callback: (response: any) => void) => {
          callback(message.type === MessageType.GET_PLAYBACK_CANDIDATES
            ? { success: true, candidates: [candidate("a", 1_000), candidate("b", 2_000)] }
            : { success: true, draft: null });
        },
      },
    });
    document.body.innerHTML = '<div class="video-item"><button class="video-btn-clip"></button><div class="clip-editor-slot"></div></div>';
    await toggleDetectedClipEditor(document.querySelector("button")!, {
      url: "https://different.test/master.m3u8",
      format: VideoFormat.HLS,
      pageUrl: "https://page.test",
    });
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLSelectElement>(".clip-player-select")?.options).toHaveLength(2);
    });
    expect(document.querySelector<HTMLElement>(".clip-player-select")?.closest("label")?.hidden).toBe(false);
  });
});
