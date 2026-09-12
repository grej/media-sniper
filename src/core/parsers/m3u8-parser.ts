/**
 * M3U8 playlist parser utility
 */

import { Parser } from "m3u8-parser";
import { buildAbsoluteURL } from "url-toolkit";
import { v4 as uuidv4 } from "uuid";
import { Level, LevelType } from "../types";
import type {
  ParsedPlaylist,
  TimedParsedPlaylist,
  TimedParsedSegment,
} from "./playlist-utils";
import type { ByteRangeSpec } from "../clipping/types";
import { hasM4sMediaHint, normalizeUrl } from "../utils/url-utils";
import { logger } from "../utils/logger";

export { parseLevelsPlaylist } from "./playlist-utils";
import { parseLevelsPlaylist } from "./playlist-utils";

/**
 * Parse a media playlist into a ParsedPlaylist (protocol-agnostic intermediate).
 * Pass the result to parseLevelsPlaylist() to get Fragment[].
 */
function normalizeByteRange(
  byteRange: { offset: number; length: number } | undefined,
): ByteRangeSpec | undefined {
  if (!byteRange) return undefined;
  return { offset: byteRange.offset, length: byteRange.length };
}

/** Convert m3u8-parser's four host integers into the 16-byte HLS IV. */
function explicitIvBytes(iv: Uint32Array): Uint8Array {
  const result = new Uint8Array(16);
  const view = new DataView(result.buffer);
  for (let index = 0; index < Math.min(iv.length, 4); index++) {
    view.setUint32(index * 4, iv[index]!, false);
  }
  return result;
}

/** Preserve the historical Fragment key serialization for legacy consumers. */
function legacyIvHex(iv: Uint32Array): string {
  return Array.from(iv)
    .map((word) => word.toString(16).padStart(2, "0"))
    .join("");
}

export function parseTimedMediaPlaylist(
  playlistText: string,
  baseUrl: string,
): TimedParsedPlaylist {
  const parser = new Parser();
  parser.push(playlistText);
  parser.end();

  const manifest = parser.manifest;
  const mediaSequence = manifest.mediaSequence ?? 0;
  const discontinuitySequence = manifest.discontinuitySequence ?? 0;
  let cumulativeSeconds = 0;

  const segments: TimedParsedSegment[] = (manifest.segments || []).map(
    (segment, sourceIndex) => {
      const startMs = Math.round(cumulativeSeconds * 1000);
      cumulativeSeconds += segment.duration;
      const endMs = Math.round(cumulativeSeconds * 1000);
      const sequenceNumber = mediaSequence + sourceIndex;
      const uri = buildAbsoluteURL(baseUrl, segment.uri);

      const ps: TimedParsedSegment = {
        sourceIndex,
        sequenceNumber,
        uri,
        startMs,
        durationMs: endMs - startMs,
        endMs,
        discontinuitySequence: segment.timeline ?? discontinuitySequence,
      };

      const byteRange = normalizeByteRange(segment.byterange);
      if (byteRange) ps.byteRange = byteRange;

      if (segment.map?.uri) {
        const initUri = buildAbsoluteURL(baseUrl, segment.map.uri);
        const initByteRange = normalizeByteRange(segment.map.byterange);
        ps.init = {
          uri: initUri,
          ...(initByteRange ? { byteRange: initByteRange } : {}),
        };

        // Legacy aliases consumed by parseLevelsPlaylist().
        ps.initUri = initUri;
        if (segment.map.byterange) {
          ps.initByteRange = `${segment.map.byterange.offset}:${segment.map.byterange.length}`;
        }
      }

      if (segment.key?.uri) {
        const keyUri = buildAbsoluteURL(baseUrl, segment.key.uri);
        const explicitIv = segment.key.iv
          ? explicitIvBytes(segment.key.iv)
          : undefined;

        if (segment.key.method === "AES-128") {
          ps.encryption = {
            method: "AES-128",
            keyUri,
            sequenceNumber,
            ...(explicitIv ? { explicitIv } : {}),
          };
        }

        // Keep the prior serialized shape byte-for-byte for full downloads.
        ps.key = {
          uri: keyUri,
          iv: segment.key.iv ? legacyIvHex(segment.key.iv) : null,
        };
      }

      return ps;
    },
  );

  return {
    segments,
    mediaSequence,
    discontinuitySequence,
    durationMs: Math.round(cumulativeSeconds * 1000),
    endList: manifest.endList ?? false,
  };
}

