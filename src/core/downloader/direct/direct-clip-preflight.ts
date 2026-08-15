import { ClippingError } from "../../clipping/errors";

export type DirectRangeCapability =
  | "range-supported"
  | "small-sequential"
  | "large-or-unknown-sequential"
  | "unavailable";

export interface DirectClipPreflightResult {
  capability: DirectRangeCapability;
  contentLength?: number;
  contentType?: string;
  status: number;
  reason?: string;
}

export interface DirectClipPreflightOptions {
  fetchFn?: typeof fetch;
  maxSequentialBytes: number;
  signal?: AbortSignal;
}

function parseLength(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

function totalFromContentRange(value: string | null): number | undefined {
  if (!value) return undefined;
  const match = /^bytes\s+0-0\/(\d+|\*)$/i.exec(value.trim());
  return match?.[1] && match[1] !== "*" ? parseLength(match[1]) : undefined;
}

export async function preflightDirectClipSource(
  url: string,
  options: DirectClipPreflightOptions,
): Promise<DirectClipPreflightResult> {
  if (!Number.isSafeInteger(options.maxSequentialBytes) || options.maxSequentialBytes <= 0) {
    throw new TypeError("maxSequentialBytes must be a positive safe integer");
  }

  const fetchFn = options.fetchFn ?? fetch;
  try {
    const response = await fetchFn(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      credentials: "include",
      cache: "no-store",
      signal: options.signal,
    });
    const contentType = response.headers.get("content-type") ?? undefined;
    const stopProbeBody = async () => {
      try { await response.body?.cancel(); } catch { /* body may already be closed */ }
    };

    if (response.status === 206) {
      const contentRange = response.headers.get("content-range");
      await stopProbeBody();
      if (!/^bytes\s+0-0\/(\d+|\*)$/i.test(contentRange?.trim() ?? "")) {
        return {
          capability: "unavailable",
          status: response.status,
          contentType,
          reason: "The server returned an invalid Content-Range response.",
        };
      }
      return {
        capability: "range-supported",
        status: response.status,
        contentType,
        contentLength: totalFromContentRange(contentRange),
      };
    }

    if (response.status === 200) {
      const contentLength = parseLength(response.headers.get("content-length"));
      await stopProbeBody();
      return {
        capability: contentLength !== undefined && contentLength <= options.maxSequentialBytes
          ? "small-sequential"
          : "large-or-unknown-sequential",
        status: response.status,
        contentType,
        contentLength,
        reason: contentLength === undefined
          ? "The server ignored Range and did not provide a source size."
          : `The server ignored Range for a ${contentLength}-byte source.`,
      };
    }

    await stopProbeBody();
    return {
      capability: "unavailable",
      status: response.status,
      contentType,
      reason: `The source returned HTTP ${response.status}.`,
    };
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    return {
      capability: "unavailable",
      status: 0,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export function assertDirectClipPreflightAllowed(
  result: DirectClipPreflightResult,
  allowFullFetchForDirect: boolean,
): void {
  if (result.capability === "range-supported") return;
  if (result.capability === "small-sequential" && allowFullFetchForDirect) return;
  if (result.capability === "small-sequential") {
    throw new ClippingError(
      "DIRECT_FULL_FETCH_CONFIRMATION_REQUIRED",
      "Direct source requires a consented full fetch",
      { userMessage: "This source does not support byte ranges. Confirm the small full fetch to create a clip." },
    );
  }
  if (result.capability === "large-or-unknown-sequential") {
    throw new ClippingError(
      "RANGE_REQUIRED",
      result.reason ?? "Direct source is too large or unknown for sequential clipping",
      { userMessage: "This source cannot be clipped safely because byte ranges are unavailable. Use the full-download action instead." },
    );
  }
  throw new ClippingError(
    "SOURCE_AUTH_FAILED",
    result.reason ?? "Direct source is unavailable",
    { userMessage: result.reason ?? "The media source is unavailable or requires authorization." },
  );
}
