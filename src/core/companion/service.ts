import { createOperationKey } from "../clipping/operation-key";
import { getActiveDownloads, getDownload, storeDownload } from "../database/downloads";
import { DownloadStage, type DownloadState, type VideoMetadata } from "../types";
import { CompanionClient, CompanionClientError } from "./client";
import type { CompanionEvent } from "./protocol";
import type {
  CompanionAuthBundle,
  CompanionCookie,
  CompanionErrorCode,
  CompanionFallback,
  CompanionHealth,
  CompanionJobProgress,
  CompanionOutputReceipt,
  YtDlpMediaSummary,
} from "./types";
import { companionFailureMessage } from "./failure-messages";
import { SerialEventQueue } from "./event-queue";

export const CompanionUiMessage = {
  HEALTH: "COMPANION_HEALTH",
  GET_STATE: "COMPANION_GET_STATE",
  PROBE: "COMPANION_PROBE",
  START_DOWNLOAD: "COMPANION_START_DOWNLOAD",
  START_CLIP: "COMPANION_START_CLIP",
  CANCEL: "COMPANION_CANCEL",
  REVEAL: "COMPANION_REVEAL",
  OPEN: "COMPANION_OPEN",
  INSTALL_TOOLS: "COMPANION_INSTALL_TOOLS",
  UPDATE_TOOLS: "COMPANION_UPDATE_TOOLS",
  STATE_CHANGED: "COMPANION_STATE_CHANGED",
} as const;

type AuthChoice = { authMode?: "anonymous" | "current-tab" | "brave-profile"; profileId?: string };
interface StartPayload extends AuthChoice { probeToken: string; selectionKey: string }
interface StartClipPayload extends StartPayload {
  startMs: number;
  endMs: number;
  mode: "fast" | "exact";
  allowFullDownloadFallback?: boolean;
  resumeJobId?: string;
}

const client = new CompanionClient();
const summaries = new Map<string, YtDlpMediaSummary>();
export interface AnalyzedPageBinding { tabId: number; requestedPageUrl: string }
const analyzedPages = new Map<string, AnalyzedPageBinding>();
const activeCompanionJobs = new Map<string, string>();
let health: CompanionHealth | null = null;
let registered = false;

function browserTarget(): CompanionHealth["browserTarget"] {
  if ((navigator as Navigator & { brave?: unknown }).brave) return "brave";
  return /Chrome\//.test(navigator.userAgent) ? "chrome" : "chromium";
}

function companionError(code: CompanionErrorCode, message: string): CompanionClientError {
  return new CompanionClientError(code, message, true);
}

function safeError(error: unknown): { code: CompanionErrorCode; message: string; recoverable: boolean } {
  return error instanceof CompanionClientError
    ? { code: error.code, message: error.message, recoverable: error.recoverable }
    : { code: "INTERNAL_ERROR", message: "Media Sniper could not complete that action.", recoverable: true };
}

export function validatePublicPageUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw companionError("URL_UNSUPPORTED", "This page address is not supported."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw companionError("URL_UNSUPPORTED", "Only normal HTTP and HTTPS pages can be analyzed.");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
    host === "0.0.0.0" || /^127\./.test(host) || host === "::" || host === "::1" ||
    /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host) ||
    /^::ffff:(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) ||
    /^0\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(?:6[4-9]|[789]\d|1[01]\d|12[0-7])\./.test(host) ||
    /^198\.1[89]\./.test(host)
  ) throw companionError("URL_UNSUPPORTED", "Local and private network pages are disabled.");
  return url;
}

/** Preserve the analyzed page query while ignoring an in-page fragment. */
export function analyzedPageIdentity(raw: string): string {
  const url = validatePublicPageUrl(raw);
  url.hash = "";
  return url.toString();
}

/** Accept a public extractor-canonical page without treating it as tab identity. */
export function validateCanonicalPageUrl(raw: string): URL {
  return validatePublicPageUrl(raw);
}

