/**
 * Content script for video detection
 * Intercepts network requests, scans DOM for video elements, and sends detected videos to popup
 */

import { MessageType } from "./shared/messages";
import { VideoMetadata, VideoFormat, StorageConfig } from "./core/types";
import { DetectionManager } from "./core/detection/detection-manager";
import { normalizeUrl } from "./core/utils/url-utils";
import { logger } from "./core/utils/logger";
import { PlaybackRegistry } from "./core/playback/registry";
import { ClipOverlayController } from "./core/playback/clip-overlay";
import {
  redactSensitiveUrl,
  type NetworkMediaObservation,
} from "./core/detection/network-media";
import {
  DEFAULT_CLIP_MODE,
  DEFAULT_CLIP_OVERLAY_ENABLED,
  STORAGE_CONFIG_KEY,
} from "./shared/constants";
import {
  applyBestDirectMediaAsset,
  directMediaAssetFromMetadata,
  mergeDirectMediaAssets,
} from "./core/media/direct-media-assets";

let detectedVideos: Record<string, VideoMetadata> = {};
let detectionManager: DetectionManager;
let sentToPopup = new Set<string>();
let lastUrl = location.href;
let recoveredStartupNetworkMedia = false;
const inIframe = window.self !== window.top;
const playbackRegistry = new PlaybackRegistry();

function detectedVideoKey(video: VideoMetadata): string {
  if (video.format === VideoFormat.DIRECT && video.pageVideoId) {
    return `direct:${video.pageVideoId}`;
  }
  return video.sourceKey ?? normalizeUrl(video.url);
}

function detectedVideoAliases(video: VideoMetadata): Set<string> {
  return new Set(
    [video.url, video.sourceUrl, ...(video.redirectChain ?? [])]
      .filter((url): url is string => Boolean(url))
      .map(normalizeUrl),
  );
}

function matchingDetectedVideo(
  video: VideoMetadata,
): [string, VideoMetadata] | undefined {
  const directKey = detectedVideoKey(video);
  if (detectedVideos[directKey]) return [directKey, detectedVideos[directKey]];
  if (video.sourceKey) {
    const sourceMatch = Object.entries(detectedVideos).find(
      ([, existing]) => existing.sourceKey === video.sourceKey,
    );
    if (sourceMatch) return sourceMatch;
  }
  if (video.format === VideoFormat.DIRECT && video.pageVideoId) {
    const elementMatch = Object.entries(detectedVideos).find(
      ([, existing]) =>
        existing.format === VideoFormat.DIRECT &&
        existing.pageVideoId === video.pageVideoId,
    );
    if (elementMatch) return elementMatch;
  }
  const aliases = detectedVideoAliases(video);
  return Object.entries(detectedVideos).find(([, existing]) =>
    [...detectedVideoAliases(existing)].some((alias) => aliases.has(alias)));
}

function requestRuntimeMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

async function openExtensionUi(): Promise<void> {
  const actionApi = (chrome as typeof chrome & {
    action?: { openPopup?: () => Promise<void> };
  }).action;
  if (actionApi?.openPopup) {
    try {
      await actionApi.openPopup();
      return;
    } catch {
      // Fall back to the options page when this Chrome context cannot open the action.
    }
  }
  await chrome.runtime.openOptionsPage();
}

const clipOverlay = new ClipOverlayController({
  registry: playbackRegistry,
  sendMessage: requestRuntimeMessage,
  openExtensionUi,
  isCandidateEligible: (candidate) => {
    const associated = Object.values(detectedVideos)
      .filter((video) => video.pageVideoId === candidate.pageVideoId);
    return !associated.some((video) =>
      video.hasDrm || video.unsupported || video.format === VideoFormat.UNKNOWN);
  },
});

/**
 * Send message to popup with error handling for extension context invalidation
 */
function safeSendMessage(message: any): Promise<void> {
  return new Promise((resolve) => {
    if (!chrome?.runtime?.sendMessage) {
      console.debug("Chrome runtime not available");
      resolve();
      return;
    }

    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        const errorMessage = chrome.runtime.lastError.message || "";
        if (errorMessage.includes("Extension context invalidated")) {
          console.debug("Extension context invalidated");
        }
        resolve();
        return;
      }
      resolve();
    });
  });
}

/**
 * Remove detected video and notify popup
 */
function removeDetectedVideo(url: string): void {
  const normalizedUrl = normalizeUrl(url);
  const key = Object.entries(detectedVideos).find(([, video]) =>
    normalizeUrl(video.url) === normalizedUrl)?.[0] ?? normalizedUrl;

  if (detectedVideos[key]) {
    delete detectedVideos[key];
    sentToPopup.delete(key);

    logger.info("[Media Sniper] Removed detected video", {
      url: redactSensitiveUrl(normalizedUrl),
    });

    // Notify popup about removal
    safeSendMessage({
      type: MessageType.VIDEO_REMOVED,
      payload: { url: normalizedUrl },
    });
  }
}

