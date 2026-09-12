import { describe, expect, it, vi } from "vitest";
import { fetchSelfContainedFmp4ToChunks } from "@/core/downloader/direct/self-contained-fmp4-fetch";

function box(type: string, payloadBytes = 0): Uint8Array {
  const bytes = new Uint8Array(8 + payloadBytes);
  new DataView(bytes.buffer).setUint32(0, bytes.byteLength, false);
  for (let index = 0; index < 4; index += 1) bytes[4 + index] = type.charCodeAt(index);
  return bytes;
}

function mediaBytes(): Uint8Array {
  const parts = [box("ftyp", 4), box("moov", 8), box("moof", 12), box("mdat", 20)];
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

describe("fetchSelfContainedFmp4ToChunks", () => {
  it("prefers a credentialed full GET without a Range header", async () => {
    const media = mediaBytes();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(media, {
      status: 200,
      headers: {
        "content-type": "video/iso.segment",
        "content-length": String(media.byteLength),
      },
    }));
    const stored: ArrayBuffer[] = [];

    const result = await fetchSelfContainedFmp4ToChunks({
      url: "https://cdn.test/loop.m4s",
      signal: new AbortController().signal,
      fetchFn,
      chunkSize: 16,
      storeChunk: async (index, data) => { stored[index] = data; },
    });

    expect(result).toEqual({
      chunkCount: Math.ceil(media.byteLength / 16),
      totalBytes: media.byteLength,
      usedRangeFallback: false,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      credentials: "include",
    });
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).has("range")).toBe(false);
    expect(stored.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(media.byteLength);
  });

  it("reconstructs the complete file in ordered ranges when full GET returns 206", async () => {
    const media = mediaBytes();
    const requestedRanges: string[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const range = new Headers(init?.headers).get("range");
      if (!range) {
        return new Response(media.slice(0, 8), {
          status: 206,
          headers: {
            "content-type": "video/mp4",
            "content-range": `bytes 0-7/${media.byteLength}`,
          },
        });
      }
      requestedRanges.push(range);
      const match = range.match(/^bytes=(\d+)-(\d+)$/)!;
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(media.slice(start, end + 1), {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-range": `bytes ${start}-${end}/${media.byteLength}`,
        },
      });
    });
    const stored: ArrayBuffer[] = [];

    const result = await fetchSelfContainedFmp4ToChunks({
      url: "https://cdn.test/loop.m4s",
      signal: new AbortController().signal,
      fetchFn,
      chunkSize: 17,
      storeChunk: async (index, data) => { stored[index] = data; },
    });

    expect(result.usedRangeFallback).toBe(true);
    expect(requestedRanges[0]).toBe("bytes=0-16");
    expect(requestedRanges.at(-1)).toBe(`bytes=${media.byteLength - media.byteLength % 17}-${media.byteLength - 1}`);
    const rebuilt = new Uint8Array(media.byteLength);
    let offset = 0;
    for (const chunk of stored) {
      rebuilt.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    expect(rebuilt).toEqual(media);
  });

  it("rejects an ordinary moof-only segment", async () => {
    const segment = new Uint8Array([...box("moof"), ...box("mdat", 4)]);
    await expect(fetchSelfContainedFmp4ToChunks({
      url: "https://cdn.test/chunk.m4s",
      signal: new AbortController().signal,
      fetchFn: vi.fn().mockResolvedValue(new Response(segment, {
        status: 200,
        headers: { "content-type": "video/iso.segment" },
      })),
      storeChunk: async () => undefined,
    })).rejects.toThrow(/ftyp.*moov.*moof.*mdat/i);
  });
});
