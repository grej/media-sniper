import { describe, expect, it, vi } from "vitest";
import { createBoundedRangeFetch } from "@/core/media/bounded-range-fetch";

describe("createBoundedRangeFetch", () => {
  it("bounds open-ended ranges and preserves credentials", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 206 }));
    const bounded = createBoundedRangeFetch(fetchFn, 256);

    await bounded("https://cdn.test/video.mp4", {
      headers: { Range: "bytes=1024-" },
    });

    const request = fetchFn.mock.calls[0]?.[0] as Request;
    expect(request.headers.get("Range")).toBe("bytes=1024-1279");
    expect(request.credentials).toBe("include");
  });

  it("leaves already-bounded and non-range requests unchanged", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response());
    const bounded = createBoundedRangeFetch(fetchFn, 256);

    await bounded("https://cdn.test/video.mp4", {
      headers: { Range: "bytes=10-20" },
    });
    await bounded("https://cdn.test/video.mp4");

    expect((fetchFn.mock.calls[0]?.[0] as Request).headers.get("Range")).toBe("bytes=10-20");
    expect((fetchFn.mock.calls[1]?.[0] as Request).headers.get("Range")).toBeNull();
  });
});