function removeRecycledVideoAssets(event: Event): void {
  if (!(event.target instanceof HTMLVideoElement)) return;
  const pageVideoId = playbackRegistry.register(event.target);
  const stale = Object.values(detectedVideos)
    .filter((video) => video.pageVideoId === pageVideoId)
    .map((video) => video.url);
  stale.forEach(removeDetectedVideo);
}

// Infinite feeds commonly reuse one <video> node for a different post. Drop
// the old asset family when the player is emptied so qualities from two clips
// cannot be ranked together.
document.addEventListener("emptied", removeRecycledVideoAssets, true);

/**
 * Add or update detected video and notify popup
 * Uses normalized URL as unique key to prevent duplicates
 */
function addDetectedVideo(video: VideoMetadata) {
  // Reject unknown formats - don't show them in UI
  if (video.format === VideoFormat.UNKNOWN) {
    return;
  }

  video.pageVideoId ??= playbackRegistry.findPageVideoId(video.sourceUrl ?? video.url);
  if (video.format === VideoFormat.DIRECT) {
    Object.assign(video, applyBestDirectMediaAsset(video, [
      directMediaAssetFromMetadata(video),
    ]));
  }
  const matched = matchingDetectedVideo(video);
  const key = detectedVideoKey(video);
  const existing = matched?.[1];

  logger.debug("[Media Sniper] detected media", redactSensitiveUrl(video.url));

  // Change icon to blue when video is detected
  safeSendMessage({
    type: MessageType.SET_ICON_BLUE,
  });

  if (existing) {
    let updated = false;
    const groupedDirect =
      existing.format === VideoFormat.DIRECT &&
      video.format === VideoFormat.DIRECT &&
      Boolean(existing.pageVideoId && existing.pageVideoId === video.pageVideoId);
    if (matched[0] !== key) {
      delete detectedVideos[matched[0]];
      detectedVideos[key] = existing;
      sentToPopup.delete(matched[0]);
      sentToPopup.add(key);
      updated = true;
    }

    if (groupedDirect) {
      const previousUrl = existing.url;
      const previousAssets = JSON.stringify(existing.mediaAssets ?? []);
      const mergedAssets = mergeDirectMediaAssets(
        existing.mediaAssets,
        video.mediaAssets,
        [directMediaAssetFromMetadata(existing), directMediaAssetFromMetadata(video)],
      );
      Object.assign(existing, applyBestDirectMediaAsset(existing, mergedAssets));
      updated = previousUrl !== existing.url || previousAssets !== JSON.stringify(mergedAssets);
    }
    logger.debug("[Media Sniper] Updating detected media metadata", {
      sourceKey: key,
      url: redactSensitiveUrl(video.url),
    });

    if (
      video.title === document.title ||
      !existing.title ||
      existing.title.trim().length === 0
    ) {
      existing.title = video.title || document.title;
      updated = true;
    }

    if (!existing.thumbnail && video.thumbnail) {
      existing.thumbnail = video.thumbnail;
      updated = true;
    }
    if (!existing.width && video.width) {
      existing.width = video.width;
      updated = true;
    }
    if (!existing.height && video.height) {
      existing.height = video.height;
      updated = true;
    }
    if (!existing.duration && video.duration) {
      existing.duration = video.duration;
      updated = true;
    }
    if (!existing.resolution && video.resolution) {
      existing.resolution = video.resolution;
      updated = true;
    }

    if (
      !groupedDirect &&
      video.url !== existing.url &&
      !video.url.startsWith("blob:") &&
      !video.url.startsWith("data:") &&
      (video.observedAt ?? 0) >= (existing.observedAt ?? 0)
    ) {
      existing.url = video.url;
      existing.format = video.format;
      updated = true;
    }

    if (!groupedDirect && (video.observedAt ?? 0) >= (existing.observedAt ?? 0)) {
      existing.observedAt = video.observedAt ?? existing.observedAt;
      existing.sourceUrl = video.sourceUrl ?? existing.sourceUrl;
      existing.redirectChain = video.redirectChain ?? existing.redirectChain;
      existing.contentType = video.contentType ?? existing.contentType;
      existing.sourceKey = video.sourceKey ?? existing.sourceKey;
    }

    if (video.pageUrl !== existing.pageUrl) {
      existing.pageUrl = video.pageUrl;
      updated = true;
    }

    if (!existing.pageVideoId && video.pageVideoId) {
      existing.pageVideoId = video.pageVideoId;
      updated = true;
    }

    // Only notify popup if metadata was actually updated
    // This prevents unnecessary updates that could cause flickering
    if (updated) {
      safeSendMessage({
        type: MessageType.VIDEO_DETECTED,
        payload: existing,
      });
    }

    return;
  }

  detectedVideos[key] = video;

  if (!sentToPopup.has(key)) {
    sentToPopup.add(key);
    safeSendMessage({
      type: MessageType.VIDEO_DETECTED,
      payload: video,
    });
  }
}

/**
 * Initialize content script
 * Sets up detection manager, performs initial scan, and monitors DOM changes
 */
