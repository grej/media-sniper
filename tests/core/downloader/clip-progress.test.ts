import { describe, expect, it, vi } from "vitest";
import { ClipProgressTracker } from "../../../src/core/downloader/clip-progress";
import { DownloadStage, VideoFormat, type DownloadState } from "../../../src/core/types";

function state(): DownloadState {
  return {
    id: "clip-1",
    url: "https://cdn.test/video.mp4",
    metadata: { url: "https://cdn.test/video.mp4", format: VideoFormat.DIRECT, pageUrl: "https://page.test" },
    progress: { url: "https://cdn.test/video.mp4", stage: DownloadStage.PLANNING },
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("ClipProgressTracker", () => {
  it("notifies every update but throttles durable writes without DB reads", async () => {
    let now = 100;
    const store = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
    const tracker = new ClipProgressTracker({
      state: state(),
      syncIntervalMs: 1_000,
      store,
      notify,
      now: () => now,
    });
    tracker.update({ stage: DownloadStage.DOWNLOADING, percentage: 10, downloaded: 100 });
    now = 200;
    tracker.update({ stage: DownloadStage.DOWNLOADING, percentage: 20, downloaded: 200 });
    now = 300;
    tracker.update({ stage: DownloadStage.DOWNLOADING, percentage: 30, downloaded: 300 });
    await Promise.resolve();
    await Promise.resolve();
    expect(notify).toHaveBeenCalledTimes(3);
    expect(store).toHaveBeenCalledTimes(1);
    expect(tracker.state.progress.downloaded).toBe(300);

    await tracker.flush();
    expect(store).toHaveBeenCalledTimes(2);
    expect(store.mock.calls[1]?.[0]).toBe(tracker.state);
  });
});
