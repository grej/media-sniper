import { describe, expect, it } from "vitest";
import {
  CLIP_ERROR_CODES,
  ClippingError,
  getClipErrorDescriptor,
  isClippingError,
} from "@/core/clipping/errors";
import {
  capabilityForMode,
  supportedCapability,
  unsupportedCapability,
} from "@/core/clipping/capabilities";

describe("clipping errors", () => {
  it("defines a user message and retryability for every stable code", () => {
    for (const code of CLIP_ERROR_CODES) {
      const descriptor = getClipErrorDescriptor(code);
      expect(descriptor.userMessage.length).toBeGreaterThan(10);
      expect([
        "retryable",
        "user-action-required",
        "not-retryable",
      ]).toContain(descriptor.retryability);
    }
  });

  it("keeps developer detail separate from the safe user message", () => {
    const error = new ClippingError(
      "SOURCE_AUTH_FAILED",
      "401 for signed URL token=secret",
    );
    expect(error.message).toContain("token=secret");
    expect(error.userMessage).not.toContain("secret");
    expect(error.retryable).toBe(true);
    expect(isClippingError(error)).toBe(true);
    expect(isClippingError(new Error("different domain"))).toBe(false);
  });

  it("supports stable defaults and a caller-supplied safe message", () => {
    const defaulted = new ClippingError("DRM_PROTECTED");
    const customized = new ClippingError("OUTPUT_TOO_LARGE", "estimate", {
      userMessage: "Choose a shorter clip.",
      cause: new Error("allocation"),
    });
    expect(defaulted.detail).toBe("DRM_PROTECTED");
    expect(customized.userMessage).toBe("Choose a shorter clip.");
    expect(customized.cause).toBeInstanceOf(Error);
  });
});

describe("processing capabilities", () => {
  it("represents supported and unsupported modes", () => {
    const fast = supportedCapability("fast", {
      processor: "ffmpeg-fast-segmented",
    });
    const exact = unsupportedCapability("exact", "EXACT_CODEC_UNSUPPORTED");
    const capabilities = { fast, exact };

    expect(capabilityForMode(capabilities, "fast")).toMatchObject({
      supported: true,
      mode: "fast",
    });
    expect(capabilityForMode(capabilities, "exact")).toMatchObject({
      supported: false,
      mode: "exact",
      reasonCode: "EXACT_CODEC_UNSUPPORTED",
      retryability: "not-retryable",
    });
  });

  it("marks direct full-fetch consent as a confirmation", () => {
    expect(
      unsupportedCapability(
        "fast",
        "DIRECT_FULL_FETCH_CONFIRMATION_REQUIRED",
      ).requiresFullFetchConfirmation,
    ).toBe(true);
  });

  it("accepts a typed error or custom safe capability reason", () => {
    const error = new ClippingError("MEDIA_PROCESSING_FAILED", "decoder detail", {
      userMessage: "Try this clip again.",
    });
    expect(unsupportedCapability("exact", error)).toMatchObject({
      reason: "Try this clip again.",
      retryability: "retryable",
    });
    expect(
      unsupportedCapability("fast", "RANGE_REQUIRED", "Range is unavailable."),
    ).toMatchObject({ reason: "Range is unavailable." });
    expect(supportedCapability("fast")).toEqual({
      supported: true,
      mode: "fast",
    });
  });
});