export function validateAnalyzedPageBinding(
  activeTab: Pick<chrome.tabs.Tab, "id" | "url">,
  binding: AnalyzedPageBinding,
): void {
  if (activeTab.id !== binding.tabId || !activeTab.url ||
      analyzedPageIdentity(activeTab.url) !== binding.requestedPageUrl) {
    throw companionError("INVALID_REQUEST", "Analyze the active page again before continuing.");
  }
}

export function shouldInvalidateAnalyzedPage(
  binding: AnalyzedPageBinding,
  changedTabId: number,
  changedUrl: string | undefined,
): boolean {
  return changedUrl !== undefined && binding.tabId === changedTabId;
}

function clearAnalysesForTab(tabId: number, changedUrl = "closed"): void {
  for (const [token, binding] of analyzedPages) {
    if (shouldInvalidateAnalyzedPage(binding, tabId, changedUrl)) {
      analyzedPages.delete(token);
      summaries.delete(token);
    }
  }
}

async function activeHttpTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !tab.url) throw companionError("URL_UNSUPPORTED", "Open a public web page to analyze it.");
  validatePublicPageUrl(tab.url);
  return tab;
}

async function requestCookiePermission(): Promise<void> {
  if (await chrome.permissions.contains({ permissions: ["cookies"] })) return;
  const granted = await chrome.permissions.request({ permissions: ["cookies"] });
  if (!granted) throw companionError("COOKIE_PERMISSION_DENIED", "Cookie access was not granted. You can continue anonymously.");
}

function normalizeSameSite(value: chrome.cookies.SameSiteStatus): CompanionCookie["sameSite"] {
  return value === "no_restriction" || value === "lax" || value === "strict" ? value : "unspecified";
}

export async function collectCurrentTabAuth(tab: chrome.tabs.Tab): Promise<CompanionAuthBundle> {
  await requestCookiePermission();
  const stores = await chrome.cookies.getAllCookieStores();
  const store = stores.find((candidate) => candidate.tabIds.includes(tab.id!));
  if (!store) throw companionError("AUTH_SCOPE_INSUFFICIENT", "Brave did not expose the active tab's cookie store.");
  const cookies = await chrome.cookies.getAll({ url: tab.url!, storeId: store.id });
  if (cookies.some((cookie) => Boolean((cookie as chrome.cookies.Cookie & { partitionKey?: unknown }).partitionKey))) {
    throw companionError("AUTH_SCOPE_INSUFFICIENT", "Partitioned cookies cannot be transferred safely. Try advanced Brave profile mode.");
  }
  return {
    mode: "current-tab",
    pageUrl: tab.url!, referer: tab.url!, userAgent: navigator.userAgent,
    cookieStoreId: store.id, incognito: Boolean(tab.incognito),
    cookies: cookies.map((cookie) => ({
      name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
      secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: normalizeSameSite(cookie.sameSite),
      expirationDate: cookie.expirationDate, hostOnly: cookie.hostOnly, session: cookie.session,
    })),
  };
}

async function authBundle(choice: AuthChoice, tab: chrome.tabs.Tab): Promise<CompanionAuthBundle> {
  if (choice.authMode === "current-tab") return await collectCurrentTabAuth(tab);
  if (choice.authMode === "brave-profile") {
    if (tab.incognito) throw companionError("AUTH_SCOPE_INSUFFICIENT", "Brave profile mode cannot read a private-window session.");
    if (!choice.profileId || !health?.braveProfiles?.some(({ id }) => id === choice.profileId)) {
      throw companionError("INVALID_REQUEST", "Choose a Brave profile reported by the companion.");
    }
    return { mode: "brave-profile", profileId: choice.profileId };
  }
  return { mode: "anonymous" };
}

function selectedOption(summary: YtDlpMediaSummary, selectionKey: string) {
  const selected = summary.selections.find(({ key }) => key === selectionKey);
  if (!selected) throw companionError("FORMAT_UNAVAILABLE", "That quality is no longer available. Analyze the page again.");
  return selected;
}

