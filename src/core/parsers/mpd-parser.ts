/**
 * MPD (MPEG-DASH) manifest parser utility
 *
 * Wraps the `mpd-parser` npm package and converts its output to the
 * project's Fragment[] and Level[] types. Mirrors the structure of m3u8-parser.ts.
 */

import { parse, MpdAudioGroup, MpdManifest, MpdPlaylist } from "mpd-parser";
import { v4 as uuidv4 } from "uuid";
import { Level, LevelType } from "../types";
import type { ParsedPlaylist, ParsedSegment } from "./playlist-utils";
import { parseLevelsPlaylist } from "./playlist-utils";
import { ClippingError } from "../clipping/errors";
import { selectIndependentTrackWindows } from "../clipping/segment-window";
import type {
  ByteRangeSpec,
  ClipMode,
  IndependentTrackClipSelection,
  TimedDashMediaSegment,
  TimedDashTrack,
  TimedDashTracks,
} from "../clipping/types";

// Re-export for callers that want the unified Fragment conversion.
export { parseLevelsPlaylist } from "./playlist-utils";

export type { MpdManifest } from "mpd-parser";

/**
 * Convert an mpd-parser MpdPlaylist into a ParsedPlaylist.
 */
function mpdPlaylistToParsedPlaylist(playlist: MpdPlaylist): ParsedPlaylist {
  const segments: ParsedSegment[] = (playlist.segments || []).map((segment) => ({
    uri: segment.resolvedUri || segment.uri,
    ...(segment.map ? { initUri: segment.map.resolvedUri || segment.map.uri } : {}),
  }));
  return { segments };
}

export interface DashTrackSelectionOptions {
  videoBandwidth?: number;
  videoRepresentationId?: string;
  audioRepresentationId?: string;
}

interface AudioPlaylistCandidate {
  playlist: MpdPlaylist;
  group: MpdAudioGroup;
}

const DASH_DYNAMIC_UNSUPPORTED = "DASH_DYNAMIC_UNSUPPORTED";
const DASH_MANIFEST_UNUSABLE = "DASH_MANIFEST_UNUSABLE";
const DASH_REPRESENTATION_UNAVAILABLE = "DASH_REPRESENTATION_UNAVAILABLE";
const DASH_TIMING_UNAVAILABLE = "DASH_TIMING_UNAVAILABLE";
const DASH_SIDX_UNAVAILABLE = "DASH_SIDX_UNAVAILABLE";
const DASH_INIT_UNAVAILABLE = "DASH_INIT_UNAVAILABLE";
const DASH_CLIP_WINDOW_UNAVAILABLE = "DASH_CLIP_WINDOW_UNAVAILABLE";

function noTimeline(detail: string, cause?: unknown): ClippingError {
  return new ClippingError("NO_TIMELINE", detail, { cause });
}

function safeByteRange(
  value: { offset: number | bigint; length: number | bigint } | undefined,
): ByteRangeSpec | undefined {
  if (!value) return undefined;
  const offset = Number(value.offset);
  const length = Number(value.length);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length <= 0
  ) {
    throw noTimeline(DASH_TIMING_UNAVAILABLE);
  }
  return { offset, length };
}

function representationId(
  playlist: MpdPlaylist,
  kind: "video" | "audio",
): string {
  const id = playlist.attributes?.NAME;
  if (typeof id === "string" && id.length > 0) return id;
  const bandwidth = playlist.attributes?.BANDWIDTH ?? 0;
  return `${kind}-${bandwidth}`;
}

