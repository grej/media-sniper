import { VideoFormat } from "../types";
import { detectFormatFromUrl } from "../utils/url-utils";

export interface NetworkRequestEvidence {
  requestId: string;
  url: string;
  tabId: number;
  frameId: number;
  documentId?: string;
  resourceType: string;
  initiator?: string;
  observedAt?: number;
}

export interface NetworkRedirectEvidence extends NetworkRequestEvidence {
  redirectUrl: string;
  statusCode: number;
}

export interface NetworkResponseEvidence extends NetworkRequestEvidence {
  statusCode: number;
  responseHeaders?: Record<string, string>;
}

export interface NetworkMediaObservation {
  url: string;
  entryUrl: string;
  redirectChain: string[];
  sourceKey: string;
  documentId?: string;
  format: VideoFormat;
  statusCode: number;
  resourceType: string;
  contentType?: string;
  contentRange?: string;
  contentLength?: number;
  initiator?: string;
  observedAt: number;
}

interface RedirectChainRecord {
  urls: string[];
  updatedAt: number;
}

const VIDEO_FILE_HINT = /\.(?:mp4|m4v|webm|mov|avi|mkv|flv|wmv|ogv|ogg)(?:[^a-z0-9]|$)/i;
const VIDEO_PATH_SUFFIX = /\.(?:mp4|m4v|webm|mov|avi|mkv|flv|wmv|ogv|ogg)$/i;
const IMAGE_PATH_SUFFIX = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;
const SEGMENT_PATH_SUFFIX = /\.(?:m4s|cmf[av]|ts)(?:$|[?#])/i;
const SEGMENT_CONTENT_TYPES = new Set(["video/mp2t", "video/iso.segment"]);
const SENSITIVE_QUERY_KEY = /(?:^|[-_])(?:auth|acc|access|account)?token(?:$|[-_])|(?:^|[-_])(?:sig|signature|expires?|rnd|file)(?:$|[-_])/i;

function appendUnique(urls: string[], url: string): void {
  if (urls[urls.length - 1] !== url) urls.push(url);
}

function normalizedContentType(headers?: Record<string, string>): string {
  return headers?.["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function contentDispositionHasVideo(headers?: Record<string, string>): boolean {
  return VIDEO_FILE_HINT.test(headers?.["content-disposition"] ?? "");
}

function decodedMediaHint(value: string): boolean {
  let decoded = value;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (VIDEO_FILE_HINT.test(decoded)) return true;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return VIDEO_FILE_HINT.test(decoded);
}

function hasProxyMediaHint(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.toLowerCase().endsWith("/remote_control.php")) return true;
    return [...parsed.searchParams.entries()].some(([key, value]) =>
      key.toLowerCase() === "file" && decodedMediaHint(value));
  } catch {
    return /remote_control\.php/i.test(url) || decodedMediaHint(url);
  }
}

function hasTerminalImagePath(url: string): boolean {
  try {
    return IMAGE_PATH_SUFFIX.test(new URL(url).pathname);
  } catch {
    return IMAGE_PATH_SUFFIX.test(url.split(/[?#]/, 1)[0] ?? url);
  }
}

function hasDirectVideoPath(url: string): boolean {
  try {
    return VIDEO_PATH_SUFFIX.test(new URL(url).pathname);
  } catch {
    return VIDEO_PATH_SUFFIX.test(url.split(/[?#]/, 1)[0] ?? url);
  }
}

function stableProxyFileIdentity(url: string): string | undefined {
  try {
    const proxyUrl = new URL(url);
    const file = proxyUrl.searchParams.get("file");
    if (!file) return undefined;

    let decoded = file;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      } catch {
        break;
      }
    }

    const relativeBase = new URL("https://media-sniper.invalid/");
    const mediaUrl = new URL(decoded, relativeBase);
    if (!hasDirectVideoPath(mediaUrl.href)) return undefined;
    mediaUrl.hash = "";
    for (const key of [...mediaUrl.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) mediaUrl.searchParams.delete(key);
    }
    mediaUrl.searchParams.sort();

    if (mediaUrl.origin === relativeBase.origin) {
      return `${mediaUrl.pathname}${mediaUrl.search}`;
    }
    return `${mediaUrl.origin}${mediaUrl.pathname}${mediaUrl.search}`;
  } catch {
    return undefined;
  }
}

function looksLikeAdaptiveMp4Fragment(url: string): boolean {
  try {
    const filename = new URL(url).pathname.split("/").pop() ?? "";
    if (!filename.toLowerCase().endsWith(".mp4")) return false;
    const stem = filename.slice(0, -4);
    return /^\d+$/.test(stem) ||
      /(?:^|[-_.])(?:init|segment|seg|chunk|fragment|frag|part)(?:$|[-_.\d])/i.test(stem);
  } catch {
    return false;
  }
}

function formatFromContentType(contentType: string): VideoFormat {
  if (
    contentType === "application/vnd.apple.mpegurl" ||
    contentType === "application/x-mpegurl" ||
    contentType === "audio/mpegurl" ||
    contentType === "audio/x-mpegurl"
  ) {
    return VideoFormat.HLS;
  }
  if (contentType === "application/dash+xml") return VideoFormat.DASH;
  if (contentType.startsWith("video/")) return VideoFormat.DIRECT;
  return VideoFormat.UNKNOWN;
}

function isDocumentOrErrorContentType(contentType: string): boolean {
  return contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType.endsWith("+json") ||
    contentType === "application/xml" ||
    contentType.endsWith("+xml") ||
    contentType === "application/pdf" ||
    contentType === "application/zip" ||
    contentType === "application/problem+json";
}

function isGenericBinaryContentType(contentType: string): boolean {
  return contentType === "" ||
    contentType === "application/octet-stream" ||
    contentType === "binary/octet-stream" ||
    contentType === "application/binary";
}

/**
 * Classify a response using URL, redirect, resource-type, and response-header
 * evidence. A 206 alone is deliberately insufficient because images, PDFs,
 * and archives also use byte ranges.
 */
export function classifyNetworkMediaResponse(
  evidence: NetworkResponseEvidence,
  redirectChain: readonly string[] = [],
): VideoFormat {
  if (evidence.statusCode < 200 || evidence.statusCode >= 300) {
    return VideoFormat.UNKNOWN;
  }

  const contentType = normalizedContentType(evidence.responseHeaders);
  const contentFormat = formatFromContentType(contentType);
  if (contentFormat === VideoFormat.HLS || contentFormat === VideoFormat.DASH) {
    return contentFormat;
  }
  if (contentType.startsWith("image/") || contentType.startsWith("audio/")) {
    return VideoFormat.UNKNOWN;
  }
  if (hasTerminalImagePath(evidence.url)) return VideoFormat.UNKNOWN;
  if (SEGMENT_PATH_SUFFIX.test(evidence.url)) return VideoFormat.UNKNOWN;
  if (SEGMENT_CONTENT_TYPES.has(contentType)) return VideoFormat.UNKNOWN;

  const urlFormat = detectFormatFromUrl(evidence.url);
  if (urlFormat === VideoFormat.HLS || urlFormat === VideoFormat.DASH) return urlFormat;
  if (isDocumentOrErrorContentType(contentType)) return VideoFormat.UNKNOWN;
  if (urlFormat === VideoFormat.DIRECT && hasDirectVideoPath(evidence.url)) {
    if (
      evidence.resourceType !== "media" &&
      looksLikeAdaptiveMp4Fragment(evidence.url)
    ) {
      return VideoFormat.UNKNOWN;
    }
    return VideoFormat.DIRECT;
  }
  if (contentDispositionHasVideo(evidence.responseHeaders)) return VideoFormat.DIRECT;

  const ancestorFormats = redirectChain.map(detectFormatFromUrl);
  const directAncestor = redirectChain.some(hasDirectVideoPath);
  const hlsAncestor = ancestorFormats.includes(VideoFormat.HLS);
  const dashAncestor = ancestorFormats.includes(VideoFormat.DASH);
  if (hlsAncestor && isGenericBinaryContentType(contentType)) return VideoFormat.HLS;
  if (dashAncestor && isGenericBinaryContentType(contentType)) return VideoFormat.DASH;

  const partial = evidence.statusCode === 206 &&
    /^bytes\s+/i.test(evidence.responseHeaders?.["content-range"] ?? "");
  const isMediaRequest = evidence.resourceType === "media";
  const proxyHint = hasProxyMediaHint(evidence.url);

  if (
    contentFormat === VideoFormat.DIRECT &&
    (isMediaRequest || directAncestor || (partial && proxyHint))
  ) {
    return VideoFormat.DIRECT;
  }
  if (!isGenericBinaryContentType(contentType)) return VideoFormat.UNKNOWN;
  if (directAncestor && (isMediaRequest || partial)) return VideoFormat.DIRECT;
  if (isMediaRequest && partial && proxyHint) return VideoFormat.DIRECT;

  return VideoFormat.UNKNOWN;
}

function sourceIdentity(url: string, format: VideoFormat): string {
  try {
    const parsed = new URL(url);
    const proxyFileIdentity = stableProxyFileIdentity(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.delete(key);
    }
    if (proxyFileIdentity) parsed.searchParams.set("file", proxyFileIdentity);
    parsed.searchParams.sort();
    return `${format}:${parsed.href}`;
  } catch {
    return `${format}:${url.split(/[?#]/, 1)[0]}`;
  }
}

export function mediaSourceKey(
  urls: readonly string[],
  format: VideoFormat,
): string {
  const identified = urls.find((url) => detectFormatFromUrl(url) === format);
  return sourceIdentity(identified ?? urls[0] ?? "unknown", format);
}

export function redactSensitiveUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.set(key, "[redacted]");
    }
    return parsed.href;
  } catch {
    return url.replace(/([?&](?:[^=&]*(?:token|signature|sig|expires|rnd|file)[^=&]*)=)[^&#]*/gi, "$1[redacted]");
  }
}

function parseContentLength(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export class NetworkMediaRequestTracker {
  private readonly chains = new Map<string, RedirectChainRecord>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly maxChains = 500,
  ) {}

  recordRequest(evidence: NetworkRequestEvidence): void {
    this.prune(evidence.observedAt);
    const observedAt = evidence.observedAt ?? Date.now();
    const record = this.chains.get(evidence.requestId) ?? { urls: [], updatedAt: observedAt };
    appendUnique(record.urls, evidence.url);
    record.updatedAt = observedAt;
    this.chains.set(evidence.requestId, record);
    this.trim();
  }

  recordRedirect(evidence: NetworkRedirectEvidence): void {
    this.recordRequest(evidence);
    const record = this.chains.get(evidence.requestId)!;
    appendUnique(record.urls, evidence.redirectUrl);
    record.updatedAt = evidence.observedAt ?? Date.now();
  }

  observeResponse(evidence: NetworkResponseEvidence): NetworkMediaObservation | null {
    this.prune(evidence.observedAt);
    const record = this.chains.get(evidence.requestId);
    const redirectChain = record ? [...record.urls] : [];
    appendUnique(redirectChain, evidence.url);
    const format = classifyNetworkMediaResponse(evidence, redirectChain);
    if (format === VideoFormat.UNKNOWN) return null;

    return {
      url: evidence.url,
      entryUrl: redirectChain[0] ?? evidence.url,
      redirectChain,
      sourceKey: mediaSourceKey(redirectChain, format),
      documentId: evidence.documentId,
      format,
      statusCode: evidence.statusCode,
      resourceType: evidence.resourceType,
      contentType: normalizedContentType(evidence.responseHeaders) || undefined,
      contentRange: evidence.responseHeaders?.["content-range"],
      contentLength: parseContentLength(evidence.responseHeaders?.["content-length"]),
      initiator: evidence.initiator,
      observedAt: evidence.observedAt ?? Date.now(),
    };
  }

  complete(requestId: string): void {
    this.chains.delete(requestId);
  }

  get size(): number {
    return this.chains.size;
  }

  private prune(now = Date.now()): void {
    for (const [requestId, record] of this.chains) {
      if (now - record.updatedAt > this.ttlMs) this.chains.delete(requestId);
    }
  }

  private trim(): void {
    while (this.chains.size > this.maxChains) {
      const oldest = this.chains.keys().next().value;
      if (!oldest) break;
      this.chains.delete(oldest);
    }
  }
}
