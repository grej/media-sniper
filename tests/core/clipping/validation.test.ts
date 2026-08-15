import { describe, expect, it } from "vitest";
import {
  assertValidClipRange,
  validateClipRange,
} from "@/core/clipping/validation";

describe("validateClipRange", () => {
  it("accepts integer millisecond boundaries", () => {
    expect(validateClipRange({ startMs: 1_000, endMs: 2_000 })).toEqual({
      valid: true,
      value: {
        startMs: 1_000,
        endMs: 2_000,
        durationMs: 1_000,
        wasEndClamped: false,
        requestedEndMs: 2_000,
        warning: undefined,
      },
    });
  });

  it.each([
    [{ startMs: Number.NaN, endMs: 1_000 }, "INVALID_CLIP_RANGE"],
    [{ startMs: 1.5, endMs: 1_000 }, "INVALID_CLIP_RANGE"],
    [{ startMs: -1, endMs: 1_000 }, "INVALID_CLIP_RANGE"],
    [{ startMs: 1_000, endMs: 1_000 }, "INVALID_CLIP_RANGE"],
    [{ startMs: 1_000, endMs: 900 }, "INVALID_CLIP_RANGE"],
  ])("rejects invalid range %j", (range, code) => {
    const result = validateClipRange(range);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.code).toBe(code);
  });

  it("enforces configurable minimum and maximum duration", () => {
    const short = validateClipRange({ startMs: 0, endMs: 249 });
    const long = validateClipRange(
      { startMs: 0, endMs: 1_001 },
      { maxDurationMs: 1_000 },
    );
    expect(short.valid).toBe(false);
    expect(long.valid).toBe(false);
  });

  it("clamps a small metadata overrun and reports it", () => {
    const result = validateClipRange(
      { startMs: 9_000, endMs: 10_400 },
      { durationMs: 10_000 },
    );
    expect(result).toMatchObject({
      valid: true,
      value: {
        endMs: 10_000,
        durationMs: 1_000,
        requestedEndMs: 10_400,
        wasEndClamped: true,
      },
    });
    if (result.valid) expect(result.value.warning).toContain("400ms");
  });

  it("does not clamp a material overrun", () => {
    const result = validateClipRange(
      { startMs: 9_000, endMs: 10_501 },
      { durationMs: 10_000 },
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.code).toBe("CLIP_OUTSIDE_DURATION");
  });

  it("rejects a start outside duration and a clamp shorter than the minimum", () => {
    const outside = validateClipRange(
      { startMs: 10_000, endMs: 11_000 },
      { durationMs: 10_000 },
    );
    const tooShortAfterClamp = validateClipRange(
      { startMs: 9_900, endMs: 10_100 },
      { durationMs: 10_000 },
    );
    expect(outside.valid).toBe(false);
    expect(tooShortAfterClamp.valid).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "rejects invalid known duration %s",
    (durationMs) => {
      const result = validateClipRange(
        { startMs: 0, endMs: 1_000 },
        { durationMs },
      );
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.code).toBe("CLIP_OUTSIDE_DURATION");
    },
  );

  it("provides an assertion form", () => {
    expect(assertValidClipRange({ startMs: 0, endMs: 250 }).durationMs).toBe(250);
    expect(() => assertValidClipRange({ startMs: 0, endMs: 249 })).toThrow();
  });

  it("rejects invalid validation configuration", () => {
    expect(() =>
      validateClipRange(
        { startMs: 0, endMs: 1_000 },
        { minDurationMs: 1_001, maxDurationMs: 1_000 },
      ),
    ).toThrow(TypeError);
    expect(() =>
      validateClipRange(
        { startMs: 0, endMs: 1_000 },
        { maxDurationMs: 0 },
      ),
    ).toThrow(TypeError);
  });
});