function normalizeDashTrack(
  playlist: MpdPlaylist,
  kind: "video" | "audio",
  language?: string,
): TimedDashTrack {
  const sourceSegments = playlist.segments ?? [];
  if (sourceSegments.length === 0) {
    if (playlist.sidx) throw noTimeline(DASH_SIDX_UNAVAILABLE);
    throw noTimeline(DASH_TIMING_UNAVAILABLE);
  }

  let previousStartMs = -1;
  const segments: TimedDashMediaSegment[] = sourceSegments.map(
    (segment, sourceIndex) => {
      const presentationTime = segment.presentationTime;
      const duration = segment.duration;
      const timeline = segment.timeline ?? playlist.timeline;

      if (
        !Number.isFinite(presentationTime) ||
        !Number.isFinite(duration) ||
        duration <= 0 ||
        !Number.isFinite(timeline)
      ) {
        throw noTimeline(DASH_TIMING_UNAVAILABLE);
      }

      const startMs = Math.round(presentationTime! * 1000);
      const endMs = Math.round((presentationTime! + duration) * 1000);
      const periodStartMs = Math.round(timeline! * 1000);
      if (startMs < 0 || endMs <= startMs || startMs < previousStartMs) {
        throw noTimeline(DASH_TIMING_UNAVAILABLE);
      }
      previousStartMs = startMs;

      const initUri = segment.map?.resolvedUri || segment.map?.uri;
      if (!initUri) throw noTimeline(DASH_INIT_UNAVAILABLE);

      const byteRange = safeByteRange(segment.byterange);
      const initByteRange = safeByteRange(segment.map?.byterange);
      const sequenceNumber =
        typeof segment.number === "number" && Number.isSafeInteger(segment.number)
          ? segment.number
          : undefined;

      return {
        sourceIndex,
        ...(sequenceNumber !== undefined ? { sequenceNumber } : {}),
        uri: segment.resolvedUri || segment.uri,
        startMs,
        durationMs: endMs - startMs,
        endMs,
        ...(byteRange ? { byteRange } : {}),
        init: {
          uri: initUri,
          ...(initByteRange ? { byteRange: initByteRange } : {}),
        },
        discontinuitySequence: periodStartMs,
        timeline: timeline!,
        periodStartMs,
        periodKey: `dash-period-${periodStartMs}`,
      };
    },
  );

  const timelineStartsMs = (playlist.timelineStarts ?? []).map(({ start }) =>
    Math.round(start * 1000),
  );

  return {
    kind,
    representationId: representationId(playlist, kind),
    ...(playlist.attributes?.BANDWIDTH !== undefined
      ? { bandwidth: playlist.attributes.BANDWIDTH }
      : {}),
    ...(playlist.attributes?.CODECS
      ? { codecs: playlist.attributes.CODECS }
      : {}),
    ...(playlist.attributes?.RESOLUTION?.width !== undefined
      ? { width: playlist.attributes.RESOLUTION.width }
      : {}),
    ...(playlist.attributes?.RESOLUTION?.height !== undefined
      ? { height: playlist.attributes.RESOLUTION.height }
      : {}),
    ...(language ? { language } : {}),
    timelineStartsMs,
    segments,
  };
}

function selectVideoPlaylist(
  manifest: MpdManifest,
  selection: DashTrackSelectionOptions,
): MpdPlaylist {
  const playlists = [...(manifest.playlists ?? [])];
  let selected: MpdPlaylist | undefined;

  if (selection.videoRepresentationId) {
    selected = playlists.find(
      (playlist) =>
        representationId(playlist, "video") === selection.videoRepresentationId,
    );
  } else if (selection.videoBandwidth !== undefined) {
    selected = playlists.find(
      (playlist) => playlist.attributes?.BANDWIDTH === selection.videoBandwidth,
    );
  } else {
    selected = playlists.sort(
      (left, right) =>
        (right.attributes?.BANDWIDTH ?? 0) -
        (left.attributes?.BANDWIDTH ?? 0),
    )[0];
  }

  if (!selected) throw noTimeline(DASH_REPRESENTATION_UNAVAILABLE);
  return selected;
}

function audioCandidates(manifest: MpdManifest): AudioPlaylistCandidate[] {
  const groups = Object.values(manifest.mediaGroups?.AUDIO?.audio ?? {});
  const preferredGroups = [
    ...groups.filter((group) => group.default),
    ...groups.filter((group) => !group.default),
  ];
  return preferredGroups.flatMap((group) =>
    (group.playlists ?? []).map((playlist) => ({ playlist, group })),
  );
}

