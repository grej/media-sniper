import {
  COMPANION_MAX_MESSAGE_BYTES,
  COMPANION_PROTOCOL_VERSION,
  type CompanionAuthBundle,
  type CompanionFailure,
  type CompanionFallback,
  type CompanionHealth,
  type CompanionJobProgress,
  type CompanionOutputReceipt,
  type YtDlpMediaSummary,
} from "./types";

export interface CompanionEnvelope<T = unknown> {
  protocolVersion: 1;
  requestId: string;
  type: string;
  payload: T;
}

export type CompanionRequest =
  | CompanionEnvelope<{ browserTarget: "brave" | "chrome" | "chromium" | "unknown"; extensionVersion: string }>
  | CompanionEnvelope<{ pageUrl: string; auth: CompanionAuthBundle }>
  | CompanionEnvelope<{
      jobId: string;
      probeToken: string;
      selectionKey: string;
      auth: CompanionAuthBundle;
    }>
  | CompanionEnvelope<{
      jobId: string;
      probeToken: string;
      selectionKey: string;
      clip: { startMs: number; endMs: number; mode: "fast" | "exact" };
      allowFullDownloadFallback: boolean;
      auth: CompanionAuthBundle;
    }>
  | CompanionEnvelope<{ jobId: string }>
  | CompanionEnvelope<{ outputToken: string }>
  | CompanionEnvelope<Record<string, never>>;

export type CompanionEvent =
  | CompanionEnvelope<CompanionHealth>
  | CompanionEnvelope<YtDlpMediaSummary>
  | CompanionEnvelope<CompanionFailure>
  | CompanionEnvelope<{ jobId: string; position: number }>
  | CompanionEnvelope<CompanionJobProgress>
  | CompanionEnvelope<CompanionFallback>
  | CompanionEnvelope<CompanionOutputReceipt>
  | CompanionEnvelope<{ jobId: string }>
  | CompanionEnvelope<{ stage: string; percentage?: number; detail?: string }>;

const REQUEST_TYPES = new Set([
  "hello",
  "probe",
  "start_download",
  "start_clip",
  "cancel_job",
  "reveal_output",
  "open_output",
  "install_tools",
  "update_tools",
]);

const EVENT_TYPES = new Set([
  "hello_result",
  "probe_result",
  "auth_required",
  "job_queued",
  "job_progress",
  "fallback_required",
  "job_completed",
  "job_failed",
  "job_cancelled",
  "tool_progress",
]);

