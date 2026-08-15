import type { ClipTrackKind } from "../database/clip-chunks";
import type { DenseStorageSegment } from "../clipping/types";
import {
  deleteClipTrackChunks,
  storeClipTrackChunk,
} from "../database/clip-chunks";

export interface SelectedByteRange {
  offset: number;
  length: number;
}

export interface SelectedFragmentEncryption {
  method: "AES-128";
  keyUri: string;
  /** Explicit IV. If omitted, the source media sequence is used. */
  iv?: string | Uint8Array;
  sourceMediaSequence: number;
}

export interface SelectedInputPart {
  uri: string;
  /** Dense target position; callers must provide exactly 0..N-1. */
  storageIndex: number;
  sourceIndex?: number;
  byteRange?: SelectedByteRange;
  encryption?: SelectedFragmentEncryption;
}

export interface SelectedDownloadProgress {
  completedParts: number;
  totalParts: number;
  downloadedBytes: number;
  percentage: number;
}

export interface SelectedFragmentDownloaderOptions {
  operationId: string;
  trackKind: ClipTrackKind;
  parts: readonly SelectedInputPart[];
  signal: AbortSignal;
  maxConcurrent?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  retryBackoffFactor?: number;
  /** Maximum full response accepted when a server ignores Range. */
  maxRangeFallbackBytes?: number;
  fetchFn?: typeof fetch;
  storeFn?: typeof storeClipTrackChunk;
  cleanupFn?: typeof deleteClipTrackChunks;
  onProgress?: (progress: SelectedDownloadProgress) => void;
}

export interface SelectedFragmentDownloadResult {
  partCount: number;
  downloadedBytes: number;
  keyRequestCount: number;
}

const DEFAULT_MAX_RANGE_FALLBACK_BYTES = 8 * 1024 * 1024;
const MAX_AES_KEY_RESPONSE_BYTES = 1024;

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function validateParts(parts: readonly SelectedInputPart[]): void {
  if (parts.length === 0) throw new Error("At least one selected input part is required");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.storageIndex !== i) {
      throw new Error(
        `Selected input parts must use dense storage indices; expected ${i}, got ${part.storageIndex}`,
      );
    }
    if (!part.uri) throw new Error(`Selected input part ${i} has no URI`);
    if (part.byteRange) {
      if (
        !Number.isSafeInteger(part.byteRange.offset) ||
        part.byteRange.offset < 0 ||
        !Number.isSafeInteger(part.byteRange.length) ||
        part.byteRange.length <= 0
      ) {
        throw new Error(`Selected input part ${i} has an invalid byte range`);
      }
    }
    if (part.encryption && !Number.isSafeInteger(part.encryption.sourceMediaSequence)) {
      throw new Error(`Selected input part ${i} has an invalid source media sequence`);
    }
  }
}

function parseContentRange(value: string | null): {
  start: number;
  end: number;
} | null {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i);
  return match ? { start: Number(match[1]), end: Number(match[2]) } : null;
}

