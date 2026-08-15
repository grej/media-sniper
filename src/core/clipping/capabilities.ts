import {
  ClippingError,
  getClipErrorDescriptor,
  type ClipErrorCode,
  type ClipErrorRetryability,
} from "./errors";
import type { ClipMode } from "./types";

export interface ProcessingCapability {
  supported: boolean;
  mode: ClipMode;
  processor?: "ffmpeg-fast-segmented" | "mediabunny-direct" | "mediabunny-exact-local";
  reasonCode?: ClipErrorCode;
  reason?: string;
  retryability?: ClipErrorRetryability;
  requiresFullFetchConfirmation?: boolean;
  warnings?: string[];
}

export interface ClipCapabilities {
  fast: ProcessingCapability;
  exact: ProcessingCapability;
}

export function supportedCapability(
  mode: ClipMode,
  details: Omit<ProcessingCapability, "supported" | "mode" | "reasonCode" | "reason"> = {},
): ProcessingCapability {
  return { supported: true, mode, ...details };
}

export function unsupportedCapability(
  mode: ClipMode,
  reason: ClipErrorCode | ClippingError,
  userMessage?: string,
): ProcessingCapability {
  const code = reason instanceof ClippingError ? reason.code : reason;
  const descriptor = getClipErrorDescriptor(code);
  return {
    supported: false,
    mode,
    reasonCode: code,
    reason: userMessage ?? (reason instanceof ClippingError ? reason.userMessage : descriptor.userMessage),
    retryability: reason instanceof ClippingError ? reason.retryability : descriptor.retryability,
    requiresFullFetchConfirmation:
      code === "DIRECT_FULL_FETCH_CONFIRMATION_REQUIRED",
  };
}

export function capabilityForMode(
  capabilities: ClipCapabilities,
  mode: ClipMode,
): ProcessingCapability {
  return capabilities[mode];
}
