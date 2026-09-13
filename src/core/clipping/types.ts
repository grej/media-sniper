import type { VideoFormat, VideoMetadata } from "../types";

/** Clip boundaries and all persisted clipping times are integer milliseconds. */
export type ClipMode = "fast" | "exact";

export type ClipMarkSource = "manual" | "playback" | "overlay";

export type ClipOutputContainer = "mp4";

export interface ClipSpec {
  startMs: number;
  endMs: number;
  mode: ClipMode;
  markSource: ClipMarkSource;
}

/**
 * Format-neutral quality selection. Fields that do not apply to a source are
 * omitted, while `qualityKey` provides a stable identity for future formats.
 */
export interface ManifestQualitySelection {
  qualityKey?: string;
  videoPlaylistUrl?: string | null;
  audioPlaylistUrl?: string | null;
  selectedBandwidth?: number;
  representationId?: string;
  label?: string;
}

export interface ClipRequest {
  url: string;
  format: VideoFormat;
  clip: ClipSpec;
  metadata: VideoMetadata;
  filename?: string;
  pageUrl?: string;
  tabId?: number;
  pageVideoId?: string;
  frameId?: number;
  manifestQuality?: ManifestQualitySelection;
  allowFullFetchForDirect?: boolean;
  outputContainer?: ClipOutputContainer;
}

export type MediaOperationKind = "download" | "clip" | "record";

export interface MediaOperation {
  kind: MediaOperationKind;
  operationKey: string;
  clip?: ClipSpec;
  requestedDurationMs?: number;
  actualDurationMs?: number;
  accuracy?: "keyframe-aligned" | "exact";
  qualityKey?: string;
  manifestQuality?: ManifestQualitySelection;
  allowFullFetchForDirect?: boolean;
  outputContainer?: ClipOutputContainer;
}

export interface OperationKeyInput {
  url: string;
  kind: MediaOperationKind;
  clip?: ClipSpec;
  mode?: ClipMode;
  quality?: string | ManifestQualitySelection;
  outputContainer?: string;
  pageUrl?: string;
  referrer?: string;
  backend?: "browser" | "yt-dlp";
}

/** A byte range expressed as an offset and byte count. */
export interface ByteRangeSpec {
  offset: number;
  length: number;
}

/** HLS AES-128 metadata retained from the source manifest. */
export interface EncryptionSpec {
  method: "AES-128";
  keyUri: string;
  explicitIv?: Uint8Array;
  /** Original HLS media sequence number, used for implicit IV derivation. */
  sequenceNumber: number;
}

export interface MediaInitializationSegment {
  uri: string;
  byteRange?: ByteRangeSpec;
}

/**
 * Format-neutral media segment with absolute presentation timing.
 *
 * `sourceIndex` and `sequenceNumber` deliberately remain independent of the
 * dense storage index assigned after a clip window has been selected.
 */
export interface TimedMediaSegment {
  sourceIndex: number;
  sequenceNumber?: number;
  uri: string;
  startMs: number;
  durationMs: number;
  endMs: number;
  byteRange?: ByteRangeSpec;
  init?: MediaInitializationSegment;
  encryption?: EncryptionSpec;
  discontinuitySequence?: number;
}

export interface DenseStorageSegment {
  storageIndex: number;
  segment: TimedMediaSegment;
}

export interface TrackClipSelection {
  requestedStartMs: number;
  requestedEndMs: number;
  mediaWindowStartMs: number;
  mediaWindowEndMs: number;
  relativeStartMs: number;
  targetDurationMs: number;
  initSegments: MediaInitializationSegment[];
  mediaSegments: TimedMediaSegment[];
  denseMediaSegments: DenseStorageSegment[];
  leftDecodePaddingSegments: number;
}

export interface IndependentTrackClipSelection {
  video: TrackClipSelection | null;
  audio: TrackClipSelection | null;
}

export type DashTrackKind = "video" | "audio";

/** DASH segment metadata retained in addition to the shared timed model. */
export interface TimedDashMediaSegment extends TimedMediaSegment {
  timeline: number;
  periodStartMs: number;
  /** Stable identity derived from the Period presentation start. */
  periodKey: string;
}

export interface TimedDashTrack {
  kind: DashTrackKind;
  representationId: string;
  bandwidth?: number;
  codecs?: string;
  width?: number;
  height?: number;
  language?: string;
  timelineStartsMs: number[];
  segments: TimedDashMediaSegment[];
}

export interface TimedDashTracks {
  durationMs?: number;
  video: TimedDashTrack;
  audio: TimedDashTrack | null;
}
