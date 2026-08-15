import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "@/core/storage/settings";
import {
  DEFAULT_CLIP_MODE,
  DEFAULT_CLIP_OVERLAY_ENABLED,
  DEFAULT_DIRECT_NO_RANGE_MAX_BYTES,
  DEFAULT_MAX_CLIP_DURATION_MS,
  DEFAULT_MAX_IN_MEMORY_CLIP_BYTES,
  DEFAULT_MEDIABUNNY_CACHE_BYTES,
  DEFAULT_MEDIABUNNY_PARALLELISM,
  STORAGE_CONFIG_KEY,
} from "@/shared/constants";

function stubStorage(value: unknown): void {
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async () => ({ [STORAGE_CONFIG_KEY]: value })),
      },
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("clipping settings", () => {
  it("resolves all safe defaults", async () => {
    stubStorage(null);
    const settings = await loadSettings();
    expect(settings.clipping).toEqual({
      maxClipDurationMs: DEFAULT_MAX_CLIP_DURATION_MS,
      maxInMemoryClipBytes: DEFAULT_MAX_IN_MEMORY_CLIP_BYTES,
      directNoRangeMaxBytes: DEFAULT_DIRECT_NO_RANGE_MAX_BYTES,
      mediabunnyCacheBytes: DEFAULT_MEDIABUNNY_CACHE_BYTES,
      mediabunnyParallelism: DEFAULT_MEDIABUNNY_PARALLELISM,
      overlayEnabled: DEFAULT_CLIP_OVERLAY_ENABLED,
      defaultMode: DEFAULT_CLIP_MODE,
    });
  });

  it("preserves configured clipping limits", async () => {
    stubStorage({
      clipping: {
        maxClipDurationMs: 12_000,
        maxInMemoryClipBytes: 1_000_000,
        directNoRangeMaxBytes: 500_000,
        mediabunnyCacheBytes: 250_000,
        mediabunnyParallelism: 1,
        overlayEnabled: true,
        defaultMode: "exact",
      },
    });
    expect((await loadSettings()).clipping).toEqual({
      maxClipDurationMs: 12_000,
      maxInMemoryClipBytes: 1_000_000,
      directNoRangeMaxBytes: 500_000,
      mediabunnyCacheBytes: 250_000,
      mediabunnyParallelism: 1,
      overlayEnabled: true,
      defaultMode: "exact",
    });
  });
});
