import { describe, expect, it } from "vitest";
import { generateDownloadId } from "@/core/utils/id-utils";

describe("generateDownloadId", () => {
  it("creates distinct filesystem-safe IDs for simultaneous same-URL operations", () => {
    const url = "https://example.test/video.mp4";
    const ids = new Set(Array.from({ length: 20 }, () => generateDownloadId(url)));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});