async function readResponseCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(
      `Server ignored Range and returned ${contentLength} bytes (limit ${maxBytes})`,
    );
  }

  if (!response.body) {
    const data = await response.arrayBuffer();
    if (data.byteLength > maxBytes) {
      throw new Error(`Response exceeded the ${maxBytes}-byte safety limit`);
    }
    return data;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeded the ${maxBytes}-byte safety limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

async function fetchOnce(
  fetchFn: typeof fetch,
  uri: string,
  signal: AbortSignal,
  byteRange: SelectedByteRange | undefined,
  maxRangeFallbackBytes: number,
): Promise<ArrayBuffer> {
  const headers = new Headers();
  if (byteRange) {
    headers.set(
      "Range",
      `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`,
    );
  }
  const response = await fetchFn(uri, {
    headers,
    credentials: "include",
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${uri}`);
  }

  if (!byteRange) return response.arrayBuffer();

  if (response.status === 206) {
    const contentRange = parseContentRange(response.headers.get("content-range"));
    const expectedEnd = byteRange.offset + byteRange.length - 1;
    if (
      !contentRange ||
      contentRange.start !== byteRange.offset ||
      contentRange.end !== expectedEnd
    ) {
      throw new Error(`Invalid Content-Range for ${uri}`);
    }
    const data = await response.arrayBuffer();
    if (data.byteLength !== byteRange.length) {
      throw new Error(
        `Partial response length mismatch for ${uri}: expected ${byteRange.length}, got ${data.byteLength}`,
      );
    }
    return data;
  }

  if (response.status !== 200) {
    throw new Error(`Range request returned unexpected HTTP ${response.status} for ${uri}`);
  }

  const full = await readResponseCapped(response, maxRangeFallbackBytes, signal);
  const end = byteRange.offset + byteRange.length;
  if (full.byteLength < end) {
    throw new Error(`Full-response fallback is too short for requested range at ${uri}`);
  }
  return full.slice(byteRange.offset, end);
}

async function withRetry<T>(
  job: () => Promise<T>,
  attempts: number,
  signal: AbortSignal,
  delayMs: number,
  factor: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    throwIfAborted(signal);
    try {
      return await job();
    } catch (error) {
      lastError = error;
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw abortError();
      }
      if (attempt + 1 < attempts) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, delayMs * factor ** attempt);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Selected part fetch failed");
}

function explicitIv(value: string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.byteLength !== 16) throw new Error("AES-128 IV must be 16 bytes");
    return value;
  }
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-f]{1,32}$/i.test(hex)) throw new Error("AES-128 IV must be hexadecimal");
  const padded = hex.padStart(32, "0");
  return Uint8Array.from({ length: 16 }, (_, i) =>
    Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16),
  );
}

/** HLS implicit IV: the original media-sequence number as a 128-bit big-endian integer. */
export function deriveHlsImplicitIv(sourceMediaSequence: number): Uint8Array {
  if (!Number.isSafeInteger(sourceMediaSequence) || sourceMediaSequence < 0) {
    throw new Error("HLS media sequence must be a non-negative safe integer");
  }
  const iv = new Uint8Array(16);
  let value = BigInt(sourceMediaSequence);
  for (let i = 15; i >= 0; i--) {
    iv[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return iv;
}

function inputPartKey(uri: string, range?: SelectedByteRange): string {
  return range ? `${uri}\0${range.offset}:${range.length}` : `${uri}\0`;
}

/**
 * Convert the planner's selected source segments into the downloader's dense
 * input stream, inserting each initialization part immediately before its
 * first use and preserving source sequence metadata for AES implicit IVs.
 */
export function mapDenseSelectionToInputParts(
  selected: readonly DenseStorageSegment[],
): SelectedInputPart[] {
  const parts: SelectedInputPart[] = [];
  const seenInit = new Set<string>();

  selected.forEach(({ storageIndex, segment }, selectedIndex) => {
    if (storageIndex !== selectedIndex) {
      throw new Error(
        `Planner selection must be dense; expected ${selectedIndex}, got ${storageIndex}`,
      );
    }
    if (segment.init) {
      const key = inputPartKey(segment.init.uri, segment.init.byteRange);
      if (!seenInit.has(key)) {
        seenInit.add(key);
        parts.push({
          uri: segment.init.uri,
          storageIndex: parts.length,
          sourceIndex: segment.sourceIndex,
          byteRange: segment.init.byteRange,
          encryption: segment.encryption
            ? {
                method: "AES-128",
                keyUri: segment.encryption.keyUri,
                iv: segment.encryption.explicitIv,
                sourceMediaSequence: segment.encryption.sequenceNumber,
              }
            : undefined,
        });
      }
    }
    parts.push({
      uri: segment.uri,
      storageIndex: parts.length,
      sourceIndex: segment.sourceIndex,
      byteRange: segment.byteRange,
      encryption: segment.encryption
        ? {
            method: "AES-128",
            keyUri: segment.encryption.keyUri,
            iv: segment.encryption.explicitIv,
            sourceMediaSequence: segment.encryption.sequenceNumber,
          }
        : undefined,
    });
  });
  return parts;
}

async function decryptPart(
  encrypted: ArrayBuffer,
  encryption: SelectedFragmentEncryption,
  getKey: (uri: string) => Promise<ArrayBuffer>,
): Promise<ArrayBuffer> {
  const keyBytes = await getKey(encryption.keyUri);
  if (keyBytes.byteLength !== 16) throw new Error("AES-128 key must be 16 bytes");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, [
    "decrypt",
  ]);
  const iv = encryption.iv
    ? explicitIv(encryption.iv)
    : deriveHlsImplicitIv(encryption.sourceMediaSequence);
  return crypto.subtle.decrypt(
    { name: "AES-CBC", iv: iv as unknown as BufferSource },
    key,
    encrypted,
  );
}

/**
 * Fetch exactly the supplied parts and persist them at dense indices. This
 * intentionally has no manifest/planner logic and performs no IndexedDB reads
 * on the progress hot path.
 */
export async function downloadSelectedFragments(
  options: SelectedFragmentDownloaderOptions,
): Promise<SelectedFragmentDownloadResult> {
  validateParts(options.parts);
  throwIfAborted(options.signal);

  // A private controller lets one required-part failure stop sibling workers
  // before cleanup, without mutating the caller-owned AbortController.
  const workController = new AbortController();
  const cancelFromCaller = () => workController.abort();
  options.signal.addEventListener("abort", cancelFromCaller, { once: true });
  const signal = workController.signal;

  const fetchFn = options.fetchFn ?? fetch;
  const storeFn = options.storeFn ?? storeClipTrackChunk;
  const cleanupFn = options.cleanupFn ?? deleteClipTrackChunks;
  const attempts = Math.max(1, options.maxRetries ?? 3);
  const delayMs = Math.max(0, options.retryDelayMs ?? 100);
  const factor = Math.max(1, options.retryBackoffFactor ?? 1.15);
  const fallbackCap = options.maxRangeFallbackBytes ?? DEFAULT_MAX_RANGE_FALLBACK_BYTES;
  const keyCache = new Map<string, Promise<ArrayBuffer>>();
  let keyRequestCount = 0;
  let completedParts = 0;
  let downloadedBytes = 0;

  const fetchData = (uri: string, range?: SelectedByteRange) =>
    withRetry(
      () => fetchOnce(fetchFn, uri, signal, range, fallbackCap),
      attempts,
      signal,
      delayMs,
      factor,
    );
  const getKey = (uri: string): Promise<ArrayBuffer> => {
    let request = keyCache.get(uri);
    if (!request) {
      keyRequestCount += 1;
      request = withRetry(
        async () => {
          const response = await fetchFn(uri, {
            credentials: "include",
            signal,
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText} for ${uri}`);
          }
          return readResponseCapped(
            response,
            MAX_AES_KEY_RESPONSE_BYTES,
            signal,
          );
        },
        attempts,
        signal,
        delayMs,
        factor,
      );
      keyCache.set(uri, request);
    }
    return request;
  };

  let cursor = 0;
  let primaryError: unknown;
  const worker = async (): Promise<void> => {
    try {
      while (true) {
        throwIfAborted(signal);
        const index = cursor++;
        if (index >= options.parts.length) return;
        const part = options.parts[index];
        const downloaded = await fetchData(part.uri, part.byteRange);
        const data = part.encryption
          ? await decryptPart(downloaded, part.encryption, getKey)
          : downloaded;
        throwIfAborted(signal);
        await storeFn(options.operationId, options.trackKind, part.storageIndex, data);
        downloadedBytes += downloaded.byteLength;
        completedParts += 1;
        options.onProgress?.({
          completedParts,
          totalParts: options.parts.length,
          downloadedBytes,
          percentage: (completedParts / options.parts.length) * 100,
        });
      }
    } catch (error) {
      if (primaryError === undefined) primaryError = error;
      workController.abort();
      throw error;
    }
  };

  try {
    const workerCount = Math.min(
      options.parts.length,
      Math.max(1, Math.floor(options.maxConcurrent ?? 3)),
    );
    const results = await Promise.allSettled(
      Array.from({ length: workerCount }, () => worker()),
    );
    const failed = results.some((result) => result.status === "rejected");
    if (failed) {
      throw primaryError instanceof Error
        ? primaryError
        : new Error("A required selected input part failed");
    }
    return { partCount: completedParts, downloadedBytes, keyRequestCount };
  } catch (error) {
    await cleanupFn(options.operationId, options.trackKind).catch(() => undefined);
    throw error;
  } finally {
    options.signal.removeEventListener("abort", cancelFromCaller);
  }
}
