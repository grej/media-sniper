import { describe, expect, it } from "vitest";
import { DownloadStage, VideoFormat, type DownloadState } from "@/core/types";
import { browserDownloadMatchesUrl } from "@/popup/utils";

function state(overrides: Partial<DownloadState>): DownloadState {
  return {
    id: "job",
    url: "https://page.test/watch",
    metadata: {
      url: "https://cdn.test/video.mp4",
      pageUrl: "https://page.test/watch",
      format: VideoFormat.DIRECT,
    },
    progress: { url: "https://cdn.test/video.mp4", stage: DownloadStage.COMPLETED },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("popup download routing", () => {
  it("matches browser downloads by their media URL", () => {
    expect(browserDownloadMatchesUrl(
      state({}),
      "https://cdn.test/video.mp4",
    )).toBe(true);
  });

  it("never treats yt-dlp page history as a browser media download", () => {
    const companion = state({
      metadata: {
        title: "Companion result",
        source: {
          kind: "yt-dlp",
          pageUrl: "https://x.com/example/status/1",
          extractorKey: "Twitter",
          mediaId: "1",
        },
      } as DownloadState["metadata"],
      operation: {
        backend: "yt-dlp",
        kind: "download",
        operationKey: "companion",
      },
    });

    expect(() => browserDownloadMatchesUrl(
      companion,
      "https://cdn.test/video.mp4",
    )).not.toThrow();
    expect(browserDownloadMatchesUrl(companion, "https://cdn.test/video.mp4")).toBe(false);
  });
});