export function parseMediaPlaylist(
  playlistText: string,
  baseUrl: string,
): ParsedPlaylist {
  return parseTimedMediaPlaylist(playlistText, baseUrl);
}

export interface SingleFileFmp4Playlist {
  url: string;
  totalLength: number;
  initRange: ByteRangeSpec;
  mediaRanges: ByteRangeSpec[];
}

/**
 * Recognize VOD playlists whose init and every media byte range address one
 * contiguous .m4s resource. Such a resource is already a complete fMP4 and
 * should use the direct-file download path instead of segment concatenation.
 */
export function parseSingleFileFmp4Playlist(
  playlistText: string,
  baseUrl: string,
): SingleFileFmp4Playlist | null {
  const playlist = parseTimedMediaPlaylist(playlistText, baseUrl);
  if (!playlist.endList || playlist.segments.length === 0) return null;

  const first = playlist.segments[0]!;
  if (!first.init?.uri || !first.init.byteRange || !first.byteRange) return null;
  const mediaUrl = normalizeUrl(first.init.uri);
  if (!hasM4sMediaHint(mediaUrl) || first.init.byteRange.offset !== 0) return null;

  const mediaRanges: ByteRangeSpec[] = [];
  let nextOffset = first.init.byteRange.length;
  for (const segment of playlist.segments) {
    if (
      !segment.init?.uri ||
      normalizeUrl(segment.init.uri) !== mediaUrl ||
      normalizeUrl(segment.uri) !== mediaUrl ||
      !segment.byteRange ||
      segment.byteRange.offset !== nextOffset
    ) return null;
    mediaRanges.push(segment.byteRange);
    nextOffset += segment.byteRange.length;
  }

  return {
    url: first.init.uri,
    totalLength: nextOffset,
    initRange: first.init.byteRange,
    mediaRanges,
  };
}

/**
 * Parse a master playlist into levels (variants/qualities)
 */
export function parseMasterPlaylist(
  playlistText: string,
  baseUrl: string,
): Level[] {
  const parser = new Parser();
  parser.push(playlistText);
  parser.end();

  const playlists = parser.manifest?.playlists || [];
  const audioPlaylists = parser.manifest?.mediaGroups?.AUDIO || {};

  // Parse video stream playlists
  const streamLevels: Level[] = playlists.map((playlist) => ({
    type: "stream" as LevelType,
    id: uuidv4(),
    playlistID: baseUrl,
    uri: buildAbsoluteURL(baseUrl, playlist.uri),
    bitrate: playlist.attributes.BANDWIDTH,
    fps: playlist.attributes["FRAME-RATE"],
    height: playlist.attributes.RESOLUTION?.height,
    width: playlist.attributes.RESOLUTION?.width,
  }));

  // Parse audio playlists
  const audioLevels: Level[] = Object.entries(audioPlaylists).flatMap(
    ([key, entries]) => {
      return Object.entries(entries).map(([label, entry]: [string, any]) => {
        return {
          type: "audio" as LevelType,
          id: `${label}-${key}`,
          playlistID: baseUrl,
          uri: buildAbsoluteURL(baseUrl, entry.uri),
          bitrate: undefined,
          fps: undefined,
          width: undefined,
          height: undefined,
        };
      });
    },
  );

  return [...streamLevels, ...audioLevels];
}

export interface HlsMasterVariant {
  uri: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  audioGroupId?: string;
}

export interface HlsAudioRendition {
  groupId: string;
  name: string;
  uri?: string;
  isDefault: boolean;
  autoselect: boolean;
  language?: string;
}

export interface HlsMasterDescriptor {
  variants: HlsMasterVariant[];
  audioRenditions: HlsAudioRendition[];
}

/** Rich master shape used by clipping so audio remains associated with its variant. */
export function parseHlsMasterDescriptor(
  playlistText: string,
  baseUrl: string,
): HlsMasterDescriptor {
  const parser = new Parser();
  parser.push(playlistText);
  parser.end();
  const manifest = parser.manifest as any;
  const variants = (manifest.playlists ?? []).map((playlist: any) => ({
    uri: buildAbsoluteURL(baseUrl, playlist.uri),
    bandwidth: playlist.attributes?.BANDWIDTH,
    width: playlist.attributes?.RESOLUTION?.width,
    height: playlist.attributes?.RESOLUTION?.height,
    audioGroupId: playlist.attributes?.AUDIO,
  }));
  const audioRenditions: HlsAudioRendition[] = [];
  for (const [groupId, entries] of Object.entries(manifest.mediaGroups?.AUDIO ?? {})) {
    for (const [name, entryValue] of Object.entries(entries as Record<string, any>)) {
      const entry = entryValue as any;
      audioRenditions.push({
        groupId,
        name,
        uri: entry.uri ? buildAbsoluteURL(baseUrl, entry.uri) : undefined,
        isDefault: entry.default === true,
        autoselect: entry.autoselect === true,
        language: entry.language,
      });
    }
  }
  return { variants, audioRenditions };
}

