import { ClippingError } from "./errors";
import { formatTimeForFilename } from "./time";

const DEFAULT_MAX_BASE_LENGTH = 180;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export interface ClipFilenameOptions {
  title?: string;
  startMs: number;
  endMs: number;
  quality?: string;
  outputContainer?: string;
  suppliedFilename?: string;
  maxBaseLength?: number;
}

function sanitizeExtension(extension: string): string {
  const sanitized = extension.replace(/^\.+/, "").toLowerCase();
  if (!/^[a-z0-9]{1,10}$/.test(sanitized)) {
    throw new TypeError("Output container must be a short alphanumeric extension");
  }
  return sanitized;
}

export function sanitizeClipFilenamePart(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[\s._-]+|[\s._-]+$/g, "");

  return WINDOWS_RESERVED_NAME.test(normalized) ? `_${normalized}` : normalized;
}

function truncateBase(base: string, maxLength: number): string {
  const truncated = base.slice(0, maxLength).replace(/[\s._-]+$/g, "");
  return truncated || "clip";
}

function suppliedBaseName(filename: string): string {
  const parts = filename.split(/[/\\]/);
  const leaf = parts[parts.length - 1] ?? "";
  const lastDot = leaf.lastIndexOf(".");
  return lastDot > 0 ? leaf.slice(0, lastDot) : leaf;
}

/** Generate a deterministic, filesystem-safe clip filename. */
export function generateClipFilename(options: ClipFilenameOptions): string {
  const {
    startMs,
    endMs,
    suppliedFilename,
    quality,
    maxBaseLength = DEFAULT_MAX_BASE_LENGTH,
  } = options;

  if (!Number.isSafeInteger(maxBaseLength) || maxBaseLength < 16) {
    throw new TypeError("maxBaseLength must be an integer of at least 16 characters");
  }
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs) {
    throw new ClippingError("INVALID_CLIP_RANGE", "A valid integer clip range is required for a filename");
  }

  const extension = sanitizeExtension(options.outputContainer ?? "mp4");

  if (suppliedFilename?.trim()) {
    const suppliedBase = sanitizeClipFilenamePart(suppliedBaseName(suppliedFilename));
    return `${truncateBase(suppliedBase || "clip", maxBaseLength)}.${extension}`;
  }

  const title = sanitizeClipFilenamePart(options.title ?? "") || "clip";
  const range = `${formatTimeForFilename(startMs)}-${formatTimeForFilename(endMs)}`;
  const qualityPart = quality ? sanitizeClipFilenamePart(quality) : "";
  const suffix = `_${range}${qualityPart ? `_${qualityPart}` : ""}`;
  const titleBudget = Math.max(1, maxBaseLength - suffix.length);
  const base = `${truncateBase(title, titleBudget)}${suffix}`;

  return `${truncateBase(base, maxBaseLength)}.${extension}`;
}
