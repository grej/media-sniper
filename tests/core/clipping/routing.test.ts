import { describe, expect, it } from "vitest";
import { selectClipHandlerKind } from "@/core/clipping/routing";
import type { ClipRequest } from "@/core/clipping/types";
import { VideoFormat } from "@/core/types";

const clip = {
  startMs: 1_000,
  endMs: 2_000,
  mode: "exact" as const,
  markSource: "manual" as const,
};

describe("clip routing", () => {
  it.each([
    [VideoFormat.HLS, "hls-segmented"],
    [VideoFormat.M3U8, "hls-segmented"],
    [VideoFormat.DASH, "dash-segmented"],
  ] as const)("routes Exact %s through its segmented handler", (format, expected) => {
    expect(selectClipHandlerKind({ format, clip })).toBe(expected);
  });

  it("retains direct routing and rejects unsupported formats", () => {
    expect(selectClipHandlerKind({ format: VideoFormat.DIRECT, clip })).toBe("direct");
    expect(selectClipHandlerKind({
      format: "unsupported" as ClipRequest["format"],
      clip,
    })).toBeNull();
  });
});