export function companionOperationKey(
  summary: YtDlpMediaSummary,
  selectionKey: string,
  kind: "download" | "clip",
  clip?: { startMs: number; endMs: number; mode: "fast" | "exact" },
): string {
  const selected = selectedOption(summary, selectionKey);
  return createOperationKey({
    backend: "yt-dlp", kind, url: summary.webpageUrl, quality: selectionKey,
    clip: clip ? { ...clip, markSource: "manual" } : undefined,
    outputContainer: selected.expectedContainer ?? "native",
  });
}

async function reserveCompanionJob(operationKey: string): Promise<{ jobId: string; duplicate: boolean }> {
  const reserved = activeCompanionJobs.get(operationKey);
  if (reserved) return { jobId: reserved, duplicate: true };

  const durable = (await getActiveDownloads()).find((job) =>
    job.operation?.backend === "yt-dlp" && job.operation.operationKey === operationKey);
  if (durable) {
    activeCompanionJobs.set(operationKey, durable.id);
    return { jobId: durable.id, duplicate: true };
  }

  // Recheck after the database await so two same-turn requests cannot both win.
  const concurrent = activeCompanionJobs.get(operationKey);
  if (concurrent) return { jobId: concurrent, duplicate: true };
  const jobId = crypto.randomUUID();
  activeCompanionJobs.set(operationKey, jobId);
  return { jobId, duplicate: false };
}

function releaseCompanionJob(state: DownloadState | null | undefined): void {
  const operationKey = state?.operation?.operationKey;
  if (operationKey && activeCompanionJobs.get(operationKey) === state?.id) {
    activeCompanionJobs.delete(operationKey);
  }
}

function releaseCompanionJobById(jobId: string): void {
  for (const [operationKey, activeJobId] of activeCompanionJobs) {
    if (activeJobId === jobId) activeCompanionJobs.delete(operationKey);
  }
}

export async function createCompanionJobState(
  jobId: string, summary: YtDlpMediaSummary, selectionKey: string,
  kind: "download" | "clip", clip?: { startMs: number; endMs: number; mode: "fast" | "exact" },
): Promise<void> {
  const selected = selectedOption(summary, selectionKey);
  const now = Date.now();
  const metadata = {
    title: summary.title, duration: summary.durationMs ? summary.durationMs / 1000 : undefined,
    thumbnail: summary.thumbnailUrl, isLive: summary.isLive, hasDrm: summary.isDrm,
    source: { kind: "yt-dlp", pageUrl: summary.webpageUrl, extractorKey: summary.extractorKey, mediaId: summary.mediaId },
  } as unknown as VideoMetadata;
  const state: DownloadState = {
    id: jobId, url: summary.webpageUrl, metadata,
    progress: { url: summary.webpageUrl, stage: DownloadStage.PLANNING, message: "Queued by companion" },
    operation: {
      kind, backend: "yt-dlp",
      operationKey: companionOperationKey(summary, selectionKey, kind, clip),
      clip: clip ? { ...clip, markSource: "manual" } : undefined,
      requestedDurationMs: clip ? clip.endMs - clip.startMs : undefined,
      qualityKey: selectionKey,
      companion: { extractorKey: summary.extractorKey, mediaId: summary.mediaId, title: summary.title, selectionLabel: selected.label },
    },
    createdAt: now, updatedAt: now,
  };
  await storeDownload(state);
}

function stageFromProgress(stage: CompanionJobProgress["stage"]): DownloadStage {
  return ({
    planning: DownloadStage.PLANNING, downloading: DownloadStage.DOWNLOADING,
    merging: DownloadStage.MERGING, processing: DownloadStage.PROCESSING,
    saving: DownloadStage.SAVING, completed: DownloadStage.COMPLETED,
  })[stage];
}

async function updateJobProgress(progress: CompanionJobProgress): Promise<void> {
  const state = await getDownload(progress.jobId);
  if (!state) return;
  state.progress = {
    url: state.url, stage: stageFromProgress(progress.stage), downloaded: progress.downloadedBytes,
    total: progress.totalBytes, percentage: progress.percentage,
    speed: progress.speedBytesPerSecond, message: progress.detail ?? progress.stage,
  };
  await storeDownload(state);
}

