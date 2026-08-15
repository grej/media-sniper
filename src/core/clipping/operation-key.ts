import { ClippingError } from "./errors";
import type {
  ManifestQualitySelection,
  OperationKeyInput,
} from "./types";

const OPERATION_KEY_VERSION = 1;

function normalizeUrlForIdentity(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    const hashIndex = value.indexOf("#");
    return hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  }
}

function normalizedQuality(
  quality?: string | ManifestQualitySelection,
): string | Record<string, string | number | null> | undefined {
  if (typeof quality === "string") return quality.trim() || undefined;
  if (!quality) return undefined;

  const normalized: Record<string, string | number | null> = {};
  if (quality.qualityKey) normalized.qualityKey = quality.qualityKey;
  if (quality.videoPlaylistUrl !== undefined) {
    normalized.videoPlaylistUrl = quality.videoPlaylistUrl
      ? normalizeUrlForIdentity(quality.videoPlaylistUrl)!
      : null;
  }
  if (quality.audioPlaylistUrl !== undefined) {
    normalized.audioPlaylistUrl = quality.audioPlaylistUrl
      ? normalizeUrlForIdentity(quality.audioPlaylistUrl)!
      : null;
  }
  if (quality.selectedBandwidth !== undefined) {
    normalized.selectedBandwidth = quality.selectedBandwidth;
  }
  if (quality.representationId) normalized.representationId = quality.representationId;
  if (quality.label) normalized.label = quality.label;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Build a stable duplicate-detection key. It intentionally retains query
 * parameters because signed URLs and other request context can affect access.
 */
export function createOperationKey(input: OperationKeyInput): string {
  const url = normalizeUrlForIdentity(input.url);
  if (!url) throw new TypeError("Operation URL is required");

  if (input.kind === "clip" && !input.clip) {
    throw new ClippingError("INVALID_CLIP_RANGE", "Clip operation identity requires a ClipSpec");
  }

  const clip = input.clip
    ? {
        startMs: input.clip.startMs,
        endMs: input.clip.endMs,
        mode: input.mode ?? input.clip.mode,
      }
    : undefined;

  if (
    clip &&
    (!Number.isSafeInteger(clip.startMs) ||
      !Number.isSafeInteger(clip.endMs) ||
      clip.startMs < 0 ||
      clip.endMs <= clip.startMs)
  ) {
    throw new ClippingError("INVALID_CLIP_RANGE", "Operation identity received an invalid clip range");
  }

  const canonical = {
    version: OPERATION_KEY_VERSION,
    url,
    kind: input.kind,
    clip,
    quality: normalizedQuality(input.quality),
    outputContainer: (input.outputContainer ?? "mp4").replace(/^\./, "").toLowerCase(),
    pageUrl: normalizeUrlForIdentity(input.pageUrl),
    referrer: normalizeUrlForIdentity(input.referrer),
  };

  return `media-operation:${stableSerialize(canonical)}`;
}

export const operationKey = createOperationKey;