function selectAudioPlaylist(
  manifest: MpdManifest,
  selection: DashTrackSelectionOptions,
): AudioPlaylistCandidate | null {
  const candidates = audioCandidates(manifest);
  if (candidates.length === 0) return null;

  if (selection.audioRepresentationId) {
    const selected = candidates.find(
      ({ playlist }) =>
        representationId(playlist, "audio") === selection.audioRepresentationId,
    );
    if (!selected) throw noTimeline(DASH_REPRESENTATION_UNAVAILABLE);
    return selected;
  }

  return candidates[0]!;
}

/**
 * Parse and normalize a static DASH VOD into independently timed video and
 * audio tracks. Existing full-download adapters intentionally do not use this
 * function.
 */
export function parseTimedDashTracks(
  mpdText: string,
  mpdUrl: string,
  selection: DashTrackSelectionOptions = {},
): TimedDashTracks {
  if (hasDrm(mpdText)) {
    throw new ClippingError("DRM_PROTECTED", "DASH_DRM_PROTECTED");
  }
  if (isLive(mpdText)) throw noTimeline(DASH_DYNAMIC_UNSUPPORTED);

  let manifest: MpdManifest;
  try {
    manifest = parseManifest(mpdText, mpdUrl);
  } catch (error) {
    if (error instanceof ClippingError) throw error;
    throw noTimeline(DASH_MANIFEST_UNUSABLE, error);
  }

  const video = normalizeDashTrack(
    selectVideoPlaylist(manifest, selection),
    "video",
  );
  const audioCandidate = selectAudioPlaylist(manifest, selection);
  const audio = audioCandidate
    ? normalizeDashTrack(
        audioCandidate.playlist,
        "audio",
        audioCandidate.group.language,
      )
    : null;

  const duration = manifest.duration;
  return {
    ...(typeof duration === "number" && Number.isFinite(duration)
      ? { durationMs: Math.round(duration * 1000) }
      : {}),
    video,
    audio,
  };
}

function selectedPeriodKeys(
  selection: IndependentTrackClipSelection["video"],
): Set<string> {
  return new Set(
    (selection?.mediaSegments ?? []).map(
      (segment) => (segment as TimedDashMediaSegment).periodKey,
    ),
  );
}

/** Select synchronized DASH track windows and reject Period crossings. */
export function selectDashTrackWindows(
  tracks: TimedDashTracks,
  startMs: number,
  endMs: number,
  mode: ClipMode = "fast",
): IndependentTrackClipSelection {
  const selected = selectIndependentTrackWindows(
    tracks.video.segments,
    tracks.audio?.segments,
    startMs,
    endMs,
    mode,
  );

  if (!selected.video || (tracks.audio && !selected.audio)) {
    throw noTimeline(DASH_CLIP_WINDOW_UNAVAILABLE);
  }

  const videoPeriods = selectedPeriodKeys(selected.video);
  const audioPeriods = selectedPeriodKeys(selected.audio);
  if (videoPeriods.size > 1 || audioPeriods.size > 1) {
    throw new ClippingError(
      "UNSUPPORTED_MULTI_PERIOD_DASH",
      "DASH_CLIP_CROSSES_PERIODS",
    );
  }

  if (
    selected.audio &&
    (videoPeriods.size !== 1 ||
      audioPeriods.size !== 1 ||
      [...videoPeriods][0] !== [...audioPeriods][0])
  ) {
    throw new ClippingError(
      "UNSUPPORTED_MULTI_PERIOD_DASH",
      "DASH_TRACK_PERIOD_MISMATCH",
    );
  }

  return selected;
}

/**
 * Parse an MPD manifest string into a structured manifest object.
 */
export function parseManifest(mpdText: string, mpdUrl: string): MpdManifest {
  return parse(mpdText, { manifestUri: mpdUrl }) as MpdManifest;
}