async function completeJob(receipt: CompanionOutputReceipt): Promise<void> {
  const state = await getDownload(receipt.jobId);
  if (!state?.operation?.companion) return;
  state.localPath = receipt.finalPath;
  state.progress = { url: state.url, stage: DownloadStage.COMPLETED, percentage: 100, downloaded: receipt.byteSize, total: receipt.byteSize, message: "Saved by companion" };
  state.operation.outputContainer = receipt.container;
  state.operation.actualDurationMs = receipt.actualDurationMs ?? receipt.durationMs;
  state.operation.accuracy = receipt.accuracy;
  state.operation.companion.finalPath = receipt.finalPath;
  state.operation.companion.outputToken = receipt.outputToken;
  await storeDownload(state);
  releaseCompanionJob(state);
}

async function failJob(payload: { jobId?: string; code: CompanionErrorCode; message: string }): Promise<void> {
  if (!payload.jobId) return;
  const state = await getDownload(payload.jobId);
  if (!state) {
    releaseCompanionJobById(payload.jobId);
    return;
  }
  const cancelled = payload.code === "CANCELLED";
  state.progress = {
    url: state.url,
    stage: cancelled ? DownloadStage.CANCELLED : DownloadStage.FAILED,
    error: cancelled ? undefined : companionFailureMessage(payload.code),
    message: cancelled ? "Cancelled" : "Companion operation failed",
  };
  if (state.operation?.companion) state.operation.companion.errorCode = payload.code;
  await storeDownload(state);
  releaseCompanionJob(state);
}

async function onCompanionEvent(event: CompanionEvent): Promise<void> {
  if (event.type === "job_progress") await updateJobProgress(event.payload as CompanionJobProgress);
  if (event.type === "job_completed") await completeJob(event.payload as CompanionOutputReceipt);
  if (event.type === "job_failed") await failJob(event.payload as Parameters<typeof failJob>[0]);
  if (event.type === "job_cancelled") await failJob({ ...(event.payload as { jobId: string }), code: "CANCELLED", message: "Cancelled" });
  if (event.type === "fallback_required") {
    const fallback = event.payload as CompanionFallback;
    const state = await getDownload(fallback.jobId);
    if (state) {
      state.progress.message = "Full source download requires your approval";
      if (state.operation?.companion) {
        state.operation.companion.fallbackReason = fallback.reason;
        state.operation.companion.fallbackEstimatedBytes = fallback.estimatedBytes;
      }
      await storeDownload(state);
    }
  }
  if (["job_progress", "job_completed", "job_failed", "job_cancelled", "fallback_required", "tool_progress"].includes(event.type)) {
    void chrome.runtime.sendMessage({ type: CompanionUiMessage.STATE_CHANGED, payload: event.payload }).catch(() => undefined);
  }
}

const companionEventQueue = new SerialEventQueue<CompanionEvent>(
  onCompanionEvent,
  (error) => console.error("Could not persist companion event:", error),
);

async function checkHealth(): Promise<CompanionHealth> {
  // A host launched before a graphical tool install has no worker queue, and a
  // host launched before an update intentionally keeps its verified tool paths.
  // Restart only an already-known unhealthy connection when the user retries.
  if (health && !health.healthy) client.disconnect();
  health = await client.hello(browserTarget());
  return health;
}

async function stateForActiveTab(): Promise<{ health: CompanionHealth | null; summaries: YtDlpMediaSummary[] }> {
  try {
    const tab = await activeHttpTab();
    const activeSummaries = [...summaries.entries()]
      .filter(([token]) => {
        const binding = analyzedPages.get(token);
        if (!binding) return false;
        try {
          validateAnalyzedPageBinding(tab, binding);
          return true;
        } catch {
          return false;
        }
      })
      .map(([, summary]) => summary);
    return { health, summaries: activeSummaries };
  } catch {
    return { health, summaries: [] };
  }
}

