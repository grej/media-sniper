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
}
