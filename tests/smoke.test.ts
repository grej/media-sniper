import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("provides a DOM and IndexedDB", () => {
    expect(document.createElement("video")).toBeInstanceOf(HTMLVideoElement);
    expect(indexedDB).toBeDefined();
  });
});
