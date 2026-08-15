import { describe, expect, it } from "vitest";
import { VideoFormat, type VideoMetadata } from "../../src/core/types";
import { upsertDetectedVideo } from "../../src/popup/detected-videos";

function video(overrides: Partial<VideoMetadata> = {}): VideoMetadata {
  return {
    url: "https://cdn.test/video.mp4",
    format: VideoFormat.DIRECT,
    pageUrl: "https://page.test/watch",
    ...overrides,
  };
}

describe("popup detected video ingestion", () => {
  it("merges an earlier DOM URL into later redirect evidence", () => {
    const entryUrl = "https://cdn.test/video.mp4?v-acctoken=secret";
    const finalUrl = "https://cdn.test/remote_control.php?file=opaque";
    const videos: Record<string, VideoMetadata> = {
      [entryUrl]: video({ url: entryUrl, title: "DOM title" }),
    };

    upsertDetectedVideo(videos, video({
      url: finalUrl,
      sourceUrl: entryUrl,
      redirectChain: [entryUrl, finalUrl],
      sourceKey: "direct:https://cdn.test/video.mp4",
      observedAt: 100,
    }));

    expect(Object.keys(videos)).toEqual([finalUrl]);
    expect(videos[finalUrl]).toMatchObject({
      title: "DOM title",
      sourceKey: "direct:https://cdn.test/video.mp4",
    });
  });

  it("moves a source-keyed entry to a newer actionable URL and preserves metadata", () => {
    const videos: Record<string, VideoMetadata> = {};
    const oldUrl = "https://cdn.test/video.mp4?token=old";
    const refreshedUrl = "https://edge.test/final.mp4?token=fresh";

    upsertDetectedVideo(videos, video({
      url: oldUrl,
      sourceKey: "direct:https://origin.test/video.mp4",
      observedAt: 100,
      title: "Descriptive title",
      thumbnail: "https://page.test/poster.jpg",
      width: 1920,
      height: 1080,
    }));
    upsertDetectedVideo(videos, video({
      url: refreshedUrl,
      sourceKey: "direct:https://origin.test/video.mp4",
      sourceUrl: "https://origin.test/video.mp4",
      redirectChain: ["https://origin.test/video.mp4", refreshedUrl],
      observedAt: 200,
    }));

    expect(Object.keys(videos)).toEqual([refreshedUrl]);
    expect(videos[refreshedUrl]).toMatchObject({
      url: refreshedUrl,
      title: "Descriptive title",
      thumbnail: "https://page.test/poster.jpg",
      width: 1920,
      height: 1080,
      observedAt: 200,
    });
  });

  it("does not let an older source observation restore a stale URL", () => {
    const videos: Record<string, VideoMetadata> = {};
    const currentUrl = "https://cdn.test/video.mp4?token=current";

    upsertDetectedVideo(videos, video({
      url: currentUrl,
      sourceKey: "stable-source",
      observedAt: 200,
    }));
    upsertDetectedVideo(videos, video({
      url: "https://cdn.test/video.mp4?token=stale",
      sourceKey: "stable-source",
      observedAt: 100,
      title: "Metadata from another frame",
    }));

    expect(Object.keys(videos)).toEqual([currentUrl]);
    expect(videos[currentUrl].title).toBe("Metadata from another frame");
  });

  it("keeps URL-only observations as separate normalized entries", () => {
    const videos: Record<string, VideoMetadata> = {};
    upsertDetectedVideo(videos, video({
      url: "https://cdn.test/video.mp4?token=one#fragment",
      title: "First",
    }));
    upsertDetectedVideo(videos, video({
      url: "https://cdn.test/video.mp4?token=two",
      thumbnail: "https://page.test/poster.jpg",
    }));

    expect(Object.keys(videos)).toHaveLength(2);
  });
});
