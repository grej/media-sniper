import { describe, expect, it } from "vitest";
import { buildFastSegmentedClipArgs } from "@/core/ffmpeg/fast-segmented-args";

describe("buildFastSegmentedClipArgs", () => {
  it("places combined-input seek after input and normalizes timestamps", () => {
    expect(
      buildFastSegmentedClipArgs({
        input: {
          kind: "combined",
          inputFile: "combined.ts",
          relativeStartMs: 1250,
        },
        mediaFormat: "hls-ts",
        durationMs: 4000,
        outputFile: "clip.mp4",
      }),
    ).toEqual([
      "-y", "-i", "combined.ts", "-ss", "1.250", "-t", "4.000",
      "-map", "0:v?", "-map", "0:a?", "-c", "copy",
      "-bsf:a", "aac_adtstoasc",
      "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", "clip.mp4",
    ]);
  });

  it("places separate-track seeks before their respective inputs", () => {
    expect(
      buildFastSegmentedClipArgs({
        input: {
          kind: "separate",
          videoFile: "video.mp4",
          audioFile: "audio.mp4",
          videoRelativeStartMs: 500,
          audioRelativeStartMs: 750,
        },
        mediaFormat: "dash-fmp4",
        durationMs: 2025,
        outputFile: "clip.mp4",
      }),
    ).toEqual([
      "-y", "-ss", "0.500", "-i", "video.mp4",
      "-ss", "0.750", "-i", "audio.mp4", "-t", "2.025",
      "-map", "0:v:0", "-map", "1:a:0", "-c", "copy",
      "-avoid_negative_ts", "make_zero", "-shortest",
      "-movflags", "+faststart", "clip.mp4",
    ]);
  });

  it("rejects invalid duration and seek values", () => {
    expect(() =>
      buildFastSegmentedClipArgs({
        input: { kind: "combined", inputFile: "in", relativeStartMs: -1 },
        mediaFormat: "hls-fmp4",
        durationMs: 100,
        outputFile: "out",
      }),
    ).toThrow("Invalid FFmpeg timestamp");
    expect(() =>
      buildFastSegmentedClipArgs({
        input: { kind: "combined", inputFile: "in", relativeStartMs: 0 },
        mediaFormat: "hls-fmp4",
        durationMs: 0,
        outputFile: "out",
      }),
    ).toThrow("Invalid clip duration");
    expect(() =>
      buildFastSegmentedClipArgs({
        input: { kind: "combined", inputFile: "in", relativeStartMs: 0 },
        mediaFormat: "unknown" as "hls-ts",
        durationMs: 100,
        outputFile: "out",
      }),
    ).toThrow("Unsupported segmented media format");
  });
});
