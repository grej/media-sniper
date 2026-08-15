import { describe, expect, it } from "vitest";
import { processMediabunnyClip } from "@/core/media/mediabunny-clip-processor";

describe("processMediabunnyClip", () => {
  it("rejects invalid ranges before reading media", async () => {
    await expect(
      processMediabunnyClip({
        input: { kind: "blob", blob: new Blob() },
        startMs: 1_000,
        endMs: 1_000,
        exact: false,
      }),
    ).rejects.toThrow("endMs > startMs");
  });

  it("honors an already-aborted signal before reading media", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      processMediabunnyClip({
        input: { kind: "blob", blob: new Blob() },
        startMs: 0,
        endMs: 1_000,
        exact: false,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
