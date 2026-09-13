/**
 * HLS detection handler - orchestrates HLS playlist detection
 *
 * This handler is responsible for detecting HLS (HTTP Live Streaming) playlists from network requests.
 * It distinguishes between master playlists (containing multiple quality variants) and media playlists
 * (containing actual video fragments), and manages the relationship between them.
 *
 * Key features:
 * - Detects HLS master playlists and media playlists from network requests
 * - Distinguishes between master and media playlists
 * - Tracks master playlists and their variant URLs
 * - Removes media playlists that belong to master playlists (to avoid duplicates)
 * - Extracts metadata from playlist URLs
 * - Handles both HLS format (master playlists) and M3U8 format (standalone media playlists)
 *
 * Detection process:
 * 1. Network requests are intercepted and checked for .m3u8 URLs
 * 2. Playlist content is fetched and analyzed to determine type (master vs media)
 * 3. Master playlists are tracked with their variant URLs
 * 4. Media playlists are checked if they belong to tracked master playlists
 * 5. Standalone media playlists are detected as M3U8 format
 * 6. Master playlists are detected as HLS format
 * 7. Variant videos are removed when master playlist is detected
 *
 * @module HlsDetectionHandler
 */

import {
  VideoMetadata,
  VideoFormat,
  type DirectMediaAsset,
  type Level,
} from "../../types";
import {
  isMasterPlaylist,
  isMediaPlaylist,
  parseMasterPlaylist,
  parseSingleFileFmp4Playlist,
} from "../../parsers/m3u8-parser";
import { fetchText } from "../../utils/fetch-utils";
import { normalizeUrl } from "../../utils/url-utils";
import { logger } from "../../utils/logger";
import { extractThumbnail } from "../thumbnail-utils";
import { hasDrm, canDecrypt } from "../../utils/drm-utils";
import { DEFAULT_DETECTION_CACHE_SIZE, DEFAULT_MASTER_PLAYLIST_CACHE_SIZE } from "../../../shared/constants";
import { mediaSourceKey } from "../network-media";
import { applyBestDirectMediaAsset } from "../../media/direct-media-assets";

/** Configuration options for HlsDetectionHandler */
export interface HlsDetectionHandlerOptions {
  /** Optional callback for detected videos */
  onVideoDetected?: (video: VideoMetadata) => void;
  /** Optional callback for removed videos */
  onVideoRemoved?: (url: string) => void;
  /** Max distinct URL path keys tracked per page (default: 500) */
  detectionCacheSize?: number;
  /** Max master playlists held in memory (default: 50) */
  masterPlaylistCacheSize?: number;
}

/** Internal structure for tracking master playlist information */
interface MasterPlaylistInfo {
  url: string;
  variantUrls: Set<string>;
  variantPathKeys: Set<string>;
}

/**
 * HLS detection handler
 * Detects HLS master playlists and standalone media playlists
 */
export class HlsDetectionHandler {
  private onVideoDetected?: (video: VideoMetadata) => void;
  private onVideoRemoved?: (url: string) => void;
  // Track master playlists and their variants
  private masterPlaylists: Map<string, MasterPlaylistInfo> = new Map();
  // Deduplicate HLS URLs by origin+pathname (ignoring query params like tokens/timestamps)
  private seenPathKeys: Set<string> = new Set();
  private readonly maxSeenPathKeys: number;
  private readonly maxMasterPlaylists: number;

  /**
   * Create a new HlsDetectionHandler instance
   * @param options - Configuration options
   */
  constructor(options: HlsDetectionHandlerOptions = {}) {
    this.onVideoDetected = options.onVideoDetected;
    this.onVideoRemoved = options.onVideoRemoved;
    this.maxSeenPathKeys = options.detectionCacheSize ?? DEFAULT_DETECTION_CACHE_SIZE;
    this.maxMasterPlaylists = options.masterPlaylistCacheSize ?? DEFAULT_MASTER_PLAYLIST_CACHE_SIZE;
  }

  /**
   * Clean up all resources to prevent memory leaks
   */
  destroy(): void {
    this.seenPathKeys.clear();
    this.masterPlaylists.clear();
  }

