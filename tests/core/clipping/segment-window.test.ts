import { describe, expect, it } from "vitest";
import {
  mapSegmentsToDenseStorage,
  selectIndependentTrackWindows,
  selectSegmentWindow,
} from "@/core/clipping/segment-window";
import type { TimedMediaSegment } from "@/core/clipping/types";

function segment(
  sourceIndex: number,
  startMs: number,
  endMs: number,
  discontinuitySequence = 0,
): TimedMediaSegment {
  return {
    sourceIndex,
    sequenceNumber: 100 + sourceIndex,
    uri: `https://cdn.example/segment-${sourceIndex}.ts`,
    startMs,
    durationMs: endMs - startMs,
    endMs,
    discontinuitySequence,
  };
}

describe("selectSegmentWindow", () => {
  const constant = [
    segment(0, 0, 4_000),
    segment(1, 4_000, 8_000),
    segment(2, 8_000, 12_000),
  ];

  it("selects mathematical overlaps for a clip within one segment", () => {
    const selection = selectSegmentWindow(constant, 4_500, 7_500, "fast");

    expect(selection?.mediaSegments.map((item) => item.sourceIndex)).toEqual([1]);
    expect(selection).toMatchObject({
      requestedStartMs: 4_500,
      requestedEndMs: 7_500,
      mediaWindowStartMs: 4_000,
      mediaWindowEndMs: 8_000,
      relativeStartMs: 500,
      targetDurationMs: 3_000,
      leftDecodePaddingSegments: 0,
    });
  });

  it("honors half-open boundaries exactly", () => {
    expect(
      selectSegmentWindow(constant, 4_000, 8_000)?.mediaSegments.map(
        (item) => item.sourceIndex,
      ),
    ).toEqual([1]);
  });

  it("supports start zero and an end at source duration", () => {
    expect(
      selectSegmentWindow(constant, 0, 12_000)?.mediaSegments.map(
        (item) => item.sourceIndex,
      ),
    ).toEqual([0, 1, 2]);
  });

  it("adds one exact-mode left dependency segment", () => {
    const selection = selectSegmentWindow(constant, 8_500, 10_000, "exact");

    expect(selection?.mediaSegments.map((item) => item.sourceIndex)).toEqual([1, 2]);
    expect(selection).toMatchObject({
      mediaWindowStartMs: 4_000,
      relativeStartMs: 4_500,
      leftDecodePaddingSegments: 1,
    });
  });

  it("does not pad exact mode across a discontinuity", () => {
    const discontinuous = [
      segment(9, 0, 4_000, 5),
      segment(10, 4_000, 8_000, 6),
    ];

    const selection = selectSegmentWindow(
      discontinuous,
      4_500,
      7_000,
      "exact",
    );

    expect(selection?.mediaSegments.map((item) => item.sourceIndex)).toEqual([10]);
    expect(selection?.leftDecodePaddingSegments).toBe(0);
  });

  it("returns null when the track does not overlap", () => {
    expect(selectSegmentWindow(constant, 20_000, 21_000)).toBeNull();
  });

  it("rejects invalid windows", () => {
    expect(() => selectSegmentWindow(constant, 1_000, 1_000)).toThrow(
      RangeError,
    );
    expect(() => selectSegmentWindow(constant, Number.NaN, 1_000)).toThrow(
      RangeError,
    );
  });
});

describe("track planning and dense storage", () => {
  it("selects audio and video independently", () => {
    const video = [segment(20, 0, 5_000), segment(21, 5_000, 10_000)];
    const audio = [
      segment(40, 0, 3_000),
      segment(41, 3_000, 6_000),
      segment(42, 6_000, 9_000),
    ];

    const selection = selectIndependentTrackWindows(
      video,
      audio,
      4_000,
      7_000,
    );

    expect(selection.video?.mediaSegments.map((item) => item.sourceIndex)).toEqual([
      20,
      21,
    ]);
    expect(selection.audio?.mediaSegments.map((item) => item.sourceIndex)).toEqual([
      41,
      42,
    ]);
    expect(selection.video?.relativeStartMs).toBe(4_000);
    expect(selection.audio?.relativeStartMs).toBe(1_000);
  });

  it("assigns dense storage indices without renumbering source metadata", () => {
    const selected = [segment(37, 12_000, 16_000), segment(38, 16_000, 20_000)];

    const dense = mapSegmentsToDenseStorage(selected);

    expect(dense.map((item) => item.storageIndex)).toEqual([0, 1]);
    expect(dense.map((item) => item.segment.sourceIndex)).toEqual([37, 38]);
    expect(dense.map((item) => item.segment.sequenceNumber)).toEqual([137, 138]);
  });

  it("deduplicates identical initialization ranges in source order", () => {
    const init = {
      uri: "https://cdn.example/main.mp4",
      byteRange: { offset: 0, length: 720 },
    };
    const withInit = [
      { ...segment(0, 0, 4_000), init },
      { ...segment(1, 4_000, 8_000), init },
    ];

    const selection = selectSegmentWindow(withInit, 0, 8_000);

    expect(selection?.initSegments).toEqual([init]);
  });
});
