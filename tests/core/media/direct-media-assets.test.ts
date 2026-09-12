import { describe, expect, it } from "vitest";
import {
  applyBestDirectMediaAsset,
  mergeDirectMediaAssets,
  selectBestDirectMediaAsset,
} from "@/core/media/direct-media-assets";
import { VideoFormat, type VideoMetadata } from "@/core/types";

function metadata(): VideoMetadata {
  return {
    url: "https://cdn.test/clip-mobile.m4s",
    format: VideoFormat.DIRECT,
    pageUrl: "https://page.test/feed",
    fileExtension: "mp4",
    isSelfContainedFmp4: true,
    mediaAssets: [
      {
        url: "https://cdn.test/clip-mobile.m4s",
        kind: "self-contained-fmp4",
        width: 640,
        height: 360,
        contentLength: 100,
      },
      {
        url: "https://cdn.test/clip-full.m4s",
        kind: "self-contained-fmp4",
        width: 1920,
        height: 1080,
        contentLength: 500,
      },
    ],
  };
}

describe("direct media asset selection", () => {
  it("selects the highest-resolution complete variant", () => {
    expect(selectBestDirectMediaAsset(metadata()).url)
      .toBe("https://cdn.test/clip-full.m4s");
  });

  it("prefers a larger progressive candidate when quality is otherwise equal", () => {
    const value = metadata();
    value.mediaAssets = [
      {
        url: "https://cdn.test/clip.m4s",
        kind: "self-contained-fmp4",
        height: 720,
        contentLength: 200,
      },
      {
        url: "https://cdn.test/clip.mp4",
        kind: "progressive",
        height: 720,
        contentLength: 300,
      },
    ];
    value.url = value.mediaAssets[0]!.url;
    expect(applyBestDirectMediaAsset(value, value.mediaAssets)).toMatchObject({
      url: "https://cdn.test/clip.mp4",
      isSelfContainedFmp4: false,
    });
  });

  it("does not erase known quality data when merging a sparse refresh", () => {
    expect(mergeDirectMediaAssets(
      [{
        url: "https://cdn.test/clip.m4s?token=a",
        kind: "self-contained-fmp4",
        width: 1920,
        height: 1080,
      }],
      [{
        url: "https://cdn.test/clip.m4s?token=a",
        kind: "self-contained-fmp4",
        observedAt: 2,
      }],
    )[0]).toMatchObject({ width: 1920, height: 1080, observedAt: 2 });
  });
});
