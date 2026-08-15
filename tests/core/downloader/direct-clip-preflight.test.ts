import { describe, expect, it, vi } from "vitest";
import {
  assertDirectClipPreflightAllowed,
  preflightDirectClipSource,
} from "../../../src/core/downloader/direct/direct-clip-preflight";

describe("direct clip preflight", () => {
  it("accepts a valid bytes=0-0 response and preserves credentials", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(new Uint8Array([0]), {
      status: 206,
      headers: { "Content-Range": "bytes 0-0/12345", "Content-Type": "video/mp4" },
    }));
    const result = await preflightDirectClipSource("https://cdn.test/video.mp4", {
      fetchFn,
      maxSequentialBytes: 1_000,
    });
    expect(result).toMatchObject({ capability: "range-supported", contentLength: 12_345 });
    expect(fetchFn).toHaveBeenCalledWith("https://cdn.test/video.mp4", expect.objectContaining({
      credentials: "include",
      headers: { Range: "bytes=0-0" },
    }));
    expect(() => assertDirectClipPreflightAllowed(result, false)).not.toThrow();
  });

  it("classifies a small ignored range and requires explicit consent", async () => {
    const result = await preflightDirectClipSource("https://cdn.test/video.mp4", {
      fetchFn: vi.fn().mockResolvedValue(new Response(new Uint8Array(12), {
        status: 200,
        headers: { "Content-Length": "12" },
      })),
      maxSequentialBytes: 20,
    });
    expect(result.capability).toBe("small-sequential");
    expect(() => assertDirectClipPreflightAllowed(result, false)).toThrow(/consented full fetch/);
    expect(() => assertDirectClipPreflightAllowed(result, true)).not.toThrow();
  });

  it.each([
    ["unknown", null],
    ["large", "21"],
  ])("refuses %s sequential inputs", async (_label, length) => {
    const headers = new Headers();
    if (length) headers.set("Content-Length", length);
    const result = await preflightDirectClipSource("https://cdn.test/video.mp4", {
      fetchFn: vi.fn().mockResolvedValue(new Response(null, { status: 200, headers })),
      maxSequentialBytes: 20,
    });
    expect(result.capability).toBe("large-or-unknown-sequential");
    expect(() => assertDirectClipPreflightAllowed(result, true)).toThrow(/ignored Range|did not provide/);
  });

  it("rejects malformed partial responses and unavailable sources", async () => {
    const malformed = await preflightDirectClipSource("https://cdn.test/video.mp4", {
      fetchFn: vi.fn().mockResolvedValue(new Response(null, { status: 206 })),
      maxSequentialBytes: 20,
    });
    expect(malformed.capability).toBe("unavailable");
    expect(() => assertDirectClipPreflightAllowed(malformed, false)).toThrow(/invalid Content-Range/);
  });
});
