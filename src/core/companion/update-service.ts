import { getActiveDownloads } from "../database/downloads";
import type { CompanionHealth } from "./types";
import { restartCompanionConnection } from "./service";
import {
  MAX_UPDATE_METADATA_BYTES,
  MEDIA_SNIPER_UPDATE_API,
  MEDIA_SNIPER_UPDATE_COMMAND,
  UPDATE_SNOOZE_MS,
  compareStableSemver,
  createPendingPostUpdate,
  parseAnacondaPackageMetadata,
  parseStableSemver,
  shouldRunScheduledCheck,
  updateIsVisible,
  updateAlarmSchedule,
  validatePendingPostUpdate,
  type MacPackageSubdir,
  type PendingPostUpdate,
  type PersistedUpdateState,
  type UpdateViewState,
} from "./update";

export const CompanionUpdateUiMessage = {
  GET_STATE: "COMPANION_UPDATE_GET_STATE",
  CHECK: "COMPANION_UPDATE_CHECK",
  SNOOZE: "COMPANION_UPDATE_SNOOZE",
  CHECK_INSTALLATION: "COMPANION_UPDATE_CHECK_INSTALLATION",
  FINISH: "COMPANION_UPDATE_FINISH",
  CHANGED: "COMPANION_UPDATE_CHANGED",
} as const;

const UPDATE_ALARM = "media-sniper-companion-update-check";
const UPDATE_STORAGE_KEY = "mediaSniperCompanionUpdate";
const PENDING_STORAGE_KEY = "mediaSniperPendingPostUpdate";
const FETCH_TIMEOUT_MS = 8_000;

let registered = false;
let checking = false;
let postUpdateCompletionRunning = false;
let transient: Pick<UpdateViewState, "installationChecked" | "finishReady" | "busyReason" | "installedVersion" | "error"> = {};

function currentVersion(): string {
  return chrome.runtime.getManifest().version;
}

async function persistedState(): Promise<PersistedUpdateState> {
  const stored = await chrome.storage.local.get(UPDATE_STORAGE_KEY);
  const value = stored[UPDATE_STORAGE_KEY];
  return typeof value === "object" && value !== null ? value as PersistedUpdateState : {};
}

async function saveState(state: PersistedUpdateState): Promise<void> {
  await chrome.storage.local.set({ [UPDATE_STORAGE_KEY]: state });
}

async function viewState(now = Date.now()): Promise<UpdateViewState> {
  const stored = await persistedState();
  return {
    ...stored,
    ...transient,
    currentVersion: currentVersion(),
    updateAvailable: updateIsVisible(stored, currentVersion(), now),
    checking,
  };
}

async function refreshBadge(now = Date.now()): Promise<void> {
  const state = await persistedState();
  const visible = updateIsVisible(state, currentVersion(), now);
  await chrome.action.setBadgeBackgroundColor({ color: "#3478f6" });
  await chrome.action.setBadgeText({ text: visible ? "↑" : "" });
}

function notifyViews(): void {
  void chrome.runtime.sendMessage({ type: CompanionUpdateUiMessage.CHANGED }).catch(() => undefined);
}

async function packageSubdir(): Promise<MacPackageSubdir> {
  const platform = await chrome.runtime.getPlatformInfo();
  if (platform.os !== "mac") throw new Error("Media Sniper Companion updates are currently available for macOS only.");
  if (platform.arch === "arm" || platform.arch === "arm64") return "osx-arm64";
  if (platform.arch === "x86-64") return "osx-64";
  throw new Error("No Media Sniper installer is available for this Mac architecture.");
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_UPDATE_METADATA_BYTES) {
      throw new Error("The update response is too large.");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_UPDATE_METADATA_BYTES) {
      await reader.cancel();
      throw new Error("The update response is too large.");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}

async function downloadMetadata(subdir: MacPackageSubdir): Promise<ReturnType<typeof parseAnacondaPackageMetadata>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(MEDIA_SNIPER_UPDATE_API, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok || response.url !== MEDIA_SNIPER_UPDATE_API || !response.url.startsWith("https://")) {
      throw new Error("The update service returned an unexpected response.");
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") throw new Error("The update service returned an unexpected content type.");
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_UPDATE_METADATA_BYTES) {
      throw new Error("The update response is too large.");
    }
    return parseAnacondaPackageMetadata(await boundedResponseText(response), subdir);
  } finally {
    clearTimeout(timer);
  }
}

async function checkForUpdates(force: boolean, now = Date.now()): Promise<UpdateViewState> {
  const before = await persistedState();
  if (!force && !shouldRunScheduledCheck(before, now)) return await viewState(now);
  if (checking) return await viewState(now);
  checking = true;
  transient = { ...transient, error: undefined };
  notifyViews();
  try {
    const release = await downloadMetadata(await packageSubdir());
    const next: PersistedUpdateState = {
      ...before,
      lastSuccessfulCheckAt: now,
      latestVersion: release.version,
      latestVersionPublishedAt: release.publishedAt,
      lastFailureAt: undefined,
    };
    if (before.latestVersion !== release.version) {
      next.dismissedVersion = undefined;
      next.snoozeUntil = undefined;
    }
    await saveState(next);
  } catch {
    // Automatic failures stay silent; retain the last known-good advisory result.
    await saveState({ ...before, lastFailureAt: now });
    if (force) transient = { ...transient, error: "Could not check for updates. Media Sniper will try again later." };
  } finally {
    checking = false;
    await refreshBadge(now);
    notifyViews();
  }
  return await viewState(now);
}

