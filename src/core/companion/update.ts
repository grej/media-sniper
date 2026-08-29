export const MEDIA_SNIPER_PACKAGE_OWNER = "gjennings";
export const MEDIA_SNIPER_PACKAGE_NAME = "media-sniper-installer";
export const MEDIA_SNIPER_UPDATE_API =
  `https://api.anaconda.org/package/${MEDIA_SNIPER_PACKAGE_OWNER}/${MEDIA_SNIPER_PACKAGE_NAME}`;
export const MEDIA_SNIPER_UPDATE_COMMAND =
  "pixi exec --force-reinstall --channel gjennings --channel conda-forge media-sniper-installer";
export const MEDIA_SNIPER_UPDATE_HELP_URL =
  "https://github.com/grej/media-sniper/blob/main/docs/companion/install-macos.md";
export const MAX_UPDATE_METADATA_BYTES = 64 * 1024;
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
export const PENDING_UPDATE_TTL_MS = 10 * 60 * 1000;
export const UPDATE_STARTUP_MIN_MINUTES = 5;
export const UPDATE_STARTUP_MAX_MINUTES = 30;

export type MacPackageSubdir = "osx-arm64" | "osx-64";

export interface AvailableRelease {
  version: string;
  publishedAt?: string;
  subdir: MacPackageSubdir;
}

export interface PersistedUpdateState {
  lastSuccessfulCheckAt?: number;
  latestVersion?: string;
  latestVersionPublishedAt?: string;
  dismissedVersion?: string;
  snoozeUntil?: number;
  lastFailureAt?: number;
}

export interface UpdateViewState extends PersistedUpdateState {
  currentVersion: string;
  updateAvailable: boolean;
  checking: boolean;
  copied?: boolean;
  installationChecked?: boolean;
  finishReady?: boolean;
  busyReason?: string;
  installedVersion?: string;
  error?: string;
}

export interface PendingPostUpdate {
  expectedVersion: string;
  tabId: number;
  normalizedUrl: string;
  createdAt: number;
  expiresAt: number;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStableSemver(value: unknown): [number, number, number] | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number) as [number, number, number];
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function compareStableSemver(left: string, right: string): number {
  const leftParts = parseStableSemver(left);
  const rightParts = parseStableSemver(right);
  if (!leftParts || !rightParts) throw new Error("Invalid stable release version");
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

export function parseAnacondaPackageMetadata(
  text: string,
  subdir: MacPackageSubdir,
): AvailableRelease {
  if (new TextEncoder().encode(text).byteLength > MAX_UPDATE_METADATA_BYTES) {
    throw new Error("Update metadata is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Update metadata is not valid JSON");
  }
  if (!record(parsed) ||
      parsed.name !== MEDIA_SNIPER_PACKAGE_NAME ||
      parsed.full_name !== `${MEDIA_SNIPER_PACKAGE_OWNER}/${MEDIA_SNIPER_PACKAGE_NAME}` ||
      !record(parsed.owner) || parsed.owner.login !== MEDIA_SNIPER_PACKAGE_OWNER ||
      !Array.isArray(parsed.files)) {
    throw new Error("Update metadata has the wrong package identity");
  }
  const version = parsed.latest_version;
  if (!parseStableSemver(version)) throw new Error("Update metadata has an invalid release version");
  const candidates = parsed.files.filter((value): value is RecordValue => {
    if (!record(value) || value.version !== version || value.owner !== MEDIA_SNIPER_PACKAGE_OWNER ||
        !record(value.attrs) || value.attrs.subdir !== subdir ||
        !Array.isArray(value.labels) || !value.labels.includes("main")) return false;
    return typeof value.basename === "string" && value.basename.startsWith(`${subdir}/${MEDIA_SNIPER_PACKAGE_NAME}-${version}-`);
  });
  if (!candidates.length) throw new Error(`Release ${String(version)} is unavailable for ${subdir}`);
  const publishedAt = candidates
    .map((candidate) => candidate.upload_time)
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort()
    .at(-1);
  return { version: version as string, publishedAt, subdir };
}

export function shouldRunScheduledCheck(
  state: PersistedUpdateState,
  now: number,
): boolean {
  return !state.lastSuccessfulCheckAt || now - state.lastSuccessfulCheckAt >= UPDATE_CHECK_INTERVAL_MS;
}

export function updateAlarmSchedule(randomValue: number): {
  delayInMinutes: number;
  periodInMinutes: number;
} {
  const bounded = Math.max(0, Math.min(0.999999999, randomValue));
  return {
    delayInMinutes: UPDATE_STARTUP_MIN_MINUTES +
      bounded * (UPDATE_STARTUP_MAX_MINUTES - UPDATE_STARTUP_MIN_MINUTES),
    periodInMinutes: UPDATE_CHECK_INTERVAL_MS / 60_000,
  };
}

export function updateIsVisible(
  state: PersistedUpdateState,
  currentVersion: string,
  now: number,
): boolean {
  if (!state.latestVersion || !parseStableSemver(state.latestVersion) ||
      compareStableSemver(state.latestVersion, currentVersion) <= 0) return false;
  return !(state.dismissedVersion === state.latestVersion && (state.snoozeUntil ?? 0) > now);
}

export function createPendingPostUpdate(
  expectedVersion: string,
  tabId: number,
  normalizedUrl: string,
  now: number,
): PendingPostUpdate {
  if (!parseStableSemver(expectedVersion) || !Number.isSafeInteger(tabId) || tabId < 0) {
    throw new Error("Invalid pending update marker");
  }
  const url = new URL(normalizedUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid update tab URL");
  url.hash = "";
  return {
    expectedVersion,
    tabId,
    normalizedUrl: url.toString(),
    createdAt: now,
    expiresAt: now + PENDING_UPDATE_TTL_MS,
  };
}

export function validatePendingPostUpdate(
  value: unknown,
  installedVersion: string,
  now: number,
): value is PendingPostUpdate {
  if (!record(value) || value.expectedVersion !== installedVersion ||
      !parseStableSemver(value.expectedVersion) || !Number.isSafeInteger(value.tabId) ||
      typeof value.normalizedUrl !== "string" || typeof value.createdAt !== "number" ||
      typeof value.expiresAt !== "number" || !Number.isFinite(value.createdAt) ||
      !Number.isFinite(value.expiresAt) || value.expiresAt < now ||
      value.expiresAt - value.createdAt !== PENDING_UPDATE_TTL_MS) return false;
  try {
    const url = new URL(value.normalizedUrl);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.hash;
  } catch {
    return false;
  }
}