async function probe(choice: AuthChoice): Promise<YtDlpMediaSummary> {
  const tab = await activeHttpTab();
  const requestedPageUrl = analyzedPageIdentity(tab.url!);
  const binding = { tabId: tab.id!, requestedPageUrl };
  let auth = await authBundle(choice, tab);
  try {
    const event = await client.request("probe", { pageUrl: tab.url!, auth }, 90_000);
    if (event.type !== "probe_result") throw companionError("PROTOCOL_MISMATCH", "The companion returned an unexpected analysis result.");
    const summary = event.payload as YtDlpMediaSummary;
    // Extractors legitimately canonicalize across origins (for example,
    // youtu.be to www.youtube.com). This URL is execution/output identity only;
    // starts remain bound to the exact requested tab and page below.
    validateCanonicalPageUrl(summary.webpageUrl);
    // YouTube navigation does not necessarily reload the tab. Do not let a
    // slow result for the previous watch URL replace the active page.
    validateAnalyzedPageBinding(await activeHttpTab(), binding);
    // Replace only this tab's prior analysis. A probe in another tab must not
    // invalidate a still-current page binding.
    clearAnalysesForTab(tab.id!);
    summaries.set(summary.probeToken, summary);
    analyzedPages.set(summary.probeToken, binding);
    return summary;
  } finally { auth = { mode: "anonymous" }; }
}

async function startDownload(payload: StartPayload): Promise<{ jobId: string }> {
  const summary = summaries.get(payload.probeToken);
  if (!summary) throw companionError("FORMAT_UNAVAILABLE", "This analysis expired. Analyze the page again.");
  selectedOption(summary, payload.selectionKey);
  const tab = await activeHttpTab();
  const binding = analyzedPages.get(payload.probeToken);
  if (!binding) throw companionError("FORMAT_UNAVAILABLE", "This analysis expired. Analyze the page again.");
  validateAnalyzedPageBinding(tab, binding);
  const operationKey = companionOperationKey(summary, payload.selectionKey, "download");
  const { jobId, duplicate } = await reserveCompanionJob(operationKey);
  if (duplicate) return { jobId };
  let auth: CompanionAuthBundle = { mode: "anonymous" };
  try {
    await createCompanionJobState(jobId, summary, payload.selectionKey, "download");
    auth = await authBundle(payload, tab);
    await client.request("start_download", { jobId, probeToken: payload.probeToken, selectionKey: payload.selectionKey, auth });
    return { jobId };
  } catch (error) { await failJob({ jobId, ...safeError(error) }); throw error; }
  finally { auth = { mode: "anonymous" }; }
}

async function startClip(payload: StartClipPayload): Promise<{ jobId: string }> {
  if (!Number.isSafeInteger(payload.startMs) || !Number.isSafeInteger(payload.endMs) || payload.startMs < 0 || payload.endMs <= payload.startMs) {
    throw companionError("INVALID_REQUEST", "Choose a valid clip start and end time.");
  }
  const summary = summaries.get(payload.probeToken);
  if (!summary) throw companionError("FORMAT_UNAVAILABLE", "This analysis expired. Analyze the page again.");
  if (summary.isLive) throw companionError("LIVE_UNSUPPORTED", "Live companion sources cannot be clipped yet.");
  if (summary.isDrm) throw companionError("DRM_UNSUPPORTED", "DRM-protected media cannot be clipped.");
  selectedOption(summary, payload.selectionKey);
  const tab = await activeHttpTab();
  const binding = analyzedPages.get(payload.probeToken);
  if (!binding) throw companionError("FORMAT_UNAVAILABLE", "This analysis expired. Analyze the page again.");
  validateAnalyzedPageBinding(tab, binding);
  const clip = { startMs: payload.startMs, endMs: payload.endMs, mode: payload.mode };
  let jobId = payload.resumeJobId;
  if (payload.resumeJobId) {
    const existing = await getDownload(payload.resumeJobId);
    if (!existing || existing.operation?.backend !== "yt-dlp" || existing.operation.kind !== "clip") {
      throw companionError("INVALID_REQUEST", "The fallback request is no longer active.");
    }
    existing.progress = { url: existing.url, stage: DownloadStage.PLANNING, message: "Preparing approved full-source fallback" };
    if (existing.operation.companion) {
      existing.operation.companion.fallbackReason = undefined;
      existing.operation.companion.fallbackEstimatedBytes = undefined;
    }
    await storeDownload(existing);
  } else {
    const operationKey = companionOperationKey(summary, payload.selectionKey, "clip", clip);
    const reserved = await reserveCompanionJob(operationKey);
    if (reserved.duplicate) return { jobId: reserved.jobId };
    jobId = reserved.jobId;
    try {
      await createCompanionJobState(jobId, summary, payload.selectionKey, "clip", clip);
    } catch (error) {
      releaseCompanionJobById(jobId);
      throw error;
    }
  }
  if (!jobId) throw companionError("INTERNAL_ERROR", "Media Sniper could not start that clip.");
  let auth: CompanionAuthBundle = { mode: "anonymous" };
  try {
    auth = await authBundle(payload, tab);
    await client.request("start_clip", { jobId, probeToken: payload.probeToken, selectionKey: payload.selectionKey, clip, allowFullDownloadFallback: payload.allowFullDownloadFallback === true, auth });
    return { jobId };
  } catch (error) { await failJob({ jobId, ...safeError(error) }); throw error; }
  finally { auth = { mode: "anonymous" }; }
}

