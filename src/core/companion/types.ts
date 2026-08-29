/** Public, secret-free domain types exchanged with the native companion. */

export const COMPANION_PROTOCOL_VERSION = 1 as const;
export const COMPANION_HOST_NAME = "com.grej.media_sniper";
export const COMPANION_MAX_MESSAGE_BYTES = 256 * 1024;

export type YtDlpAuthMode = "anonymous" | "current-tab" | "brave-profile";

export type YtDlpSelectionOption =
  | {
      kind: "preset";
      key: "best" | "best-mp4" | "up-to-1080p" | "up-to-720p" | "audio-only";
      label: string;
      estimatedBytes?: number;
      expectedContainer?: string;
    }
  | {
      kind: "formats";
      key: string;
      label: string;
      videoFormatId?: string;
      audioFormatId?: string;
      estimatedBytes?: number;
      expectedContainer?: string;
    };

export interface YtDlpMediaSummary {
  extractorKey: string;
  mediaId: string;
  webpageUrl: string;
  title: string;
  durationMs?: number;
  thumbnailUrl?: string;
  uploader?: string;
  isLive: boolean;
  isDrm?: boolean;
  selections: YtDlpSelectionOption[];
  probeToken: string;
  probedAt: number;
}

export type CompanionErrorCode =
  | "COMPANION_NOT_INSTALLED"
  | "COMPANION_INCOMPATIBLE"
  | "TOOLS_MISSING"
  | "TOOLS_INCOMPATIBLE"
  | "PROTOCOL_MISMATCH"
  | "URL_UNSUPPORTED"
  | "PLAYLIST_UNSUPPORTED"
  | "LIVE_UNSUPPORTED"
  | "DRM_UNSUPPORTED"
  | "AUTH_REQUIRED"
  | "AUTH_SCOPE_INSUFFICIENT"
  | "COOKIE_PERMISSION_DENIED"
  | "FORMAT_UNAVAILABLE"
  | "SECTION_UNSUPPORTED"
  | "EXACT_CLIP_UNSUPPORTED"
  | "OUTPUT_EXISTS"
  | "DISK_FULL"
  | "JOB_INTERRUPTED"
  | "CANCELLED"
  | "INVALID_REQUEST"
  | "INTERNAL_ERROR";

export interface CompanionHealthIssue {
  code: CompanionErrorCode;
  message: string;
  recoverable: boolean;
}

export interface CompanionHealth {
  protocolVersion: 1;
  companionVersion: string;
  browserTarget: "brave" | "chrome" | "chromium" | "unknown";
  platform: "macos" | "windows" | "linux";
  ytDlpVersion?: string;
  ffmpegVersion?: string;
  ffprobeVersion?: string;
  jsRuntime?: { name: string; version: string };
  healthy: boolean;
  issues: CompanionHealthIssue[];
  braveProfiles?: Array<{ id: string; name: string }>;
  capabilities: {
    probe: boolean;
    download: boolean;
    sectionDownload: boolean;
    exactClip: boolean;
    currentTabCookies: boolean;
    braveProfileCookies: boolean;
    revealOutput: boolean;
  };
}

/** A scoped cookie record. Values are ephemeral and must never be persisted or logged. */
export interface CompanionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "no_restriction" | "lax" | "strict" | "unspecified";
  expirationDate?: number;
  hostOnly: boolean;
  session: boolean;
}

export interface CurrentTabAuthBundle {
  mode: "current-tab";
  pageUrl: string;
  referer: string;
  userAgent: string;
  cookieStoreId: string;
  incognito: boolean;
  cookies: CompanionCookie[];
}

export interface BraveProfileAuthBundle {
  mode: "brave-profile";
  profileId: string;
}

export type CompanionAuthBundle =
  | { mode: "anonymous" }
  | CurrentTabAuthBundle
  | BraveProfileAuthBundle;

export type CompanionJobStage =
  | "planning"
  | "downloading"
  | "merging"
  | "processing"
  | "saving"
  | "completed";

export interface CompanionJobProgress {
  jobId: string;
  stage: CompanionJobStage;
  downloadedBytes?: number;
  totalBytes?: number;
  percentage?: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
  mediaRole?: "audio" | "video" | "combined";
  detail?: string;
}

export interface CompanionOutputReceipt {
  jobId: string;
  outputToken: string;
  filename: string;
  finalPath: string;
  byteSize: number;
  container: string;
  durationMs?: number;
  extractorKey: string;
  mediaId: string;
  accuracy?: "keyframe-aligned" | "exact";
  actualStartMs?: number;
  actualDurationMs?: number;
}

export interface CompanionFailure {
  jobId?: string;
  code: CompanionErrorCode;
  message: string;
  recoverable: boolean;
}

export interface CompanionFallback {
  jobId: string;
  reason: "section-unsupported" | "section-invalid" | "exact-validation-failed";
  estimatedBytes?: number;
}

export interface CompanionJobSnapshot {
  jobId: string;
  sourceUrl: string;
  title: string;
  selectionLabel: string;
  kind: "download" | "clip";
  stage: CompanionJobStage | "queued" | "failed" | "cancelled";
  progress?: CompanionJobProgress;
  receipt?: CompanionOutputReceipt;
  failure?: CompanionFailure;
  fallback?: CompanionFallback;
}