/**
 * Parse an MPD manifest into Level[] (one Level per representation).
 * Mirrors parseMasterPlaylist() from m3u8-parser.ts.
 */
export function parseMasterPlaylist(mpdText: string, mpdUrl: string): Level[] {
  const manifest = parseManifest(mpdText, mpdUrl);
  return (manifest.playlists || []).map((playlist) => ({
    type: "stream" as LevelType,
    id: uuidv4(),
    playlistID: mpdUrl,
    uri: mpdUrl, // DASH representations all derive from the same MPD URL
    bitrate: playlist.attributes?.BANDWIDTH,
    height: playlist.attributes?.RESOLUTION?.height,
    width: playlist.attributes?.RESOLUTION?.width,
  }));
}

/**
 * Select the highest-bandwidth video playlist from a parsed MPD manifest
 * and return it as a ParsedPlaylist, ready for parseLevelsPlaylist().
 * Returns null if no video playlists are present.
 */
export function getVideoPlaylist(manifest: MpdManifest): ParsedPlaylist | null {
  const playlists = [...(manifest.playlists || [])];
  if (!playlists.length) return null;
  playlists.sort((a, b) => (b.attributes?.BANDWIDTH || 0) - (a.attributes?.BANDWIDTH || 0));
  return mpdPlaylistToParsedPlaylist(playlists[0]!);
}

/**
 * Select a video playlist by bandwidth, falling back to highest if not found.
 */
export function getVideoPlaylistByBandwidth(
  manifest: MpdManifest,
  bandwidth: number,
): ParsedPlaylist | null {
  const match = (manifest.playlists || []).find(
    (p) => p.attributes?.BANDWIDTH === bandwidth,
  );
  if (!match) return getVideoPlaylist(manifest);
  return mpdPlaylistToParsedPlaylist(match);
}

/**
 * Extract the first audio playlist from the parsed manifest's mediaGroups
 * and return it as a ParsedPlaylist, ready for parseLevelsPlaylist().
 * Returns null if no audio adaptation set is present.
 */
export function getAudioPlaylist(manifest: MpdManifest): ParsedPlaylist | null {
  const audioGroup = manifest.mediaGroups?.AUDIO?.audio;
  if (!audioGroup) return null;
  for (const group of Object.values(audioGroup)) {
    if (group.playlists?.length) {
      return mpdPlaylistToParsedPlaylist(group.playlists[0]!);
    }
  }
  return null;
}

/**
 * Detect whether an MPD describes a live (dynamic) stream.
 * Checks for `type="dynamic"` in the raw XML — more reliable than inspecting
 * the parsed output, which always sets minimumUpdatePeriod.
 */
export function isLive(mpdText: string): boolean {
  return /type\s*=\s*["']dynamic["']/i.test(mpdText);
}

/**
 * Check whether an MPD contains DRM (ContentProtection elements).
 */
export function hasDrm(mpdText: string): boolean {
  return /<ContentProtection/i.test(mpdText) || /cenc:/i.test(mpdText);
}

/**
 * Extract the poll interval from minimumUpdatePeriod in the MPD.
 * Clamped to [1000ms, 10000ms]; defaults to 3000ms if not present.
 */
export function getPollIntervalMs(mpdText: string): number {
  const match = mpdText.match(/minimumUpdatePeriod\s*=\s*["']PT([\d.]+)S["']/i);
  if (!match) return 3000;
  const seconds = parseFloat(match[1]!);
  const ms = Math.round(seconds * 1000);
  return Math.max(1000, Math.min(ms, 10000));
}

export const MpdParser = {
  parseManifest,
  parseMasterPlaylist,
  parseLevelsPlaylist,
  parseTimedDashTracks,
  selectDashTrackWindows,
  getVideoPlaylist,
  getVideoPlaylistByBandwidth,
  getAudioPlaylist,
  isLive,
  hasDrm,
  getPollIntervalMs,
};