export function selectHlsClipVariant(
  descriptor: HlsMasterDescriptor,
  selectedBandwidth?: number,
): { videoUrl: string | null; audioUrl: string | null } {
  const variants = [...descriptor.variants].sort((left, right) =>
    (right.bandwidth ?? 0) - (left.bandwidth ?? 0)
      || (right.height ?? 0) - (left.height ?? 0));
  const variant = selectedBandwidth === undefined
    ? variants[0]
    : variants.find((item) => item.bandwidth === selectedBandwidth) ?? variants[0];
  if (!variant) return { videoUrl: null, audioUrl: null };
  const audio = variant.audioGroupId
    ? descriptor.audioRenditions
        .filter((item) => item.groupId === variant.audioGroupId && item.uri)
        .sort((left, right) => Number(right.isDefault) - Number(left.isDefault)
          || Number(right.autoselect) - Number(left.autoselect))[0]
    : undefined;
  return { videoUrl: variant.uri, audioUrl: audio?.uri ?? null };
}

/**
 * Check if a playlist is a master playlist (contains variants)
 */
export function isMasterPlaylist(playlistText: string): boolean {
  const parser = new Parser();
  parser.push(playlistText);
  parser.end();

  // Master playlists have playlists array or mediaGroups
  return (
    (parser.manifest.playlists && parser.manifest.playlists.length > 0) ||
    (parser.manifest.mediaGroups &&
      Object.keys(parser.manifest.mediaGroups).length > 0) ||
    false
  );
}

/**
 * Check if a playlist is a media playlist (contains direct segments)
 */
export function isMediaPlaylist(playlistText: string): boolean {
  const parser = new Parser();
  parser.push(playlistText);
  parser.end();

  // Media playlists have segments array with actual segment URIs
  // They don't have playlists or mediaGroups (those are master playlists)
  const hasSegments =
    parser.manifest.segments && parser.manifest.segments.length > 0;
  const hasNoPlaylists =
    !parser.manifest.playlists || parser.manifest.playlists.length === 0;
  const hasNoMediaGroups =
    !parser.manifest.mediaGroups ||
    Object.keys(parser.manifest.mediaGroups).length === 0;

  return hasSegments && hasNoPlaylists && hasNoMediaGroups;
}

/**
 * Check if a media playlist belongs to a specific master playlist
 *
 * This function determines membership by comparing URLs:
 * 1. Parses the master playlist to extract all variant URIs
 * 2. Resolves variant URIs into full URLs (relative to master playlist base URL)
 * 3. Compares the media playlist URL against all variant URLs
 * 4. Returns true if there's a match
 *
 * @param masterPlaylistText - The master playlist content as text
 * @param masterPlaylistBaseUrl - The base URL of the master playlist (used to resolve relative URIs)
 * @param mediaPlaylistUrl - The URL of the media playlist to check
 * @returns true if the media playlist belongs to the master playlist, false otherwise
 */
export function belongsToMasterPlaylist(
  masterPlaylistText: string,
  masterPlaylistBaseUrl: string,
  mediaPlaylistUrl: string,
): boolean {
  // Parse the master playlist to get all variant levels
  const levels = parseMasterPlaylist(masterPlaylistText, masterPlaylistBaseUrl);

  // Normalize the media playlist URL for comparison
  const normalizedMediaUrl = normalizeUrl(mediaPlaylistUrl);

  logger.debug("Normalized media URL", { normalizedMediaUrl });
  logger.debug("levels", { levels });

  // Check if the media playlist URL matches any variant URL from the master playlist
  return levels.some((level) => {
    const normalizedVariantUrl = normalizeUrl(level.uri);
    return normalizedVariantUrl === normalizedMediaUrl;
  });
}

export const M3u8Parser = {
  parseLevelsPlaylist,
  parseMediaPlaylist,
  parseTimedMediaPlaylist,
  parseSingleFileFmp4Playlist,
  parseMasterPlaylist,
  parseHlsMasterDescriptor,
  selectHlsClipVariant,
  isMasterPlaylist,
  isMediaPlaylist,
  belongsToMasterPlaylist,
};
