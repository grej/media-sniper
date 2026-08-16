/**
 * Keep open-ended media reads bounded without turning a clip into hundreds of
 * small HTTP requests. Two MiB is still a modest per-request ceiling, while
 * substantially reducing round trips through higher-latency media proxies.
 */
export const DEFAULT_MEDIA_RANGE_REQUEST_BYTES = 2 * 1024 * 1024;

/**
 * Preserve Mediabunny's fetch contract while bounding open-ended byte ranges.
 * This prevents an initial `bytes=N-` probe from silently transferring the
 * rest of a large direct source.
 */
export function createBoundedRangeFetch(
  fetchFn: typeof fetch = fetch,
  maxRequestBytes = DEFAULT_MEDIA_RANGE_REQUEST_BYTES,
): typeof fetch {
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) {
    throw new TypeError("maxRequestBytes must be a positive safe integer");
  }

  return async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    const range = headers.get("Range")?.match(/^bytes=(\d+)-$/i);
    if (range) {
      const start = Number(range[1]);
      if (Number.isSafeInteger(start)) {
        headers.set("Range", `bytes=${start}-${start + maxRequestBytes - 1}`);
      }
    }
    return fetchFn(
      new Request(request, {
        headers,
        credentials: "include",
      }),
    );
  };
}