const ERROR_CODES = new Set([
  "COMPANION_NOT_INSTALLED",
  "COMPANION_INCOMPATIBLE",
  "TOOLS_MISSING",
  "TOOLS_INCOMPATIBLE",
  "PROTOCOL_MISMATCH",
  "URL_UNSUPPORTED",
  "PLAYLIST_UNSUPPORTED",
  "LIVE_UNSUPPORTED",
  "DRM_UNSUPPORTED",
  "AUTH_REQUIRED",
  "AUTH_SCOPE_INSUFFICIENT",
  "COOKIE_PERMISSION_DENIED",
  "FORMAT_UNAVAILABLE",
  "SECTION_UNSUPPORTED",
  "EXACT_CLIP_UNSUPPORTED",
  "OUTPUT_EXISTS",
  "DISK_FULL",
  "JOB_INTERRUPTED",
  "CANCELLED",
  "INVALID_REQUEST",
  "INTERNAL_ERROR",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializedSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(record).every((key) => set.has(key));
}

function boundedString(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function optionalBoundedString(value: unknown, max = 4096): boolean {
  return value === undefined || boundedString(value, max);
}

function nonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || nonNegativeNumber(value);
}

function integer(value: unknown, minimum = 0): boolean {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function httpUrl(value: unknown): value is string {
  if (!boundedString(value, 8192)) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function validAuth(value: unknown): boolean {
  if (!isRecord(value) || !boundedString(value.mode, 32)) return false;
  if (value.mode === "anonymous") return onlyKeys(value, ["mode"]);
  if (value.mode === "brave-profile") {
    return onlyKeys(value, ["mode", "profileId"]) && boundedString(value.profileId, 128);
  }
  if (value.mode !== "current-tab") return false;
  if (!onlyKeys(value, ["mode", "pageUrl", "referer", "userAgent", "cookieStoreId", "incognito", "cookies"])) return false;
  if (!httpUrl(value.pageUrl) || !httpUrl(value.referer) || !boundedString(value.userAgent, 1024) ||
      !boundedString(value.cookieStoreId, 128) || typeof value.incognito !== "boolean" ||
      !Array.isArray(value.cookies) || value.cookies.length > 2048) return false;
  return value.cookies.every((cookie) => {
    if (!isRecord(cookie) || !onlyKeys(cookie, ["name", "value", "domain", "path", "secure", "httpOnly", "sameSite", "expirationDate", "hostOnly", "session"])) return false;
    return typeof cookie.name === "string" && cookie.name.length <= 1024 &&
      typeof cookie.value === "string" && cookie.value.length <= 8192 &&
      boundedString(cookie.domain, 1024) && boundedString(cookie.path, 2048) &&
      typeof cookie.secure === "boolean" && typeof cookie.httpOnly === "boolean" &&
      ["no_restriction", "lax", "strict", "unspecified"].includes(String(cookie.sameSite)) &&
      (cookie.expirationDate === undefined || nonNegativeNumber(cookie.expirationDate)) &&
      typeof cookie.hostOnly === "boolean" && typeof cookie.session === "boolean";
  });
}

function validSelection(value: unknown): boolean {
  if (!isRecord(value) || !onlyKeys(value, ["kind", "key", "label", "estimatedBytes", "expectedContainer", "videoFormatId", "audioFormatId"])) return false;
  if ((value.kind !== "preset" && value.kind !== "formats") || !boundedString(value.key, 128) || !boundedString(value.label, 512)) return false;
  if (!optionalNonNegativeNumber(value.estimatedBytes) || !optionalBoundedString(value.expectedContainer, 32) ||
      !optionalBoundedString(value.videoFormatId, 128) || !optionalBoundedString(value.audioFormatId, 128)) return false;
  if (value.kind === "preset" && !["best", "best-mp4", "up-to-1080p", "up-to-720p", "audio-only"].includes(String(value.key))) return false;
  return true;
}

function validSummary(value: unknown): boolean {
  if (!isRecord(value) || !onlyKeys(value, ["extractorKey", "mediaId", "webpageUrl", "title", "durationMs", "thumbnailUrl", "uploader", "isLive", "isDrm", "selections", "probeToken", "probedAt"])) return false;
  return boundedString(value.extractorKey, 128) && boundedString(value.mediaId, 512) &&
    httpUrl(value.webpageUrl) && boundedString(value.title, 4096) &&
    (value.durationMs === undefined || integer(value.durationMs)) &&
    (value.thumbnailUrl === undefined || httpUrl(value.thumbnailUrl)) &&
    optionalBoundedString(value.uploader, 1024) && typeof value.isLive === "boolean" &&
    (value.isDrm === undefined || typeof value.isDrm === "boolean") &&
    Array.isArray(value.selections) && value.selections.length <= 128 &&
    value.selections.every(validSelection) && boundedString(value.probeToken, 512) && integer(value.probedAt);
}

function validFailure(value: unknown): boolean {
  return isRecord(value) && onlyKeys(value, ["jobId", "code", "message", "recoverable"]) &&
    optionalBoundedString(value.jobId, 128) && ERROR_CODES.has(String(value.code)) &&
    boundedString(value.message, 4096) && typeof value.recoverable === "boolean";
}

function validHealth(value: unknown): boolean {
  if (!isRecord(value) || !onlyKeys(value, ["protocolVersion", "companionVersion", "browserTarget", "platform", "ytDlpVersion", "ffmpegVersion", "ffprobeVersion", "jsRuntime", "healthy", "issues", "capabilities", "braveProfiles"])) return false;
  if (value.protocolVersion !== 1 || !boundedString(value.companionVersion, 64) ||
      !["brave", "chrome", "chromium", "unknown"].includes(String(value.browserTarget)) ||
      !["macos", "windows", "linux"].includes(String(value.platform)) ||
      !optionalBoundedString(value.ytDlpVersion, 128) ||
      !optionalBoundedString(value.ffmpegVersion, 128) ||
      !optionalBoundedString(value.ffprobeVersion, 128) ||
      typeof value.healthy !== "boolean" || !Array.isArray(value.issues) || value.issues.length > 64 ||
      !isRecord(value.capabilities)) return false;
  if (value.jsRuntime !== undefined &&
      (!isRecord(value.jsRuntime) || !onlyKeys(value.jsRuntime, ["name", "version"]) ||
       !boundedString(value.jsRuntime.name, 64) || !boundedString(value.jsRuntime.version, 128))) return false;
  const capabilities = value.capabilities;
  if (!onlyKeys(capabilities, ["probe", "download", "sectionDownload", "exactClip", "currentTabCookies", "braveProfileCookies", "revealOutput"]) ||
      !Object.values(capabilities).every((entry) => typeof entry === "boolean")) return false;
  if (!value.issues.every(validFailure)) return false;
  return value.braveProfiles === undefined || (Array.isArray(value.braveProfiles) && value.braveProfiles.length <= 128 && value.braveProfiles.every((profile) =>
    isRecord(profile) && onlyKeys(profile, ["id", "name"]) && boundedString(profile.id, 128) && boundedString(profile.name, 512)));
}

function validRequestPayload(type: string, payload: Record<string, unknown>): boolean {
  switch (type) {
    case "hello":
      return onlyKeys(payload, ["browserTarget", "extensionVersion"]) &&
        ["brave", "chrome", "chromium", "unknown"].includes(String(payload.browserTarget)) &&
        boundedString(payload.extensionVersion, 64);
    case "probe":
      return onlyKeys(payload, ["pageUrl", "auth"]) && httpUrl(payload.pageUrl) && validAuth(payload.auth);
    case "start_download":
      return onlyKeys(payload, ["jobId", "probeToken", "selectionKey", "auth"]) &&
        boundedString(payload.jobId, 128) && boundedString(payload.probeToken, 512) &&
        boundedString(payload.selectionKey, 128) && validAuth(payload.auth);
    case "start_clip": {
      if (!onlyKeys(payload, ["jobId", "probeToken", "selectionKey", "clip", "allowFullDownloadFallback", "auth"]) ||
          !boundedString(payload.jobId, 128) || !boundedString(payload.probeToken, 512) ||
          !boundedString(payload.selectionKey, 128) || typeof payload.allowFullDownloadFallback !== "boolean" ||
          !validAuth(payload.auth) || !isRecord(payload.clip)) return false;
      const clip = payload.clip;
      return onlyKeys(clip, ["startMs", "endMs", "mode"]) && integer(clip.startMs) && integer(clip.endMs, 1) &&
        (clip.endMs as number) > (clip.startMs as number) && (clip.mode === "fast" || clip.mode === "exact");
    }
    case "cancel_job":
      return onlyKeys(payload, ["jobId"]) && boundedString(payload.jobId, 128);
    case "reveal_output":
    case "open_output":
      return onlyKeys(payload, ["outputToken"]) && boundedString(payload.outputToken, 512);
    case "install_tools":
    case "update_tools":
      return onlyKeys(payload, []);
    default:
      return false;
  }
}

function validEventPayload(type: string, payload: Record<string, unknown>): boolean {
  switch (type) {
    case "hello_result": return validHealth(payload);
    case "probe_result": return validSummary(payload);
    case "auth_required":
    case "job_failed": return validFailure(payload);
    case "job_queued": return onlyKeys(payload, ["jobId", "position"]) && boundedString(payload.jobId, 128) && integer(payload.position);
    case "job_progress":
      return onlyKeys(payload, ["jobId", "stage", "downloadedBytes", "totalBytes", "percentage", "speedBytesPerSecond", "etaSeconds", "mediaRole", "detail"]) &&
        boundedString(payload.jobId, 128) && ["planning", "downloading", "merging", "processing", "saving", "completed"].includes(String(payload.stage)) &&
        optionalNonNegativeNumber(payload.downloadedBytes) && optionalNonNegativeNumber(payload.totalBytes) &&
        (payload.percentage === undefined || (nonNegativeNumber(payload.percentage) && (payload.percentage as number) <= 100)) &&
        optionalNonNegativeNumber(payload.speedBytesPerSecond) && optionalNonNegativeNumber(payload.etaSeconds) &&
        (payload.mediaRole === undefined || ["audio", "video", "combined"].includes(String(payload.mediaRole))) &&
        optionalBoundedString(payload.detail, 4096);
    case "fallback_required":
      return onlyKeys(payload, ["jobId", "reason", "estimatedBytes"]) && boundedString(payload.jobId, 128) &&
        ["section-unsupported", "section-invalid", "exact-validation-failed"].includes(String(payload.reason)) &&
        optionalNonNegativeNumber(payload.estimatedBytes);
    case "job_completed":
      return onlyKeys(payload, ["jobId", "outputToken", "filename", "finalPath", "byteSize", "container", "durationMs", "extractorKey", "mediaId", "accuracy", "actualStartMs", "actualDurationMs"]) &&
        boundedString(payload.jobId, 128) && boundedString(payload.outputToken, 512) && boundedString(payload.filename, 1024) &&
        boundedString(payload.finalPath, 8192) && integer(payload.byteSize) && boundedString(payload.container, 32) &&
        optionalNonNegativeNumber(payload.durationMs) && boundedString(payload.extractorKey, 128) && boundedString(payload.mediaId, 512) &&
        (payload.accuracy === undefined || payload.accuracy === "keyframe-aligned" || payload.accuracy === "exact") &&
        optionalNonNegativeNumber(payload.actualStartMs) && optionalNonNegativeNumber(payload.actualDurationMs);
    case "job_cancelled":
      return onlyKeys(payload, ["jobId"]) && boundedString(payload.jobId, 128);
    case "tool_progress":
      return onlyKeys(payload, ["stage", "percentage", "detail"]) && boundedString(payload.stage, 128) &&
        (payload.percentage === undefined || (nonNegativeNumber(payload.percentage) && (payload.percentage as number) <= 100)) &&
        optionalBoundedString(payload.detail, 4096);
    default:
      return false;
  }
}

export function isCompanionEnvelope(value: unknown): value is CompanionEnvelope {
  if (!isRecord(value)) return false;
  return (
    value.protocolVersion === COMPANION_PROTOCOL_VERSION &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    value.requestId.length <= 128 &&
    typeof value.type === "string" &&
    value.type.length > 0 &&
    isRecord(value.payload) &&
    serializedSize(value) <= COMPANION_MAX_MESSAGE_BYTES
  );
}

export function validateCompanionRequest(value: unknown): value is CompanionRequest {
  return isCompanionEnvelope(value) && REQUEST_TYPES.has(value.type) &&
    validRequestPayload(value.type, value.payload as Record<string, unknown>);
}

export function validateCompanionEvent(value: unknown): value is CompanionEvent {
  return isCompanionEnvelope(value) && EVENT_TYPES.has(value.type) &&
    validEventPayload(value.type, value.payload as Record<string, unknown>);
}

export function createCompanionEnvelope<T>(
  type: string,
  requestId: string,
  payload: T,
): CompanionEnvelope<T> {
  const envelope: CompanionEnvelope<T> = {
    protocolVersion: COMPANION_PROTOCOL_VERSION,
    requestId,
    type,
    payload,
  };
  if (!isCompanionEnvelope(envelope)) throw new TypeError("Invalid companion message envelope");
  return envelope;
}
