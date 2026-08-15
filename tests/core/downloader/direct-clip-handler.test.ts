import { describe, expect, it, vi } from "vitest";
import { DirectClipHandler } from "../../../src/core/downloader/direct/direct-clip-handler";
import { VideoFormat } from "../../../src/core/types";
import type { AppSettings } from "../../../src/core/storage/settings";

const settings = {
  ffmpegTimeout: 10_000,
  clipping: {
    maxClipDurationMs: 60_000,
    maxInMemoryClipBytes: 1_000_000,
    directNoRangeMaxBytes: 100_000,
    mediabunnyCacheBytes: 64_000,
    mediabunnyParallelism: 2,
    overlayEnabled: false,
    defaultMode: "fast",
  },
  advanced: {
    maxRetries: 3,
    retryDelayMs: 100,
    retryBackoffFactor: 1.2,
  },
} as AppSettings;

const request = {
  url: "https://cdn.test/video.mp4",
  format: VideoFormat.DIRECT,
  clip: { startMs: 5_000, endMs: 12_000, mode: "exact", markSource: "manual" },
  metadata: {
    url: "https://cdn.test/video.mp4",
    format: VideoFormat.DIRECT,
    title: "Example / clip",
    duration: 20,
    pageUrl: "https://page.test/watch",
  },
} as const;

describe("DirectClipHandler", () => {
  it("preflights, processes Exact, saves, reports progress, and tears down context", async () => {
    const teardown = vi.fn();
    const preflight = vi.fn().mockResolvedValue({
      capability: "range-supported",
      status: 206,
      contentLength: 500_000,
    });
    const process = vi.fn().mockImplementation(async (job) => {
      job.onProgress(0.5, 8_000, "Encoding exact clip");
      return { blobUrl: "blob:test", size: 50_000, accuracy: "exact" };
    });
    const save = vi.fn().mockResolvedValue("/Downloads/example.mp4");
    const progress = vi.fn();
    const handler = new DirectClipHandler({
      preflight,
      process,
      save,
      setupRequestContext: vi.fn().mockResolvedValue(teardown),
    });

    const result = await handler.clip(request, "operation-1", settings, new AbortController().signal, progress);
    expect(process).toHaveBeenCalledWith(expect.objectContaining({
      exact: true,
      startMs: 5_000,
      endMs: 12_000,
      fullFetch: false,
      maxOutputBytes: 1_000_000,
    }));
    expect(save).toHaveBeenCalledWith("blob:test", "Example_clip_00m05s-00m12s.mp4", "operation-1");
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ percentage: 50 }));
    expect(teardown).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      filePath: "/Downloads/example.mp4",
      accuracy: "exact",
      requestedDurationMs: 7_000,
    });
  });

  it("uses the consented full-fetch path for a small sequential source", async () => {
    const process = vi.fn().mockResolvedValue({ blobUrl: "blob:test", size: 1, accuracy: "keyframe-aligned" });
    const handler = new DirectClipHandler({
      preflight: vi.fn().mockResolvedValue({ capability: "small-sequential", status: 200, contentLength: 10 }),
      process,
      save: vi.fn().mockResolvedValue("saved.mp4"),
      setupRequestContext: vi.fn().mockResolvedValue(undefined),
    });
    await handler.clip({ ...request, allowFullFetchForDirect: true, clip: { ...request.clip, mode: "fast" } }, "op", settings, new AbortController().signal);
    expect(process).toHaveBeenCalledWith(expect.objectContaining({ fullFetch: true, maxFullFetchBytes: 100_000 }));
  });

  it("tears down request context after a refusal", async () => {
    const teardown = vi.fn();
    const process = vi.fn();
    const handler = new DirectClipHandler({
      preflight: vi.fn().mockResolvedValue({ capability: "large-or-unknown-sequential", status: 200 }),
      process,
      setupRequestContext: vi.fn().mockResolvedValue(teardown),
    });
    await expect(handler.clip(request, "op", settings, new AbortController().signal)).rejects.toThrow(/too large|unknown/i);
    expect(process).not.toHaveBeenCalled();
    expect(teardown).toHaveBeenCalledOnce();
  });
});
