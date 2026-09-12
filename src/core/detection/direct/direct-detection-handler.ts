/**
 * Direct video detection handler - orchestrates direct video detection
 *
 * This handler is responsible for detecting direct video file URLs (e.g., .mp4, .webm, .mov files)
 * from network requests and DOM video elements. It monitors the DOM for video elements and
 * associates network requests with those elements to extract comprehensive metadata.
 *
 * Key features:
 * - Detects direct video URLs from network requests
 * - Monitors DOM for video elements using MutationObserver
 * - Associates network requests with video elements
 * - Extracts metadata from video elements (dimensions, duration, thumbnails)
 * - Filters out audio-only URLs
 * - Performs initial DOM scan and continuous monitoring
 *
 * Detection process:
 * 1. Network requests are intercepted and checked for direct video URLs
 * 2. URLs are associated with video elements in the DOM
 * 3. DOM observer monitors for dynamically added video elements
 * 4. Metadata is extracted from video elements (dimensions, duration, thumbnails)
 * 5. Detected videos trigger callbacks with complete metadata
 *
 * @module DirectDetectionHandler
 */

import { VideoMetadata, VideoFormat, type DirectMediaAsset } from "../../types";
import {
  detectFormatFromUrl,
  hasM4sMediaHint,
  normalizeUrl,
} from "../../utils/url-utils";
import { extractThumbnail } from "../thumbnail-utils";
import {
  redactSensitiveUrl,
  type NetworkMediaObservation,
} from "../network-media";
import {
  applyBestDirectMediaAsset,
  directMediaAssetFromMetadata,
  mergeDirectMediaAssets,
} from "../../media/direct-media-assets";

const DOM_SCAN_DEBOUNCE_MS = 1000;
const RECENT_NETWORK_CANDIDATE_TTL_MS = 30_000;
const MAX_RECENT_NETWORK_CANDIDATES = 20;
const MAX_HEADING_SEARCH_DEPTH = 3;
const MAX_HEADING_TITLE_LENGTH = 200;
const MEDIA_LIFECYCLE_EVENTS = [
  "loadstart",
  "loadedmetadata",
  "durationchange",
  "canplay",
  "playing",
  "emptied",
] as const;

/** Configuration options for DirectDetectionHandler */
export interface DirectDetectionHandlerOptions {
  /** Optional callback for detected videos */
  onVideoDetected?: (video: VideoMetadata) => void;
  /** Resolve the stable playback-registry ID for an associated element. */
  getPageVideoId?: (video: HTMLVideoElement) => string;
}

/**
 * Direct video detection handler
 * Detects direct video URLs from network requests and DOM elements
 */
export class DirectDetectionHandler {
  private onVideoDetected?: (video: VideoMetadata) => void;
  private getPageVideoId?: (video: HTMLVideoElement) => string;
  private capturedUrls = new Map<HTMLVideoElement, string>();
  private mediaAssets = new WeakMap<HTMLVideoElement, DirectMediaAsset[]>();
  private observer: MutationObserver | null = null;
  private scanTimeout: ReturnType<typeof setTimeout> | null = null;
  private knownVideos = new WeakSet<HTMLVideoElement>();
  private recentNetworkCandidates: NetworkMediaObservation[] = [];
  private readonly handleMediaLifecycleEvent = (event: Event): void => {
    if (event.target instanceof HTMLVideoElement) {
      if (event.type === "emptied") {
        this.capturedUrls.delete(event.target);
        this.mediaAssets.delete(event.target);
      }
      this.scheduleDOMScan();
    }
  };

  /**
   * Create a new DirectDetectionHandler instance
   * @param options - Configuration options
   */
  constructor(options: DirectDetectionHandlerOptions = {}) {
    this.onVideoDetected = options.onVideoDetected;
    this.getPageVideoId = options.getPageVideoId;
  }

