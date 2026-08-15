import type {
  ClipMode,
  DenseStorageSegment,
  IndependentTrackClipSelection,
  MediaInitializationSegment,
  TimedMediaSegment,
  TrackClipSelection,
} from "./types";

function validateWindow(startMs: number, endMs: number): void {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new RangeError("Clip boundaries must be finite numbers");
  }
  if (startMs < 0 || endMs <= startMs) {
    throw new RangeError("Clip window must satisfy 0 <= startMs < endMs");
  }
}

function initKey(init: MediaInitializationSegment): string {
  const range = init.byteRange;
  return range
    ? `${init.uri}\u0000${range.offset}:${range.length}`
    : `${init.uri}\u0000`;
}

function collectInitSegments(
  segments: readonly TimedMediaSegment[],
): MediaInitializationSegment[] {
  const seen = new Set<string>();
  const result: MediaInitializationSegment[] = [];

  for (const segment of segments) {
    if (!segment.init) continue;
    const key = initKey(segment.init);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(segment.init);
  }

  return result;
}

/** Assign dense physical storage positions without altering source identity. */
export function mapSegmentsToDenseStorage(
  segments: readonly TimedMediaSegment[],
): DenseStorageSegment[] {
  return segments.map((segment, storageIndex) => ({ storageIndex, segment }));
}

/**
 * Select all segments overlapping the half-open interval `[startMs, endMs)`.
 * Exact mode prepends at most one decoder-dependency segment and never crosses
 * a discontinuity boundary. `null` means the track has no overlapping media.
 */
export function selectSegmentWindow(
  segments: readonly TimedMediaSegment[],
  startMs: number,
  endMs: number,
  mode: ClipMode = "fast",
): TrackClipSelection | null {
  validateWindow(startMs, endMs);

  const firstOverlapIndex = segments.findIndex(
    (segment) => segment.startMs < endMs && segment.endMs > startMs,
  );
  if (firstOverlapIndex < 0) return null;

  let lastOverlapIndex = firstOverlapIndex;
  while (
    lastOverlapIndex + 1 < segments.length &&
    segments[lastOverlapIndex + 1]!.startMs < endMs &&
    segments[lastOverlapIndex + 1]!.endMs > startMs
  ) {
    lastOverlapIndex += 1;
  }

  let selectedStartIndex = firstOverlapIndex;
  let leftDecodePaddingSegments = 0;

  if (mode === "exact" && firstOverlapIndex > 0) {
    const first = segments[firstOverlapIndex]!;
    const prior = segments[firstOverlapIndex - 1]!;
    const sameContinuity =
      (prior.discontinuitySequence ?? 0) ===
      (first.discontinuitySequence ?? 0);
    if (sameContinuity) {
      selectedStartIndex -= 1;
      leftDecodePaddingSegments = 1;
    }
  }

  const mediaSegments = segments.slice(selectedStartIndex, lastOverlapIndex + 1);
  const first = mediaSegments[0]!;
  const last = mediaSegments[mediaSegments.length - 1]!;

  return {
    requestedStartMs: startMs,
    requestedEndMs: endMs,
    mediaWindowStartMs: first.startMs,
    mediaWindowEndMs: last.endMs,
    relativeStartMs: startMs - first.startMs,
    targetDurationMs: endMs - startMs,
    initSegments: collectInitSegments(mediaSegments),
    mediaSegments,
    denseMediaSegments: mapSegmentsToDenseStorage(mediaSegments),
    leftDecodePaddingSegments,
  };
}

/** Plan video and audio against their own, potentially different timelines. */
export function selectIndependentTrackWindows(
  videoSegments: readonly TimedMediaSegment[] | null | undefined,
  audioSegments: readonly TimedMediaSegment[] | null | undefined,
  startMs: number,
  endMs: number,
  mode: ClipMode = "fast",
): IndependentTrackClipSelection {
  validateWindow(startMs, endMs);
  return {
    video: videoSegments
      ? selectSegmentWindow(videoSegments, startMs, endMs, mode)
      : null,
    audio: audioSegments
      ? selectSegmentWindow(audioSegments, startMs, endMs, mode)
      : null,
  };
}
