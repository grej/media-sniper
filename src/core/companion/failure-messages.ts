import type { CompanionErrorCode } from "./types";

const FRIENDLY_FAILURES: Record<CompanionErrorCode, string> = {
  COMPANION_NOT_INSTALLED: "Media Sniper Companion is not available. Install it, then try again.",
  COMPANION_INCOMPATIBLE: "Install the latest signed Media Sniper release, then try again.",
  TOOLS_MISSING: "Media Sniper's media tools need to be installed before this site can be used.",
  TOOLS_INCOMPATIBLE: "Media Sniper's media tools need an update to keep up with this site.",
  PROTOCOL_MISMATCH: "Install the latest signed Media Sniper release, then try again.",
  URL_UNSUPPORTED: "This page is not supported by the companion.",
  PLAYLIST_UNSUPPORTED: "Playlist downloads are not supported yet. Open a single video and try again.",
  LIVE_UNSUPPORTED: "Live media cannot be downloaded or clipped yet.",
  DRM_UNSUPPORTED: "DRM-protected media cannot be downloaded or clipped.",
  AUTH_REQUIRED: "Sign in may be required. Analyze the page again and retry using this Brave session.",
  AUTH_SCOPE_INSUFFICIENT: "This site needs broader session access. Analyze the page again to choose an access option.",
  COOKIE_PERMISSION_DENIED: "Cookie access was not granted. You can continue anonymously.",
  FORMAT_UNAVAILABLE: "That download option changed. Analyze the page again and choose an available option.",
  SECTION_UNSUPPORTED: "This site cannot download only the requested section.",
  EXACT_CLIP_UNSUPPORTED: "An exact clip could not be created. Try Fast mode instead.",
  OUTPUT_EXISTS: "A file with this name already exists. Choose a different output name and try again.",
  DISK_FULL: "There is not enough free disk space to save this media.",
  JOB_INTERRUPTED: "This operation was interrupted. Analyze the page again and retry.",
  CANCELLED: "The operation was cancelled.",
  INVALID_REQUEST: "Check the requested options and try again.",
  INTERNAL_ERROR: "Media Sniper could not complete that action. Analyze the page again and retry.",
};

export function companionFailureMessage(code: CompanionErrorCode | string | undefined): string {
  return code && Object.prototype.hasOwnProperty.call(FRIENDLY_FAILURES, code)
    ? FRIENDLY_FAILURES[code as CompanionErrorCode]
    : FRIENDLY_FAILURES.INTERNAL_ERROR;
}