  /**
   * Detect HLS playlist from URL
   * @param url - Playlist URL to detect
   * @returns Promise resolving to VideoMetadata or null if not detected
   */
  async detect(url: string): Promise<VideoMetadata | null> {
    if (!this.isHlsUrl(url)) {
      return null;
    }

    // Deduplicate by origin+pathname so re-fetches with different query params
    // (auth tokens, timestamps) don't create duplicate video cards
    const pathKey = this.getPathKey(url);
    if (this.seenPathKeys.has(pathKey)) {
      return null;
    }
    // Evict oldest entries if over limit
    if (this.seenPathKeys.size >= this.maxSeenPathKeys) {
      const first = this.seenPathKeys.values().next().value;
      if (first) this.seenPathKeys.delete(first);
    }
    this.seenPathKeys.add(pathKey);

    try {
      const playlistText = await this.fetchPlaylistText(url);
      const normalizedUrl = normalizeUrl(url);
      const isMaster = isMasterPlaylist(playlistText);
      const isMedia = isMediaPlaylist(playlistText);

      if (isMedia) {
        return await this.handleMediaPlaylist(url, normalizedUrl, playlistText);
      }

      if (isMaster) {
        return await this.handleMasterPlaylist(
          url,
          normalizedUrl,
          playlistText,
        );
      }

      logger.warn(
        "[Media Sniper] HLS URL is neither master nor media playlist, skipping",
        { url },
      );
      return null;
    } catch (error) {
      logger.error("[Media Sniper] Failed to validate HLS playlist:", error);
      return null;
    }
  }

  /**
   * Fetch playlist text from URL
   * @private
   */
  private async fetchPlaylistText(url: string): Promise<string> {
    return await fetchText(url, 1);
  }

  /**
   * Handle media playlist detection
   * @private
   */
  private async handleMediaPlaylist(
    url: string,
    normalizedUrl: string,
    playlistText: string,
  ): Promise<VideoMetadata | null> {
    const singleFile = this.isPlainMediaPlaylist(playlistText)
      ? parseSingleFileFmp4Playlist(playlistText, url)
      : null;
    if (singleFile) {
      logger.info("[Media Sniper] Detected single-file fMP4 HLS asset", {
        playlistUrl: url,
        mediaUrl: singleFile.url,
      });
      return this.addSingleFileFmp4Video(url, [{
        url: singleFile.url,
        kind: "self-contained-fmp4",
        sourceKey: mediaSourceKey([singleFile.url], VideoFormat.DIRECT),
        sourceUrl: url,
        observedAt: Date.now(),
        contentType: "video/mp4",
        contentLength: singleFile.totalLength,
      }]);
    }

    const belongsToMaster = this.checkIfBelongsToMasterPlaylist(normalizedUrl);

    if (belongsToMaster) {
      logger.debug(
        "[Media Sniper] M3U8 media playlist belongs to a master playlist, removing it",
        url,
      );
      this.removeDetectedVideo(normalizedUrl);
      return null;
    }

    // It's a standalone media playlist, add it as M3U8 format
    // A media playlist without #EXT-X-ENDLIST is a live stream
    const isLive = !playlistText.includes("#EXT-X-ENDLIST");
    logger.info("[Media Sniper] Detected standalone M3U8 media playlist", url);
    return await this.addDetectedVideo(url, VideoFormat.M3U8, playlistText, isLive);
  }

  /**
   * Handle master playlist detection
   * @private
   */
  private async handleMasterPlaylist(
    url: string,
    normalizedUrl: string,
    playlistText: string,
  ): Promise<VideoMetadata | null> {
    logger.info("[Media Sniper] Detected HLS Master Playlist", { url });

    // Parse once, reuse for tracking and liveness check
    const levels = parseMasterPlaylist(playlistText, url);

    const variantUrls = this.trackMasterPlaylistWithLevels(
      url,
      normalizedUrl,
      levels,
    );

    // Remove any existing detected videos that are variants of this master playlist
    this.removeVariantVideos(variantUrls);

    const singleFileAssets = await this.findSingleFileVariantAssets(levels);
    if (singleFileAssets.length > 0) {
      logger.info(
        `[Media Sniper] Detected ${singleFileAssets.length} complete fMP4 quality variant(s)`,
      );
      return this.addSingleFileFmp4Video(url, singleFileAssets);
    }

    // Determine liveness by fetching the first variant playlist and checking for #EXT-X-ENDLIST
    const isLive = await this.checkMasterIsLive(levels);

    return await this.addDetectedVideo(url, VideoFormat.HLS, playlistText, isLive);
  }

