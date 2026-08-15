import type { ClipSpec } from "./types";
import { ClippingError } from "./errors";

export const DEFAULT_MIN_CLIP_DURATION_MS = 250;
export const DEFAULT_MAX_CLIP_DURATION_MS = 60 * 60 * 1_000;
export const DEFAULT_METADATA_TOLERANCE_MS = 500;

export interface ClipRangeValidationOptions {
  durationMs?: number;
  minDurationMs?: number;
  maxDurationMs?: number;
  metadataToleranceMs?: number;
}

export interface ValidatedClipRange {
  startMs: number;
  endMs: number;
  durationMs: number;
  wasEndClamped: boolean;
  requestedEndMs: number;
  warning?: string;
}

export type ClipRangeValidationResult =
  | { valid: true; value: ValidatedClipRange }
  | { valid: false; error: ClippingError };

function invalidRange(detail: string, userMessage?: string): ClippingError {
  return new ClippingError(
    "INVALID_CLIP_RANGE",
    detail,
    userMessage ? { userMessage } : undefined,
  );
}

function validateOption(name: string, value: number, allowZero = false): void {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new TypeError(`${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
}

export function validateClipRange(
  clip: Pick<ClipSpec, "startMs" | "endMs">,
  options: ClipRangeValidationOptions = {},
): ClipRangeValidationResult {
  const minDurationMs = options.minDurationMs ?? DEFAULT_MIN_CLIP_DURATION_MS;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_CLIP_DURATION_MS;
  const toleranceMs = options.metadataToleranceMs ?? DEFAULT_METADATA_TOLERANCE_MS;

  validateOption("minDurationMs", minDurationMs, true);
  validateOption("maxDurationMs", maxDurationMs);
  validateOption("metadataToleranceMs", toleranceMs, true);
  if (maxDurationMs < minDurationMs) {
    throw new TypeError("maxDurationMs must be greater than or equal to minDurationMs");
  }

  const { startMs, endMs } = clip;
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) {
    return { valid: false, error: invalidRange("Clip boundaries must be finite integer milliseconds") };
  }
  if (startMs < 0) {
    return { valid: false, error: invalidRange("startMs must be greater than or equal to zero") };
  }
  if (endMs <= startMs) {
    return { valid: false, error: invalidRange("endMs must be greater than startMs") };
  }

  let validatedEndMs = endMs;
  let wasEndClamped = false;
  let warning: string | undefined;

  if (options.durationMs !== undefined) {
    const durationMs = options.durationMs;
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
      return {
        valid: false,
        error: new ClippingError("CLIP_OUTSIDE_DURATION", "Known media duration must be a positive integer"),
      };
    }
    if (startMs >= durationMs) {
      return {
        valid: false,
        error: new ClippingError(
          "CLIP_OUTSIDE_DURATION",
          `Clip start ${startMs}ms is outside duration ${durationMs}ms`,
        ),
      };
    }
    if (endMs > durationMs) {
      const overrunMs = endMs - durationMs;
      if (overrunMs > toleranceMs) {
        return {
          valid: false,
          error: new ClippingError(
            "CLIP_OUTSIDE_DURATION",
            `Clip end exceeds duration by ${overrunMs}ms (tolerance ${toleranceMs}ms)`,
          ),
        };
      }
      validatedEndMs = durationMs;
      wasEndClamped = true;
      warning = `End time was adjusted by ${overrunMs}ms to match the media duration.`;
    }
  }

  const durationMs = validatedEndMs - startMs;
  if (durationMs < minDurationMs) {
    return {
      valid: false,
      error: invalidRange(
        `Clip duration ${durationMs}ms is below minimum ${minDurationMs}ms`,
        `Clip duration must be at least ${minDurationMs} milliseconds.`,
      ),
    };
  }
  if (durationMs > maxDurationMs) {
    return {
      valid: false,
      error: invalidRange(
        `Clip duration ${durationMs}ms exceeds maximum ${maxDurationMs}ms`,
        `Clip duration cannot exceed ${maxDurationMs} milliseconds.`,
      ),
    };
  }

  return {
    valid: true,
    value: {
      startMs,
      endMs: validatedEndMs,
      durationMs,
      wasEndClamped,
      requestedEndMs: endMs,
      warning,
    },
  };
}

export function assertValidClipRange(
  clip: Pick<ClipSpec, "startMs" | "endMs">,
  options: ClipRangeValidationOptions = {},
): ValidatedClipRange {
  const result = validateClipRange(clip, options);
  if (!result.valid) throw result.error;
  return result.value;
}
