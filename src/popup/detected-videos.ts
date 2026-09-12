import { VideoFormat, type VideoMetadata } from "../core/types";
import { normalizeUrl } from "../core/utils/url-utils";
import {
  applyBestDirectMediaAsset,
  directMediaAssetFromMetadata,
  mergeDirectMediaAssets,
} from "../core/media/direct-media-assets";

type DetectedVideos = Record<string, VideoMetadata>;

const LEGACY_ENRICHMENT_FIELDS = [
  "title",
  "thumbnail",
  "resolution",
  "width",
  "height",
  "duration",
] as const satisfies readonly (keyof VideoMetadata)[];

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function copyWhenMissing<K extends keyof VideoMetadata>(
  target: VideoMetadata,
  observation: VideoMetadata,
  field: K,
): boolean {
  if (hasValue(target[field]) || !hasValue(observation[field])) return false;
  target[field] = observation[field];
  return true;
}

function enrichMissingMetadata(
  target: VideoMetadata,
  observation: VideoMetadata,
): boolean {
  let changed = false;
  for (const field of LEGACY_ENRICHMENT_FIELDS) {
    changed = copyWhenMissing(target, observation, field) || changed;
  }
  return changed;
}

function sourceEntry(
  videos: DetectedVideos,
  sourceKey: string,
): [string, VideoMetadata] | undefined {
  return Object.entries(videos).find(([, video]) => video.sourceKey === sourceKey);
}

function aliases(video: VideoMetadata): Set<string> {
  return new Set(
    [video.url, video.sourceUrl, ...(video.redirectChain ?? [])]
      .filter((url): url is string => Boolean(url))
      .map(normalizeUrl),
  );
}

function aliasEntry(
  videos: DetectedVideos,
  observation: VideoMetadata,
): [string, VideoMetadata] | undefined {
  const observationAliases = aliases(observation);
  return Object.entries(videos).find(([, video]) =>
    [...aliases(video)].some((alias) => observationAliases.has(alias)));
}

function pageVideoEntry(
  videos: DetectedVideos,
  observation: VideoMetadata,
): [string, VideoMetadata] | undefined {
  if (observation.format !== VideoFormat.DIRECT || !observation.pageVideoId) {
    return undefined;
  }
  return Object.entries(videos).find(([, video]) =>
    video.format === VideoFormat.DIRECT &&
    video.pageVideoId === observation.pageVideoId);
}

function observationIsCurrent(
  existing: VideoMetadata,
  observation: VideoMetadata,
): boolean {
  if (existing.observedAt === undefined || observation.observedAt === undefined) {
    // Without comparable timestamps, preserve the existing arrival-order behavior.
    return true;
  }
  return observation.observedAt >= existing.observedAt;
}

/**
 * Adds or updates a popup detection while keeping actionable normalized URLs as
 * the record keys. A sourceKey supplies stable identity across expiring URLs.
 */
export function upsertDetectedVideo(
  videos: DetectedVideos,
  observation: VideoMetadata,
): boolean {
  const actionableKey = normalizeUrl(observation.url);

  // Preserve the original normalized-URL-only behavior for legacy detections.
  if (!observation.sourceKey) {
    const existing = videos[actionableKey];
    if (!existing) {
      videos[actionableKey] = observation;
      return true;
    }
    return enrichMissingMetadata(existing, observation);
  }

  const matched = sourceEntry(videos, observation.sourceKey)
    ?? pageVideoEntry(videos, observation)
    ?? (videos[actionableKey] ? [actionableKey, videos[actionableKey]] : undefined)
    ?? aliasEntry(videos, observation);
  if (!matched) {
    videos[actionableKey] = observation;
    return true;
  }

  const [existingKey, existing] = matched;
  if (!observationIsCurrent(existing, observation)) {
    return enrichMissingMetadata(existing, observation);
  }

  // The latest transport data is authoritative, while absent metadata is
  // retained from earlier (often richer DOM) observations.
  let merged = { ...existing, ...observation };
  enrichMissingMetadata(merged, existing);
  if (
    existing.format === VideoFormat.DIRECT &&
    observation.format === VideoFormat.DIRECT
  ) {
    const assets = mergeDirectMediaAssets(
      existing.mediaAssets,
      observation.mediaAssets,
      [directMediaAssetFromMetadata(existing), directMediaAssetFromMetadata(observation)],
    );
    merged = applyBestDirectMediaAsset(merged, assets);
  }

  const mergedKey = normalizeUrl(merged.url);

  const keyChanged = existingKey !== mergedKey;
  const valueChanged = Object.keys(merged).some((key) =>
    merged[key as keyof VideoMetadata] !== existing[key as keyof VideoMetadata]);
  if (!keyChanged && !valueChanged) return false;

  if (keyChanged) delete videos[existingKey];
  videos[mergedKey] = merged;
  return true;
}

export function detectedVideoKeyForRemoval(
  videos: DetectedVideos,
  observation: Pick<VideoMetadata, "url" | "sourceKey">,
): string {
  if (observation.sourceKey) {
    const matched = sourceEntry(videos, observation.sourceKey);
    if (matched) return matched[0];
  }
  return normalizeUrl(observation.url);
}
