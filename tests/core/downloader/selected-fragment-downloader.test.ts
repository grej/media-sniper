import { describe, expect, it, vi } from "vitest";
import {
  deriveHlsImplicitIv,
  downloadSelectedFragments,
  mapDenseSelectionToInputParts,
  type SelectedInputPart,
} from "@/core/downloader/selected-fragment-downloader";

function response(bytes: number[], init: ResponseInit = {}): Response {
  return new Response(new Uint8Array(bytes), init);
}

describe("downloadSelectedFragments", () => {
  it("maps selected source parts densely with init data in source order", () => {
    const init = {
      uri: "https://cdn.test/init.mp4",
      byteRange: { offset: 0, length: 100 },
    };
    const parts = mapDenseSelectionToInputParts([
      {
        storageIndex: 0,
        segment: {
          sourceIndex: 37,
          sequenceNumber: 337,
          uri: "https://cdn.test/seg-37.m4s",
          startMs: 4_000,
          durationMs: 2_000,
          endMs: 6_000,
          init,
          encryption: {
            method: "AES-128",
            keyUri: "https://cdn.test/key",
            explicitIv: new Uint8Array(16).fill(1),
            sequenceNumber: 337,
          },
        },
      },
      {
        storageIndex: 1,
        segment: {
          sourceIndex: 38,
          sequenceNumber: 338,
          uri: "https://cdn.test/seg-38.m4s",
          startMs: 6_000,
          durationMs: 2_000,
          endMs: 8_000,
          init,
        },
      },
    ]);

    expect(parts).toHaveLength(3);
    expect(parts.map((part) => [part.storageIndex, part.uri])).toEqual([
      [0, "https://cdn.test/init.mp4"],
      [1, "https://cdn.test/seg-37.m4s"],
      [2, "https://cdn.test/seg-38.m4s"],
    ]);
    expect(parts[1].encryption).toMatchObject({
      sourceMediaSequence: 337,
      keyUri: "https://cdn.test/key",
    });
  });

  it("fetches only selected range tasks and stores them densely", async () => {
    const requested: Array<{ url: string; range: string | null }> = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const range = new Headers(init?.headers).get("Range");
      requested.push({ url, range });
      if (url.endsWith("second")) {
        return response([20, 21], {
          status: 206,
          headers: { "Content-Range": "bytes 10-11/100" },
        });
      }
      return response([10], {
        status: 206,
        headers: { "Content-Range": "bytes 4-4/100" },
      });
    }) as typeof fetch;
    const writes: Array<{ index: number; bytes: number[] }> = [];
    const progress = vi.fn();

    const result = await downloadSelectedFragments({
      operationId: "selected_1",
      trackKind: "combined",
      parts: [
        { uri: "https://cdn.test/first", storageIndex: 0, byteRange: { offset: 4, length: 1 } },
        { uri: "https://cdn.test/second", storageIndex: 1, byteRange: { offset: 10, length: 2 } },
      ],
      signal: new AbortController().signal,
      maxConcurrent: 2,
      fetchFn,
      storeFn: async (_id, _track, index, data) => {
        writes.push({ index, bytes: [...new Uint8Array(data)] });
      },
      onProgress: progress,
    });

    expect(requested).toEqual([
      { url: "https://cdn.test/first", range: "bytes=4-4" },
      { url: "https://cdn.test/second", range: "bytes=10-11" },
    ]);
    expect(writes.sort((a, b) => a.index - b.index)).toEqual([
      { index: 0, bytes: [10] },
      { index: 1, bytes: [20, 21] },
    ]);
    expect(result).toEqual({ partCount: 2, downloadedBytes: 3, keyRequestCount: 0 });
    expect(progress).toHaveBeenLastCalledWith({
      completedParts: 2,
      totalParts: 2,
      downloadedBytes: 3,
      percentage: 100,
    });
  });

  it("safely slices a capped HTTP 200 fallback and rejects oversized responses", async () => {
    const storeFn = vi.fn().mockResolvedValue(undefined);
    await downloadSelectedFragments({
      operationId: "fallback_1",
      trackKind: "video",
      parts: [{ uri: "https://cdn.test/all", storageIndex: 0, byteRange: { offset: 2, length: 2 } }],
      signal: new AbortController().signal,
      fetchFn: vi.fn(async () => response([0, 1, 2, 3, 4])) as typeof fetch,
      storeFn,
      maxRangeFallbackBytes: 5,
    });
    expect([...new Uint8Array(storeFn.mock.calls[0][3])]).toEqual([2, 3]);

    const cleanupFn = vi.fn().mockResolvedValue(undefined);
    await expect(
      downloadSelectedFragments({
        operationId: "fallback_2",
        trackKind: "video",
        parts: [{ uri: "https://cdn.test/large", storageIndex: 0, byteRange: { offset: 0, length: 1 } }],
        signal: new AbortController().signal,
        maxRetries: 1,
        fetchFn: vi.fn(async () => response([0, 1, 2, 3])) as typeof fetch,
        storeFn,
        cleanupFn,
        maxRangeFallbackBytes: 3,
      }),
    ).rejects.toThrow("safety limit");
    expect(cleanupFn).toHaveBeenCalledWith("fallback_2", "video");
  });

  it("caches AES-128 keys and supports explicit and source-sequence IVs", async () => {
    const keyBytes = new Uint8Array(16).fill(7);
    const plainA = new TextEncoder().encode("first selected part");
    const plainB = new TextEncoder().encode("second selected part");
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["encrypt"]);
    const explicitIv = new Uint8Array(16).fill(3);
    const implicitIv = deriveHlsImplicitIv(42);
    const encryptedA = await crypto.subtle.encrypt({ name: "AES-CBC", iv: explicitIv }, key, plainA);
    const encryptedB = await crypto.subtle.encrypt({ name: "AES-CBC", iv: implicitIv }, key, plainB);
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("key")) return new Response(keyBytes);
      return new Response(url.endsWith("a") ? encryptedA : encryptedB);
    }) as typeof fetch;
    const writes = new Map<number, string>();
    const parts: SelectedInputPart[] = [
      {
        uri: "https://cdn.test/a",
        storageIndex: 0,
        encryption: {
          method: "AES-128",
          keyUri: "https://cdn.test/key",
          iv: explicitIv,
          sourceMediaSequence: 41,
        },
      },
      {
        uri: "https://cdn.test/b",
        storageIndex: 1,
        encryption: {
          method: "AES-128",
          keyUri: "https://cdn.test/key",
          sourceMediaSequence: 42,
        },
      },
    ];

    const result = await downloadSelectedFragments({
      operationId: "encrypted_1",
      trackKind: "combined",
      parts,
      signal: new AbortController().signal,
      fetchFn,
      storeFn: async (_id, _track, index, data) => {
        writes.set(index, new TextDecoder().decode(data));
      },
    });

    expect(writes).toEqual(new Map([[0, "first selected part"], [1, "second selected part"]]));
    expect(fetchFn.mock.calls.filter(([url]) => String(url).endsWith("key"))).toHaveLength(1);
    expect(result.keyRequestCount).toBe(1);
  });

  it("fails required parts, cleans partial storage, and honors cancellation", async () => {
    const cleanupFn = vi.fn().mockResolvedValue(undefined);
    await expect(
      downloadSelectedFragments({
        operationId: "required_1",
        trackKind: "audio",
        parts: [{ uri: "https://cdn.test/missing", storageIndex: 0 }],
        signal: new AbortController().signal,
        maxRetries: 1,
        fetchFn: vi.fn(async () => response([], { status: 404 })) as typeof fetch,
        storeFn: vi.fn(),
        cleanupFn,
      }),
    ).rejects.toThrow("HTTP 404");
    expect(cleanupFn).toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    await expect(
      downloadSelectedFragments({
        operationId: "cancel_1",
        trackKind: "audio",
        parts: [{ uri: "https://cdn.test/unused", storageIndex: 0 }],
        signal: controller.signal,
        fetchFn: vi.fn() as typeof fetch,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels sibling fetches before cleaning a failed required batch", async () => {
    const events: string[] = [];
    const fetchFn = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input).endsWith("bad")) {
          return response([], { status: 500 });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              events.push("sibling-aborted");
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
      },
    ) as typeof fetch;

    await expect(
      downloadSelectedFragments({
        operationId: "required_batch",
        trackKind: "combined",
        parts: [
          { uri: "https://cdn.test/bad", storageIndex: 0 },
          { uri: "https://cdn.test/slow", storageIndex: 1 },
        ],
        signal: new AbortController().signal,
        maxRetries: 1,
        maxConcurrent: 2,
        fetchFn,
        storeFn: vi.fn(),
        cleanupFn: async () => {
          events.push("cleanup");
        },
      }),
    ).rejects.toThrow("HTTP 500");
    expect(events).toEqual(["sibling-aborted", "cleanup"]);
  });

  it("rejects non-dense input mappings before network work", async () => {
    const fetchFn = vi.fn() as typeof fetch;
    await expect(
      downloadSelectedFragments({
        operationId: "dense_1",
        trackKind: "combined",
        parts: [{ uri: "https://cdn.test/segment", storageIndex: 3 }],
        signal: new AbortController().signal,
        fetchFn,
      }),
    ).rejects.toThrow("dense storage indices");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
