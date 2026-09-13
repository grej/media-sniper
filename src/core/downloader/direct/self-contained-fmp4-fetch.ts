import { inspectSelfContainedFragmentedMp4, parseCompleteContentRange } from "../../media/fragmented-mp4";

export interface SelfContainedFmp4FetchProgress {
  downloaded: number;
  total?: number;
}

export interface SelfContainedFmp4FetchOptions {
  url: string;
  signal: AbortSignal;
  fetchFn?: typeof fetch;
  storeChunk: (index: number, data: ArrayBuffer) => Promise<void>;
  onProgress?: (progress: SelfContainedFmp4FetchProgress) => void;
  chunkSize?: number;
  validationPrefixBytes?: number;
  maxRetries?: number;
}

export interface SelfContainedFmp4FetchResult {
  chunkCount: number;
  totalBytes: number;
  usedRangeFallback: boolean;
}

const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
const DEFAULT_VALIDATION_PREFIX_BYTES = 16 * 1024 * 1024;

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function parseLength(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
}

function allowedContentType(response: Response): boolean {
  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return !contentType ||
    contentType.startsWith("video/") ||
    contentType.includes("iso.segment") ||
    contentType.includes("mp4") ||
    contentType === "application/octet-stream" ||
    contentType === "binary/octet-stream";
}

async function fetchWithRetry(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  attempts: number,
  signal: AbortSignal,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfAborted(signal);
    try {
      const response = await fetchFn(url, init);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      lastError = error;
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw abortError();
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to fetch ${url}`);
}

class PrefixCollector {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  add(data: Uint8Array): void {
    if (this.size >= this.limit) return;
    const remaining = this.limit - this.size;
    const part = data.byteLength <= remaining ? data : data.subarray(0, remaining);
    this.chunks.push(part.slice());
    this.size += part.byteLength;
  }

  bytes(): Uint8Array {
    const result = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
}

async function storeResponseBody(
  response: Response,
  options: {
    signal: AbortSignal;
    chunkSize: number;
    expectedTotal?: number;
    storeChunk: (index: number, data: ArrayBuffer) => Promise<void>;
    prefix: PrefixCollector;
    onProgress?: (progress: SelfContainedFmp4FetchProgress) => void;
  },
): Promise<{ chunkCount: number; totalBytes: number }> {
  let chunkCount = 0;
  let totalBytes = 0;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;

  const flush = async (force = false) => {
    while (pendingBytes >= options.chunkSize || (force && pendingBytes > 0)) {
      const outputSize = force
        ? Math.min(pendingBytes, options.chunkSize)
        : options.chunkSize;
      const output = new Uint8Array(outputSize);
      let written = 0;
      while (written < outputSize) {
        const first = pending[0]!;
        const take = Math.min(first.byteLength, outputSize - written);
        output.set(first.subarray(0, take), written);
        written += take;
        if (take === first.byteLength) pending.shift();
        else pending[0] = first.subarray(take);
        pendingBytes -= take;
      }
      options.prefix.add(output);
      await options.storeChunk(chunkCount, output.buffer);
      chunkCount += 1;
      totalBytes += output.byteLength;
      options.onProgress?.({ downloaded: totalBytes, total: options.expectedTotal });
    }
  };

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    pending.push(bytes);
    pendingBytes = bytes.byteLength;
    await flush(true);
  } else {
    const reader = response.body.getReader();
    try {
      while (true) {
        throwIfAborted(options.signal);
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > 0) {
          pending.push(value);
          pendingBytes += value.byteLength;
          await flush();
        }
      }
      await flush(true);
    } finally {
      reader.releaseLock();
    }
  }

  if (options.expectedTotal !== undefined && totalBytes !== options.expectedTotal) {
    throw new Error(
      `Complete media length mismatch: expected ${options.expectedTotal}, received ${totalBytes}`,
    );
  }
  return { chunkCount, totalBytes };
}

/** Prefer an ordinary full GET, falling back to ordered byte-range assembly. */
export async function fetchSelfContainedFmp4ToChunks(
  options: SelfContainedFmp4FetchOptions,
): Promise<SelfContainedFmp4FetchResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const validationPrefixBytes = options.validationPrefixBytes
    ?? DEFAULT_VALIDATION_PREFIX_BYTES;
  const attempts = Math.max(1, options.maxRetries ?? 3);
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new TypeError("chunkSize must be a positive safe integer");
  }

  const prefix = new PrefixCollector(validationPrefixBytes);
  const fullResponse = await fetchWithRetry(fetchFn, options.url, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    signal: options.signal,
  }, attempts, options.signal);
  if (!allowedContentType(fullResponse)) {
    await fullResponse.body?.cancel().catch(() => undefined);
    throw new Error("The .m4s URL returned a non-media response");
  }

  let result: SelfContainedFmp4FetchResult;
  if (fullResponse.status === 200) {
    const expectedTotal = parseLength(fullResponse.headers.get("content-length"));
    const stored = await storeResponseBody(fullResponse, {
      signal: options.signal,
      chunkSize,
      expectedTotal,
      storeChunk: options.storeChunk,
      prefix,
      onProgress: options.onProgress,
    });
    result = { ...stored, usedRangeFallback: false };
  } else if (fullResponse.status === 206) {
    const contentRange = parseCompleteContentRange(
      fullResponse.headers.get("content-range"),
    );
    await fullResponse.body?.cancel().catch(() => undefined);
    if (!contentRange) {
      throw new Error("The server returned a partial response without a complete Content-Range");
    }

    let chunkCount = 0;
    let totalBytes = 0;
    for (let offset = 0; offset < contentRange.total; offset += chunkSize) {
      throwIfAborted(options.signal);
      const end = Math.min(contentRange.total - 1, offset + chunkSize - 1);
      const response = await fetchWithRetry(fetchFn, options.url, {
        method: "GET",
        headers: { Range: `bytes=${offset}-${end}` },
        credentials: "include",
        cache: "no-store",
        signal: options.signal,
      }, attempts, options.signal);
      if (response.status !== 206) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Range reconstruction expected HTTP 206, received ${response.status}`);
      }
      const returnedRange = parseCompleteContentRange(response.headers.get("content-range"));
      if (
        !returnedRange ||
        returnedRange.start !== offset ||
        returnedRange.end !== end ||
        returnedRange.total !== contentRange.total
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Invalid Content-Range while reconstructing bytes ${offset}-${end}`);
      }
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.byteLength !== end - offset + 1) {
        throw new Error(`Partial response length mismatch for bytes ${offset}-${end}`);
      }
      prefix.add(data);
      await options.storeChunk(chunkCount, data.slice().buffer);
      chunkCount += 1;
      totalBytes += data.byteLength;
      options.onProgress?.({ downloaded: totalBytes, total: contentRange.total });
    }
    result = { chunkCount, totalBytes, usedRangeFallback: true };
  } else {
    await fullResponse.body?.cancel().catch(() => undefined);
    throw new Error(`Full media fetch returned unexpected HTTP ${fullResponse.status}`);
  }

  const inspection = inspectSelfContainedFragmentedMp4(prefix.bytes());
  if (!inspection.complete) {
    throw new Error(inspection.reason ?? "The .m4s resource is not a complete fragmented MP4");
  }
  return result;
}