async function snooze(now = Date.now()): Promise<UpdateViewState> {
  const state = await persistedState();
  if (state.latestVersion) {
    await saveState({
      ...state,
      dismissedVersion: state.latestVersion,
      snoozeUntil: now + UPDATE_SNOOZE_MS,
    });
  }
  await refreshBadge(now);
  notifyViews();
  return await viewState(now);
}

async function activeJobReason(): Promise<string | undefined> {
  return (await getActiveDownloads()).length
    ? "Wait for the active download or clip to finish before updating."
    : undefined;
}

function releaseAgreement(health: CompanionHealth): string | undefined {
  const installed = health.installedRelease;
  if (!health.healthy || !installed || !parseStableSemver(installed.releaseVersion) ||
      installed.extensionVersion !== installed.releaseVersion ||
      installed.companionVersion !== installed.releaseVersion ||
      health.companionVersion !== installed.companionVersion) return undefined;
  return installed.releaseVersion;
}

async function checkInstallation(): Promise<UpdateViewState> {
  const busyReason = await activeJobReason();
  if (busyReason) {
    transient = { installationChecked: true, finishReady: false, busyReason };
    return await viewState();
  }
  try {
    const health = await restartCompanionConnection();
    const installedVersion = releaseAgreement(health);
    const ready = Boolean(installedVersion && compareStableSemver(installedVersion, currentVersion()) > 0);
    transient = {
      installationChecked: true,
      finishReady: ready,
      installedVersion,
      error: ready ? undefined : "The new release is not installed and healthy yet. Finish the installer, then check again.",
    };
  } catch {
    transient = {
      installationChecked: true,
      finishReady: false,
      error: "Media Sniper could not connect to the newly installed companion. Your current installation was left unchanged.",
    };
  }
  notifyViews();
  return await viewState();
}

function normalizedHttpUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Open a normal web page before finishing the update.");
  url.hash = "";
  return url.toString();
}

async function finishUpdate(): Promise<UpdateViewState> {
  const busyReason = await activeJobReason();
  if (busyReason) {
    transient = { ...transient, finishReady: false, busyReason };
    return await viewState();
  }
  const verified = await checkInstallation();
  if (!verified.finishReady || !verified.installedVersion) return verified;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined || !tab.url) throw new Error("Open a normal web page before finishing the update.");
  const marker = createPendingPostUpdate(
    verified.installedVersion,
    tab.id,
    normalizedHttpUrl(tab.url),
    Date.now(),
  );
  await chrome.storage.local.set({ [PENDING_STORAGE_KEY]: marker });
  setTimeout(() => chrome.runtime.reload(), 100);
  return verified;
}

async function completePendingPostUpdate(): Promise<void> {
  if (postUpdateCompletionRunning) return;
  postUpdateCompletionRunning = true;
  try {
    const stored = await chrome.storage.local.get(PENDING_STORAGE_KEY);
    const marker = stored[PENDING_STORAGE_KEY] as PendingPostUpdate | undefined;
    const version = currentVersion();
    if (!validatePendingPostUpdate(marker, version, Date.now())) {
      if (marker) await chrome.storage.local.remove(PENDING_STORAGE_KEY);
      return;
    }
    try {
      const health = await restartCompanionConnection();
      if (releaseAgreement(health) !== version) return;
      const tab = await chrome.tabs.get(marker.tabId);
      if (tab.url && normalizedHttpUrl(tab.url) === marker.normalizedUrl) {
        await chrome.tabs.reload(marker.tabId);
      }
      const state = await persistedState();
      await saveState({
        ...state,
        dismissedVersion: version,
        snoozeUntil: undefined,
      });
      await chrome.storage.local.remove(PENDING_STORAGE_KEY);
      await refreshBadge();
    } catch {
      // Keep the bounded marker so a normal retry can still complete this handoff.
    }
  } finally {
    postUpdateCompletionRunning = false;
  }
}

async function dispatch(type: string): Promise<UpdateViewState> {
  switch (type) {
    case CompanionUpdateUiMessage.GET_STATE: return await viewState();
    case CompanionUpdateUiMessage.CHECK: return await checkForUpdates(true);
    case CompanionUpdateUiMessage.SNOOZE: return await snooze();
    case CompanionUpdateUiMessage.CHECK_INSTALLATION: return await checkInstallation();
    case CompanionUpdateUiMessage.FINISH: return await finishUpdate();
    default: throw new Error("Unknown update action");
  }
}

async function ensureAlarm(): Promise<void> {
  if (await chrome.alarms.get(UPDATE_ALARM)) return;
  chrome.alarms.create(UPDATE_ALARM, updateAlarmSchedule(Math.random()));
}

export function registerCompanionUpdateService(): void {
  if (registered) return;
  registered = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === CompanionUpdateUiMessage.CHANGED ||
        typeof message?.type !== "string" || !message.type.startsWith("COMPANION_UPDATE_")) return false;
    dispatch(message.type)
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => sendResponse({ success: false, error: error instanceof Error ? error.message : "Update action failed" }));
    return true;
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === UPDATE_ALARM) void checkForUpdates(false);
  });
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "update") void completePendingPostUpdate();
  });
  void ensureAlarm();
  void refreshBadge();
  // Loaded-unpacked updates do not consistently deliver onInstalled across
  // Chromium versions. The same bounded marker is therefore also consumed at
  // new service-worker startup, but only when the new manifest version agrees.
  void completePendingPostUpdate();
}

export { MEDIA_SNIPER_UPDATE_COMMAND };