  /**
   * Clean up all resources to prevent memory leaks
   */
  destroy(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.scanTimeout) {
      clearTimeout(this.scanTimeout);
      this.scanTimeout = null;
    }
    this.capturedUrls.clear();
    this.knownVideos = new WeakSet();
    this.mediaAssets = new WeakMap();
    this.recentNetworkCandidates = [];
    for (const eventName of MEDIA_LIFECYCLE_EVENTS) {
      document.removeEventListener(eventName, this.handleMediaLifecycleEvent, true);
    }
  }

  /**
   * Detect direct video from URL
   * @param url - Video URL to detect
   * @param videoElement - Optional video element for metadata extraction
   * @returns Promise resolving to VideoMetadata or null if not detected
   */
  async detect(
    url: string,
    videoElement?: HTMLVideoElement,
    observation?: NetworkMediaObservation,
  ): Promise<VideoMetadata | null> {
    // Check if URL is a direct video URL
    if (observation?.format !== VideoFormat.DIRECT && !this.isDirectVideoUrl(url)) {
      return null;
    }

    // Check if it's audio-only (skip it)
    if (this.isAudioOnlyUrl(url)) {
      console.log("[Media Sniper] Skipping audio-only URL:", redactSensitiveUrl(url));
      return null;
    }

    // Store captured URL if we have a video element
    if (videoElement) {
      this.capturedUrls.set(videoElement, url);
    }

    // Extract metadata
    let metadata = await this.extractMetadata(url, videoElement, observation);

    // A standalone adaptive segment is not useful. Only surface .m4s network
    // candidates when they can be bound to a page player; exact same-file HLS
    // manifests are independently promoted by the HLS detector.
    if (metadata?.isSelfContainedFmp4 && !videoElement) return null;

    if (metadata && videoElement) {
      const assets = mergeDirectMediaAssets(
        this.mediaAssets.get(videoElement),
        metadata.mediaAssets,
        [directMediaAssetFromMetadata(metadata)],
      );
      this.mediaAssets.set(videoElement, assets);
      metadata = applyBestDirectMediaAsset(metadata, assets);
      this.capturedUrls.set(videoElement, metadata.url);
    }

    if (metadata && this.onVideoDetected) {
      this.onVideoDetected(metadata);
    }

    return metadata;
  }

  /**
   * Handle network request for direct video
   * Associates URL with video elements and triggers detection
   */
  handleNetworkRequest(request: string | NetworkMediaObservation): void {
    const observation = typeof request === "string" ? undefined : request;
    const url = typeof request === "string" ? request : request.url;
    if (observation?.format !== VideoFormat.DIRECT && !this.isDirectVideoUrl(url)) return;
    if (this.isAudioOnlyUrl(url)) return;

    if (observation) this.rememberNetworkCandidate(observation);
    const video = observation ? this.findVideoForObservation(observation) : this.findSoleVideo();
    if (video) this.capturedUrls.set(video, url);
    void this.detect(url, video, observation);
  }

  /**
   * Detect video from video element
   * @private
   */
  private async detectFromVideoElement(
    video: HTMLVideoElement,
  ): Promise<VideoMetadata | null> {
    // First check if we have a captured URL for this video element
    const capturedUrl = this.capturedUrls.get(video);
    if (capturedUrl) {
      const candidate = this.recentNetworkCandidates.find(({ url }) => url === capturedUrl);
      return await this.detect(capturedUrl, video, candidate);
    }

    // Try to get URL from video element
    const url = this.getVideoUrl(video);
    if (!url) {
      const candidate = this.findNetworkCandidateForVideo(video);
      return candidate ? this.detect(candidate.url, video, candidate) : null;
    }

    // If it's a blob URL, we need a captured URL
    if (url.startsWith("blob:") || url.startsWith("data:")) {
      // Check if we have a captured URL
      const captured = this.capturedUrls.get(video);
      if (captured) {
        return await this.detect(captured, video);
      }
      const candidate = this.findNetworkCandidateForVideo(video);
      return candidate ? this.detect(candidate.url, video, candidate) : null;
    }

    return await this.detect(url, video);
  }

  /**
   * Scan DOM for video elements and trigger detection
   */
  async scanDOMForVideos(): Promise<void> {
    const videoElements = document.querySelectorAll("video");
    const readyVideos: HTMLVideoElement[] = [];

    for (const video of Array.from(videoElements)) {
      const vid = video as HTMLVideoElement;
      this.knownVideos.add(vid);

      const hasUrl = vid.currentSrc || vid.src || vid.querySelector("source") || vid.srcObject;
      if (vid.readyState === 0 && !hasUrl) {
        continue;
      }
      readyVideos.push(vid);
    }

    // Detect all ready videos in parallel
    const results = await Promise.allSettled(
      readyVideos.map((vid) => this.detectFromVideoElement(vid)),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        console.log("[Media Sniper] Detected video:", {
          url: redactSensitiveUrl(result.value.url),
          format: result.value.format,
          pageUrl: redactSensitiveUrl(result.value.pageUrl),
        });
      }
    }
  }

  /**
   * Set up MutationObserver to monitor DOM changes for dynamically added video elements
   */
  setupDOMObserver(): void {
    this.observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const mutation of mutations) {
        if (
          mutation.type === "attributes" &&
          (mutation.target instanceof HTMLVideoElement ||
            mutation.target instanceof HTMLSourceElement)
        ) {
          shouldScan = true;
          break;
        }
        for (const node of Array.from(mutation.addedNodes)) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as Element;
            if (element.tagName === "VIDEO" || element.querySelector("video")) {
              shouldScan = true;
              break;
            }
          }
        }
        if (shouldScan) break;
      }

      if (shouldScan) this.scheduleDOMScan();
    });

    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
    for (const eventName of MEDIA_LIFECYCLE_EVENTS) {
      document.addEventListener(eventName, this.handleMediaLifecycleEvent, true);
    }
  }

  private scheduleDOMScan(): void {
    if (this.scanTimeout) clearTimeout(this.scanTimeout);
    this.scanTimeout = setTimeout(() => {
      this.scanTimeout = null;
      void this.scanDOMForVideos();
    }, DOM_SCAN_DEBOUNCE_MS);
  }

  private rememberNetworkCandidate(candidate: NetworkMediaObservation): void {
    const cutoff = Date.now() - RECENT_NETWORK_CANDIDATE_TTL_MS;
    this.recentNetworkCandidates = this.recentNetworkCandidates
      .filter(({ observedAt, sourceKey }) => observedAt >= cutoff && sourceKey !== candidate.sourceKey);
    this.recentNetworkCandidates.push(candidate);
    if (this.recentNetworkCandidates.length > MAX_RECENT_NETWORK_CANDIDATES) {
      this.recentNetworkCandidates.splice(
        0,
        this.recentNetworkCandidates.length - MAX_RECENT_NETWORK_CANDIDATES,
      );
    }
  }

  private videoSourceUrls(video: HTMLVideoElement): string[] {
    return [
      video.currentSrc,
      video.src,
      ...[...video.querySelectorAll<HTMLSourceElement>("source")].map((source) => source.src),
    ].filter(Boolean);
  }

  private candidateMatchesVideo(
    candidate: NetworkMediaObservation,
    video: HTMLVideoElement,
  ): boolean {
    const aliases = new Set(candidate.redirectChain.map(normalizeUrl));
    return this.videoSourceUrls(video).some((url) => aliases.has(normalizeUrl(url)));
  }

  private findVideoForObservation(
    candidate: NetworkMediaObservation,
  ): HTMLVideoElement | undefined {
    const videos = [...document.querySelectorAll<HTMLVideoElement>("video")];
    videos.forEach((video) => this.knownVideos.add(video));
    const exact = videos.filter((video) => this.candidateMatchesVideo(candidate, video));
    if (exact.length === 1) return exact[0];
    return this.findSoleVideo(videos);
  }

  private findSoleVideo(
    videos = [...document.querySelectorAll<HTMLVideoElement>("video")],
  ): HTMLVideoElement | undefined {
    const active = videos.filter((video) => !video.paused && !video.ended);
    if (active.length === 1) return active[0];
    if (videos.length === 1) return videos[0];
    const visible = videos
      .map((video) => {
        const rect = video.getBoundingClientRect();
        const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
        const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
        return { video, visibleArea: width * height };
      })
      .filter(({ visibleArea }) => visibleArea > 0)
      .sort((left, right) => right.visibleArea - left.visibleArea);
    if (visible.length === 1 || (visible[0] && visible[0].visibleArea > (visible[1]?.visibleArea ?? 0))) {
      return visible[0]?.video;
    }
    return undefined;
  }

  private findNetworkCandidateForVideo(
    video: HTMLVideoElement,
  ): NetworkMediaObservation | undefined {
    const cutoff = Date.now() - RECENT_NETWORK_CANDIDATE_TTL_MS;
    this.recentNetworkCandidates = this.recentNetworkCandidates
      .filter(({ observedAt }) => observedAt >= cutoff);
    const exact = this.recentNetworkCandidates
      .filter((candidate) => this.candidateMatchesVideo(candidate, video));
    if (exact.length === 1) return exact[0];
    const videos = [...document.querySelectorAll<HTMLVideoElement>("video")];
    if (this.findSoleVideo(videos) !== video) return undefined;
    return this.recentNetworkCandidates.at(-1);
  }

  /**
   * Get video URL from video element
   * @private
   */
  private getVideoUrl(video: HTMLVideoElement): string | null {
    // Check currentSrc (what's actually playing)
    if (
      video.currentSrc &&
      !video.currentSrc.startsWith("blob:") &&
      !video.currentSrc.startsWith("data:")
    ) {
      return video.currentSrc;
    }

    // Check src attribute
    if (
      video.src &&
      !video.src.startsWith("blob:") &&
      !video.src.startsWith("data:")
    ) {
      return video.src;
    }

    // Check all source elements
    const sources = video.querySelectorAll("source");
    for (const sourceEl of Array.from(sources)) {
      const source = sourceEl as HTMLSourceElement;
      if (
        source.src &&
        !source.src.startsWith("blob:") &&
        !source.src.startsWith("data:")
      ) {
        return source.src;
      }
    }

    return null;
  }

  /**
   * Check if URL is a direct video URL
   * @private
   */
  private isDirectVideoUrl(url: string): boolean {
    return detectFormatFromUrl(url) === VideoFormat.DIRECT;
  }

  /**
   * Check if URL is audio-only (not a video track)
   * @private
   */
  private isAudioOnlyUrl(url: string): boolean {
    const lowerUrl = url.toLowerCase();

    const audioPatterns = [
      "/aud/",
      "/audio/",
      "/mp4a/",
      "/aac/",
      "/audio_track",
      "/sound/",
    ];

    if (audioPatterns.some((pattern) => lowerUrl.includes(pattern))) {
      return true;
    }

    // For Twitter/X amplify_video URLs
    if (lowerUrl.includes("amplify_video")) {
      if (lowerUrl.includes("/aud/")) {
        return true;
      }
      if (lowerUrl.includes("/vid/") || lowerUrl.includes("/video/")) {
        return false;
      }
    }

    return false;
  }

  /**
   * Extract metadata from direct video URL
   * @private
   */
  private async extractMetadata(
    url: string,
    videoElement?: HTMLVideoElement,
    observation?: NetworkMediaObservation,
  ): Promise<VideoMetadata | null> {
    const format = observation?.format ?? detectFormatFromUrl(url);
    const isSelfContainedFmp4 =
      hasM4sMediaHint(url) ||
      observation?.redirectChain.some(hasM4sMediaHint) === true;

    // Reject unknown formats
    if (format === VideoFormat.UNKNOWN) {
      return null;
    }

    const metadata: VideoMetadata = {
      url,
      format,
      pageUrl: window.location.href,
      title: document.title,
      sourceKey: observation?.sourceKey,
      sourceUrl: observation?.entryUrl,
      redirectChain: observation?.redirectChain,
      observedAt: observation?.observedAt,
      contentType: observation?.contentType,
      contentLength: observation?.contentLength,
      fileExtension: isSelfContainedFmp4 ? "mp4" : undefined,
      isSelfContainedFmp4: isSelfContainedFmp4 || undefined,
    };

    // Extract metadata from video element if available
    if (videoElement) {
      metadata.pageVideoId = this.getPageVideoId?.(videoElement);
      metadata.width = videoElement.videoWidth || undefined;
      metadata.height = videoElement.videoHeight || undefined;
      metadata.duration = videoElement.duration || undefined;

      if (metadata.width && metadata.height) {
        const height = metadata.height;
        if (height >= 2160) {
          metadata.resolution = "4K";
        } else if (height >= 1440) {
          metadata.resolution = "1440p";
        } else if (height >= 1080) {
          metadata.resolution = "1080p";
        } else if (height >= 720) {
          metadata.resolution = "720p";
        } else if (height >= 480) {
          metadata.resolution = "480p";
        } else {
          metadata.resolution = `${height}p`;
        }
      }

      // Extract thumbnail using unified utility
      const thumbnail = extractThumbnail(videoElement);
      if (thumbnail) {
        metadata.thumbnail = thumbnail;
      }

      // Try to find a more specific title from the page context
      if (
        !metadata.title ||
        metadata.title.trim().length === 0 ||
        metadata.title.includes(" - ") ||
        metadata.title.includes(" / ")
      ) {
        let container = videoElement.parentElement;
        let depth = 0;

        while (container && depth < MAX_HEADING_SEARCH_DEPTH) {
          const heading = container.querySelector("h1, h2, h3, h4, h5, h6");
          if (heading) {
            const headingText = heading.textContent?.trim();
            if (
              headingText &&
              headingText.length > 0 &&
              headingText.length < MAX_HEADING_TITLE_LENGTH
            ) {
              metadata.title = headingText;
              break;
            }
          }

          const ogTitle = document.querySelector('meta[property="og:title"]');
          if (ogTitle) {
            const ogTitleContent = (ogTitle as HTMLMetaElement).content?.trim();
            if (ogTitleContent && ogTitleContent.length > 0) {
              metadata.title = ogTitleContent;
              break;
            }
          }

          container = container.parentElement;
          depth++;
        }

        if (!metadata.title || metadata.title.trim().length === 0) {
          metadata.title = videoElement.getAttribute("title") || document.title;
        }
      }
    } else {
      // Extract thumbnail using unified utility (page-based search)
      const thumbnail = extractThumbnail();
      if (thumbnail) {
        metadata.thumbnail = thumbnail;
      }
    }

    metadata.mediaAssets = [directMediaAssetFromMetadata(metadata)];

    return metadata;
  }
}