  private async findSingleFileVariantAssets(
    levels: Level[],
  ): Promise<DirectMediaAsset[]> {
    // Preserve the normal HLS mux path when the master declares a separate
    // audio rendition; a video-only m4s is not a complete fallback.
    if (levels.some((level) => level.type === "audio")) return [];
    const streams = levels.filter((level) => level.type === "stream");
    const results = await Promise.allSettled(streams.map(async (level) => {
      const text = await this.fetchPlaylistText(level.uri);
      if (!this.isPlainMediaPlaylist(text)) return null;
      const singleFile = parseSingleFileFmp4Playlist(text, level.uri);
      if (!singleFile) return null;
      return {
        url: singleFile.url,
        kind: "self-contained-fmp4" as const,
        sourceKey: mediaSourceKey([singleFile.url], VideoFormat.DIRECT),
        sourceUrl: level.uri,
        observedAt: Date.now(),
        contentType: "video/mp4",
        contentLength: singleFile.totalLength,
        width: level.width,
        height: level.height,
        bandwidth: level.bitrate,
        quality: level.height ? `${level.height}p` : undefined,
      };
    }));
    return results.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : []);
  }

  private isPlainMediaPlaylist(playlistText: string): boolean {
    return !hasDrm(playlistText) &&
      canDecrypt(playlistText) &&
      !/#EXT-X-KEY:METHOD=(?!NONE(?:,|$))/i.test(playlistText);
  }

  private async addSingleFileFmp4Video(
    playlistUrl: string,
    assets: DirectMediaAsset[],
  ): Promise<VideoMetadata> {
    const first = assets[0]!;
    let metadata: VideoMetadata = {
      url: first.url,
      format: VideoFormat.DIRECT,
      pageUrl: window.location.href,
      title: document.title,
      fileExtension: "mp4",
      sourceUrl: playlistUrl,
      sourceKey: first.sourceKey,
      observedAt: first.observedAt,
      contentType: "video/mp4",
      contentLength: first.contentLength,
      isSelfContainedFmp4: true,
      mediaAssets: assets,
      isLive: false,
    };
    metadata = applyBestDirectMediaAsset(metadata, assets);
    const thumbnail = extractThumbnail();
    if (thumbnail) metadata.thumbnail = thumbnail;
    this.onVideoDetected?.(metadata);
    return metadata;
  }

  /**
   * Check if an HLS master playlist represents a live stream
   * Fetches the first video variant and checks for #EXT-X-ENDLIST
   * @private
   */
  private async checkMasterIsLive(
    levels: ReturnType<typeof parseMasterPlaylist>,
  ): Promise<boolean> {
    try {
      const firstVariant = levels.find((l) => l.type === "stream");
      if (!firstVariant) return false;
      const variantText = await fetchText(firstVariant.uri, 1);
      return !variantText.includes("#EXT-X-ENDLIST");
    } catch {
      // If we can't fetch the variant, assume VOD (safer default)
      return false;
    }
  }

  /**
   * Track master playlist and extract variant URLs
   * @private
   */
  private trackMasterPlaylistWithLevels(
    url: string,
    normalizedUrl: string,
    levels: ReturnType<typeof parseMasterPlaylist>,
  ): Set<string> {
    const variantUrls = new Set<string>();
    const variantPathKeys = new Set<string>();

    levels.forEach((level) => {
      const normalizedVariantUrl = normalizeUrl(level.uri);
      variantUrls.add(normalizedVariantUrl);
      variantPathKeys.add(this.getPathKey(normalizedVariantUrl));
    });

    // Evict oldest master playlists if over limit
    if (this.masterPlaylists.size >= this.maxMasterPlaylists) {
      const firstKey = this.masterPlaylists.keys().next().value;
      if (firstKey) this.masterPlaylists.delete(firstKey);
    }

    this.masterPlaylists.set(normalizedUrl, {
      url,
      variantUrls,
      variantPathKeys,
    });

    return variantUrls;
  }

  /**
   * Remove detected video if callback is available
   * @private
   */
  private removeDetectedVideo(normalizedUrl: string): void {
    if (this.onVideoRemoved) {
      this.onVideoRemoved(normalizedUrl);
    }
  }

  /**
   * Extract metadata and notify about detected video
   * @private
   */
  private async addDetectedVideo(
    url: string,
    format: VideoFormat.HLS | VideoFormat.M3U8,
    playlistText: string,
    isLive: boolean = false,
  ): Promise<VideoMetadata | null> {
    const metadata = await this.extractMetadata(url, format, playlistText, isLive);

    if (metadata && this.onVideoDetected) {
      this.onVideoDetected(metadata);
    }

    return metadata;
  }

  /**
   * Handle network request for HLS playlist
   * Triggers detection for HLS URLs
   */
  handleNetworkRequest(url: string): void {
    if (this.isHlsUrl(url)) {
      // Trigger detection for HLS URL
      this.detect(url);
    }
  }

  /**
   * Check if URL is an HLS playlist URL
   * @private
   */
  private isHlsUrl(url: string): boolean {
    const urlLower = url.toLowerCase();
    return urlLower.includes(".m3u8") || !!urlLower.match(/\.m3u8(\?|$|#)/);
  }

  /**
   * Check if content type indicates HLS playlist
   * @param contentType - Content-Type header value
   * @returns True if content type indicates HLS playlist
   */
  /**
   * Get a deduplication key from a URL using only origin + pathname.
   * This ensures that the same playlist re-fetched with different query
   * parameters (tokens, timestamps) is recognized as the same stream.
   */
  private getPathKey(url: string): string {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch {
      return url;
    }
  }

  isHlsContentType(contentType: string): boolean {
    const contentTypeLower = contentType.toLowerCase();
    return (
      contentTypeLower.includes("application/vnd.apple.mpegurl") ||
      contentTypeLower.includes("application/x-mpegurl")
    );
  }

  /**
   * Check if a media playlist URL belongs to any tracked master playlist
   * @private
   */
  private checkIfBelongsToMasterPlaylist(mediaPlaylistUrl: string): boolean {
    const mediaPathKey = this.getPathKey(mediaPlaylistUrl);
    for (const masterInfo of this.masterPlaylists.values()) {
      // O(1) exact URL match
      if (masterInfo.variantUrls.has(mediaPlaylistUrl)) {
        return true;
      }
      // O(1) path key match (handles different query params)
      if (masterInfo.variantPathKeys.has(mediaPathKey)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Remove variant videos that belong to master playlists
   * @private
   */
  private removeVariantVideos(variantUrls: Set<string>): void {
    if (!this.onVideoRemoved) {
      return;
    }

    const onVideoRemoved = this.onVideoRemoved;
    variantUrls.forEach((variantUrl) => {
      logger.debug(
        "[Media Sniper] Removing variant video that belongs to master playlist",
        { variantUrl },
      );
      onVideoRemoved(variantUrl);
    });
  }

  /**
   * Extract metadata from HLS playlist URL
   * @private
   */
  private async extractMetadata(
    url: string,
    format: VideoFormat.HLS | VideoFormat.M3U8 = VideoFormat.HLS,
    playlistText: string,
    isLive: boolean = false,
  ): Promise<VideoMetadata | null> {
    const metadata: VideoMetadata = {
      url,
      format,
      pageUrl: window.location.href,
      title: document.title,
      fileExtension: "m3u8",
      hasDrm: hasDrm(playlistText),
      unsupported: !canDecrypt(playlistText),
      isLive,
    };

    // Extract thumbnail using unified utility (page-based search)
    const thumbnail = extractThumbnail();
    if (thumbnail) {
      metadata.thumbnail = thumbnail;
    }

    return metadata;
  }
}
