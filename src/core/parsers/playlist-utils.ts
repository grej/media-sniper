import { Fragment } from "../types";
import type { TimedMediaSegment } from "../clipping/types";

export interface ParsedSegment {
  uri: string;
  initUri?: string; // EXT-X-MAP (HLS) or segment.map.resolvedUri (DASH)
  initByteRange?: string; // "offset:length" — HLS only
  key?: { iv: string | null; uri: string | null }; // HLS only
}

export interface ParsedPlaylist {
  segments: ParsedSegment[];
}

/**
 * Rich media-playlist segment. The legacy fields remain present so existing
 * full-download and recording consumers can continue through
 * `parseLevelsPlaylist()` unchanged.
 */
export interface TimedParsedSegment extends ParsedSegment, TimedMediaSegment {}

export interface TimedParsedPlaylist extends ParsedPlaylist {
  segments: TimedParsedSegment[];
  mediaSequence: number;
  discontinuitySequence: number;
  durationMs: number;
  endList: boolean;
}

/**
 * Convert a ParsedPlaylist into a Fragment[] with sequential indices.
 *
 * Handles init segments (EXT-X-MAP for HLS, segment.map for DASH): inserts
 * each distinct init URI as a Fragment before the first media segment that
 * references it. Deduplicates by URI+byteRange so a shared init is only
 * downloaded once per run.
 *
 * `startIndex` allows audio fragments to continue numbering from where
 * video fragments left off (used by HLS/DASH dual-stream downloads).
 */
export function parseLevelsPlaylist(
  playlist: ParsedPlaylist,
  startIndex: number = 0,
): Fragment[] {
  const fragments: Fragment[] = [];
  let index = startIndex;
  let currentInitUri: string | null = null;
  let currentInitByteRange: string | null = null;

  for (const segment of playlist.segments) {
    if (segment.initUri) {
      const byteRange = segment.initByteRange ?? null;
      if (segment.initUri !== currentInitUri || byteRange !== currentInitByteRange) {
        fragments.push({
          index,
          key: segment.key ?? { iv: null, uri: null },
          uri: segment.initUri,
        });
        index++;
        currentInitUri = segment.initUri;
        currentInitByteRange = byteRange;
      }
    }
    fragments.push({
      index,
      key: segment.key ?? { iv: null, uri: null },
      uri: segment.uri,
    });
    index++;
  }

  return fragments;
}
