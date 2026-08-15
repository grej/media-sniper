import { describe, expect, it } from "vitest";
import { VideoFormat, DownloadStage, type DownloadState } from "@/core/types";
import { createHistoryRedownloadAction } from "@/options/history-redownload";
import { MessageType } from "@/shared/messages";

function historyState(
  operation?: DownloadState["operation"],
  overrides: Partial<DownloadState> = {},
): DownloadState {
  return {
    id: "history-operation",
    url: "https://cdn.example/master.m3u8",
    metadata: {
      url: "https://cdn.example/master.m3u8",
      format: VideoFormat.HLS,
      title: "Example video",
      pageUrl: "https://www.example.com/watch",
    },
    progress: {
      url: "https://cdn.example/master.m3u8",
      stage: DownloadStage.COMPLETED,
    },
    operation,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("history re-download actions", () => {
  it("replays the persisted clip range, mode, quality, and direct consent", () => {
    const state = historyState({
      kind: "clip",
      operationKey: "clip-key",
      clip: {
        startMs: 62_125,
        endMs: 65_500,
        mode: "exact",
        markSource: "playback",
      },
      manifestQuality: {
        qualityKey: "1080p",
        videoPlaylistUrl: "https://cdn.example/video-1080.m3u8",
        audioPlaylistUrl: "https://cdn.example/audio-en.m3u8",
        selectedBandwidth: 5_000_000,
        label: "1080p + English",
      },
      allowFullFetchForDirect: true,
      outputContainer: "mp4",
    });

    const action = createHistoryRedownloadAction(state);

    expect(action.queuedMessage).toBe("Clip queued");
    expect(action.message).toEqual({
      type: MessageType.CLIP_REQUEST,
      payload: {
        url: state.url,
        format: VideoFormat.HLS,
        clip: {
          startMs: 62_125,
          endMs: 65_500,
          mode: "exact",
          markSource: "playback",
        },
        metadata: state.metadata,
        pageUrl: "https://www.example.com/watch",
        manifestQuality: {
          qualityKey: "1080p",
          videoPlaylistUrl: "https://cdn.example/video-1080.m3u8",
          audioPlaylistUrl: "https://cdn.example/audio-en.m3u8",
          selectedBandwidth: 5_000_000,
          label: "1080p + English",
        },
        allowFullFetchForDirect: true,
        outputContainer: "mp4",
      },
    });
  });

  it("uses the legacy full-download request for non-clip history rows", () => {
    const state = historyState({
      kind: "download",
      operationKey: "download-key",
    });

    expect(createHistoryRedownloadAction(state)).toEqual({
      message: {
        type: MessageType.DOWNLOAD_REQUEST,
        payload: {
          url: state.url,
          metadata: state.metadata,
          tabTitle: "Example video",
          website: "example.com",
        },
      },
      queuedMessage: "Download queued",
    });
  });

  it("retains recording behavior for legacy live rows", () => {
    const state = historyState(undefined, {
      metadata: {
        url: "https://cdn.example/live.m3u8",
        format: VideoFormat.HLS,
        pageUrl: "https://example.com/live",
        isLive: true,
      },
    });

    const action = createHistoryRedownloadAction(state);
    expect(action.message.type).toBe(MessageType.START_RECORDING);
    expect(action.queuedMessage).toBe("Recording started");
  });
});