async function init() {
  playbackRegistry.start();

  // Reset icon to gray on page load (only from top frame)
  if (!inIframe) {
    safeSendMessage({
      type: MessageType.SET_ICON_GRAY,
    });
  }

  const stored = await chrome.storage.local.get(STORAGE_CONFIG_KEY);
  const config: StorageConfig | undefined = stored[STORAGE_CONFIG_KEY];
  clipOverlay.setDefaultMode(config?.clipping?.defaultMode ?? DEFAULT_CLIP_MODE);
  clipOverlay.setEnabled(
    config?.clipping?.overlayEnabled ?? DEFAULT_CLIP_OVERLAY_ENABLED,
  );

  detectionManager = new DetectionManager({
    onVideoDetected: (video) => {
      addDetectedVideo(video);
    },
    onVideoRemoved: (url) => {
      removeDetectedVideo(url);
    },
    detectionCacheSize: config?.advanced?.detectionCacheSize,
    masterPlaylistCacheSize: config?.advanced?.masterPlaylistCacheSize,
    getPageVideoId: (video) => playbackRegistry.register(video),
  });

  // Initialize all detection mechanisms
  detectionManager.init();

  if (!recoveredStartupNetworkMedia) {
    recoveredStartupNetworkMedia = true;
    try {
      const response = await requestRuntimeMessage({
        type: MessageType.GET_RECENT_NETWORK_MEDIA,
      }) as { candidates?: NetworkMediaObservation[] } | undefined;
      response?.candidates?.forEach((candidate) =>
        detectionManager.handleNetworkRequest(candidate));
    } catch {
      // The worker may be restarting; live webRequest observations will still arrive.
    }
  }
}

function handleClipOverlaySettingsChange(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
): void {
  if (areaName !== "local" || !changes[STORAGE_CONFIG_KEY]) return;
  const config = changes[STORAGE_CONFIG_KEY].newValue as StorageConfig | undefined;
  clipOverlay.setDefaultMode(config?.clipping?.defaultMode ?? DEFAULT_CLIP_MODE);
  clipOverlay.setEnabled(
    config?.clipping?.overlayEnabled ?? DEFAULT_CLIP_OVERLAY_ENABLED,
  );
}

chrome.storage.onChanged.addListener(handleClipOverlaySettingsChange);

function cleanupClipOverlay(event: PageTransitionEvent): void {
  if (event.persisted) return;
  clipOverlay.destroy();
  chrome.storage.onChanged.removeListener(handleClipOverlaySettingsChange);
  document.removeEventListener("emptied", removeRecycledVideoAssets, true);
  window.removeEventListener("pagehide", cleanupClipOverlay);
}

window.addEventListener("pagehide", cleanupClipOverlay);

/**
 * Handle SPA navigation by resetting detection state
 * Covers pushState/replaceState (popstate) and Navigation API
 */
function handleNavigation(): void {
  const currentUrl = location.href;
  if (currentUrl === lastUrl) return;
  lastUrl = currentUrl;

  logger.info("[Media Sniper] SPA navigation detected, resetting detection");

  // Clean up old detection resources
  if (detectionManager) {
    detectionManager.destroy();
  }

  // Reset state
  detectedVideos = {};
  sentToPopup = new Set<string>();

  // Re-initialize
  playbackRegistry.scan();
  init();
}

// Listen for SPA navigations (History API) — only in top frame
if (!inIframe) {
  window.addEventListener("popstate", handleNavigation);

  // Intercept pushState/replaceState since they don't fire popstate
  const origPushState = history.pushState.bind(history);
  const origReplaceState = history.replaceState.bind(history);
  history.pushState = function (...args) {
    origPushState(...args);
    handleNavigation();
  };
  history.replaceState = function (...args) {
    origReplaceState(...args);
    handleNavigation();
  };
}

/**
 * Listen for messages from popup and service worker
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Check if extension context is still valid
  if (chrome.runtime.lastError) {
    const errorMessage = chrome.runtime.lastError.message || "";
    if (errorMessage.includes("Extension context invalidated")) {
      console.debug("Extension context invalidated");
      return false;
    }
    console.debug("Extension context error:", errorMessage);
    return false;
  }

  try {
    if (message.type === MessageType.GET_PLAYBACK_CANDIDATES) {
      sendResponse({ candidates: playbackRegistry.getCandidates(location.href) });
      return false;
    }

    if (message.type === MessageType.GET_DETECTED_VIDEOS) {
      // Convert Record to array for response
      sendResponse({ videos: Object.values(detectedVideos) });
      return true; // Keep channel open for async response
    }

    if (message.type === MessageType.NETWORK_URL_DETECTED) {
      // Handle response-aware media evidence from the service worker.
      const candidate = message.payload as NetworkMediaObservation | undefined;
      if (candidate?.url && detectionManager) {
        detectionManager.handleNetworkRequest(candidate);
      }
      return false; // No response needed
    }

    return false;
  } catch (error) {
    console.debug("Error handling message:", error);
    return false;
  }
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