async function outputAction(type: "reveal_output" | "open_output", id: string): Promise<void> {
  const state = await getDownload(id);
  const outputToken = state?.operation?.companion?.outputToken;
  if (!outputToken) throw companionError("INVALID_REQUEST", "That output is no longer available to the companion.");
  client.post(type, { outputToken });
}

async function dispatch(message: { type?: string; payload?: Record<string, unknown> }): Promise<unknown> {
  switch (message.type) {
    case CompanionUiMessage.HEALTH: return await checkHealth();
    case CompanionUiMessage.GET_STATE: return await stateForActiveTab();
    case CompanionUiMessage.PROBE: return await probe((message.payload ?? {}) as AuthChoice);
    case CompanionUiMessage.START_DOWNLOAD: return await startDownload(message.payload as unknown as StartPayload);
    case CompanionUiMessage.START_CLIP: return await startClip(message.payload as unknown as StartClipPayload);
    case CompanionUiMessage.CANCEL: client.post("cancel_job", { jobId: String(message.payload?.jobId ?? "") }); return {};
    case CompanionUiMessage.REVEAL: await outputAction("reveal_output", String(message.payload?.id ?? "")); return {};
    case CompanionUiMessage.OPEN: await outputAction("open_output", String(message.payload?.id ?? "")); return {};
    case CompanionUiMessage.INSTALL_TOOLS: client.post("install_tools", {}); return {};
    case CompanionUiMessage.UPDATE_TOOLS: client.post("update_tools", {}); return {};
    default: throw companionError("INVALID_REQUEST", "Unknown companion action.");
  }
}

export function registerCompanionService(): void {
  if (registered) return;
  registered = true;
  client.subscribe((event) => companionEventQueue.push(event));
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // This notification is consumed by extension views; it is not an action
    // request for the background service itself.
    if (message?.type === CompanionUiMessage.STATE_CHANGED) return false;
    if (typeof message?.type !== "string" || !message.type.startsWith("COMPANION_")) return false;
    dispatch(message).then((data) => sendResponse({ success: true, data })).catch((error) => sendResponse({ success: false, error: safeError(error) }));
    return true;
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo.url) return;
    clearAnalysesForTab(tabId, changeInfo.url);
    if (tab.active) {
      void chrome.runtime.sendMessage({
        type: CompanionUiMessage.STATE_CHANGED,
        payload: { activeTabChanged: true },
      }).catch(() => undefined);
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => clearAnalysesForTab(tabId));
  chrome.tabs.onActivated.addListener(() => {
    void chrome.runtime.sendMessage({
      type: CompanionUiMessage.STATE_CHANGED,
      payload: { activeTabChanged: true },
    }).catch(() => undefined);
  });
}
