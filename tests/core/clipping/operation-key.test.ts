import { describe, expect, it } from "vitest";
import { createOperationKey } from "@/core/clipping/operation-key";
import type { ClipSpec } from "@/core/clipping/types";

const clip: ClipSpec = {
  startMs: 1_000,
  endMs: 2_000,
  mode: "fast",
  markSource: "manual",
};

describe("operation key", () => {
  it("is stable for equivalent requests and ignores mark provenance", () => {
    const first = createOperationKey({
      url: "HTTPS://Example.com:443/video.mp4#player",
      kind: "clip",
      clip,
      quality: {
        selectedBandwidth: 1_000_000,
        qualityKey: "1080p",
      },
      outputContainer: ".MP4",
      pageUrl: "https://site.test/watch#fragment",
    });
    const second = createOperationKey({
      pageUrl: "https://site.test/watch",
      outputContainer: "mp4",
      quality: {
        qualityKey: "1080p",
        selectedBandwidth: 1_000_000,
      },
      clip: { ...clip, markSource: "playback" },
      kind: "clip",
      url: "https://example.com/video.mp4",
    });
    expect(first).toBe(second);
  });

  it.each([
    [{ clip: { ...clip, endMs: 2_001 } }, "range"],
    [{ clip: { ...clip, mode: "exact" as const } }, "mode"],
    [{ quality: "720p" }, "quality"],
    [{ outputContainer: "webm" }, "container"],
    [{ pageUrl: "https://other.test/watch" }, "page context"],
    [{ referrer: "https://site.test/other" }, "referrer"],
    [{ url: "https://example.com/video.mp4?token=other" }, "signed URL query"],
    [{ kind: "download" as const, clip: undefined }, "operation kind"],
  ])("changes when $1 changes", (changes) => {
    const baseline = createOperationKey({
      url: "https://example.com/video.mp4?token=one",
      kind: "clip",
      clip,
      outputContainer: "mp4",
      pageUrl: "https://site.test/watch",
    });
    const changed = createOperationKey({
      url: "https://example.com/video.mp4?token=one",
      kind: "clip",
      clip,
      outputContainer: "mp4",
      pageUrl: "https://site.test/watch",
      ...changes,
    });
    expect(changed).not.toBe(baseline);
  });

  it("requires clip data for clip operations", () => {
    expect(() =>
      createOperationKey({ url: "https://example.com/v.mp4", kind: "clip" }),
    ).toThrow();
  });

  it("rejects invalid clip boundaries", () => {
    expect(() =>
      createOperationKey({
        url: "https://example.com/v.mp4",
        kind: "clip",
        clip: { ...clip, endMs: clip.startMs },
      }),
    ).toThrow();
  });

  it("normalizes complete rendition identity", () => {
    const key = createOperationKey({
      url: "not a URL#player",
      kind: "clip",
      clip,
      mode: "exact",
      quality: {
        videoPlaylistUrl: "https://cdn.test/video.m3u8#x",
        audioPlaylistUrl: null,
        representationId: "video-1",
        label: "1080p",
      },
      referrer: "also not a URL#fragment",
    });
    expect(key).toContain("not a URL");
    expect(key).not.toContain("player");
    expect(key).toContain("representationId");
    expect(key).toContain("audioPlaylistUrl");
    expect(key).toContain("exact");
  });

  it("omits empty optional quality and rejects an empty URL", () => {
    const one = createOperationKey({
      url: "https://example.com/v.mp4",
      kind: "download",
      quality: "   ",
    });
    const two = createOperationKey({
      url: "https://example.com/v.mp4",
      kind: "download",
      quality: {},
    });
    expect(one).toBe(two);
    expect(() => createOperationKey({ url: "", kind: "download" })).toThrow(
      TypeError,
    );
  });
});
