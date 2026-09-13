import { describe, expect, it } from "vitest";
import { normalizeVideoMetadataSource, VideoFormat } from "@/core/types";

describe("MediaSource normalization", () => {
  it("upgrades a legacy browser record without changing its transport", () => {
    const metadata = {
      url: "https://cdn.example.test/video.mp4",
      pageUrl: "https://example.test/watch",
      format: VideoFormat.DIRECT,
    };
    expect(normalizeVideoMetadataSource(metadata).source).toEqual({
      kind: "browser",
      mediaUrl: metadata.url,
      pageUrl: metadata.pageUrl,
      format: VideoFormat.DIRECT,
    });
  });

  it("preserves an explicit backend descriptor", () => {
    const metadata = {
      url: "https://cdn.example.test/video.mp4", pageUrl: "https://example.test/watch",
      format: VideoFormat.DIRECT,
      source: { kind: "browser" as const, mediaUrl: "https://cdn.example.test/video.mp4", pageUrl: "https://example.test/watch", format: VideoFormat.DIRECT },
    };
    expect(normalizeVideoMetadataSource(metadata)).toBe(metadata);
  });
});
