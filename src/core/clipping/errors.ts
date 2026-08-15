export const CLIP_ERROR_CODES = [
  "INVALID_CLIP_RANGE",
  "CLIP_OUTSIDE_DURATION",
  "PLAYBACK_TARGET_AMBIGUOUS",
  "NO_TIMELINE",
  "UNSUPPORTED_MULTI_PERIOD_DASH",
  "HLS_DISCONTINUITY_UNSUPPORTED",
  "RANGE_REQUIRED",
  "DIRECT_FULL_FETCH_CONFIRMATION_REQUIRED",
  "SOURCE_AUTH_FAILED",
  "EXACT_CODEC_UNSUPPORTED",
  "MEDIA_PROCESSING_FAILED",
  "OUTPUT_TOO_LARGE",
  "DRM_PROTECTED",
] as const;

export type ClipErrorCode = (typeof CLIP_ERROR_CODES)[number];

export type ClipErrorRetryability =
  | "retryable"
  | "user-action-required"
  | "not-retryable";

export interface ClipErrorDescriptor {
  userMessage: string;
  retryability: ClipErrorRetryability;
}

const ERROR_DESCRIPTORS: Record<ClipErrorCode, ClipErrorDescriptor> = {
  INVALID_CLIP_RANGE: {
    userMessage: "Enter a valid clip range with an end time after the start time.",
    retryability: "user-action-required",
  },
  CLIP_OUTSIDE_DURATION: {
    userMessage: "The clip range falls outside the available media duration.",
    retryability: "user-action-required",
  },
  PLAYBACK_TARGET_AMBIGUOUS: {
    userMessage: "Choose which page video should provide the clip timestamps.",
    retryability: "user-action-required",
  },
  NO_TIMELINE: {
    userMessage: "This media source does not expose a timeline that can be clipped.",
    retryability: "not-retryable",
  },
  UNSUPPORTED_MULTI_PERIOD_DASH: {
    userMessage: "Clips that cross multiple DASH periods are not supported.",
    retryability: "not-retryable",
  },
  HLS_DISCONTINUITY_UNSUPPORTED: {
    userMessage: "This clip crosses a stream discontinuity that is not supported in the selected mode.",
    retryability: "user-action-required",
  },
  RANGE_REQUIRED: {
    userMessage: "This source must support byte-range requests to create a clip efficiently.",
    retryability: "not-retryable",
  },
  DIRECT_FULL_FETCH_CONFIRMATION_REQUIRED: {
    userMessage: "This source may require downloading the full media file. Confirm before continuing.",
    retryability: "user-action-required",
  },
  SOURCE_AUTH_FAILED: {
    userMessage: "The media source rejected the request. Reload the page or sign in, then try again.",
    retryability: "retryable",
  },
  EXACT_CODEC_UNSUPPORTED: {
    userMessage: "This browser cannot decode or encode the required tracks for Exact mode.",
    retryability: "not-retryable",
  },
  MEDIA_PROCESSING_FAILED: {
    userMessage: "The browser could not process this clip. Try again or use Fast mode.",
    retryability: "retryable",
  },
  OUTPUT_TOO_LARGE: {
    userMessage: "The estimated clip output exceeds the configured in-memory size limit.",
    retryability: "user-action-required",
  },
  DRM_PROTECTED: {
    userMessage: "DRM-protected media cannot be clipped.",
    retryability: "not-retryable",
  },
};

export function getClipErrorDescriptor(code: ClipErrorCode): ClipErrorDescriptor {
  return ERROR_DESCRIPTORS[code];
}

export class ClippingError extends Error {
  readonly code: ClipErrorCode;
  readonly detail: string;
  readonly userMessage: string;
  readonly retryability: ClipErrorRetryability;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(
    code: ClipErrorCode,
    detail?: string,
    options: { userMessage?: string; cause?: unknown } = {},
  ) {
    const descriptor = getClipErrorDescriptor(code);
    const developerDetail = detail?.trim() || code;
    super(developerDetail);
    this.name = "ClippingError";
    this.code = code;
    this.detail = developerDetail;
    this.userMessage = options.userMessage ?? descriptor.userMessage;
    this.retryability = descriptor.retryability;
    this.retryable = descriptor.retryability === "retryable";
    this.cause = options.cause;
  }
}

export function isClippingError(error: unknown): error is ClippingError {
  return error instanceof ClippingError;
}
