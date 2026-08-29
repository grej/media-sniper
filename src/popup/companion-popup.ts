import { getAllDownloads } from "../core/database/downloads";
import { DownloadStage, type DownloadState } from "../core/types";
import type {
  CompanionErrorCode,
  CompanionFallback,
  CompanionHealth,
  YtDlpMediaSummary,
} from "../core/companion/types";
import { companionFailureMessage } from "../core/companion/failure-messages";
import { formatFileSize } from "./utils";

const MSG = {
  health: "COMPANION_HEALTH",
  state: "COMPANION_GET_STATE",
  probe: "COMPANION_PROBE",
  download: "COMPANION_START_DOWNLOAD",
  clip: "COMPANION_START_CLIP",
  cancel: "COMPANION_CANCEL",
  reveal: "COMPANION_REVEAL",
  open: "COMPANION_OPEN",
  installTools: "COMPANION_INSTALL_TOOLS",
  updateTools: "COMPANION_UPDATE_TOOLS",
  changed: "COMPANION_STATE_CHANGED",
} as const;

type AuthChoice = { authMode: "anonymous" | "current-tab" | "brave-profile"; profileId?: string };
type ErrorView = { code: CompanionErrorCode; message: string; recoverable: boolean };

let root: HTMLElement;
let health: CompanionHealth | null = null;
let summary: YtDlpMediaSummary | null = null;
let error: ErrorView | null = null;
let busy = false;
let authChoice: AuthChoice = { authMode: "anonymous" };
let fallback: CompanionFallback | null = null;
let lastClip: { probeToken: string; selectionKey: string; startMs: number; endMs: number; mode: "fast" | "exact" } | null = null;

async function send<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response?.success) {
    const failure = response?.error as ErrorView | undefined;
    throw failure ?? { code: "INTERNAL_ERROR", message: "Media Sniper could not complete that action.", recoverable: true };
  }
  return response.data as T;
}

function button(label: string, action: () => void | Promise<void>, secondary = false): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = secondary ? "secondary-btn companion-btn" : "primary-btn companion-btn";
  element.textContent = label;
  element.disabled = busy;
  element.addEventListener("click", () => void action());
  return element;
}

function text(className: string, value: string): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  element.textContent = value;
  return element;
}

function setError(value: unknown): void {
  const candidate = value as Partial<ErrorView>;
  const code = candidate.code ?? "INTERNAL_ERROR";
  error = {
    code,
    message: companionFailureMessage(code),
    recoverable: candidate.recoverable ?? true,
  };
}

async function perform(action: () => Promise<void>): Promise<void> {
  busy = true; error = null; await render();
  try { await action(); } catch (caught) { setError(caught); }
  finally { busy = false; await render(); }
}

async function checkHealth(): Promise<void> {
  await perform(async () => { health = await send<CompanionHealth>(MSG.health); });
}

async function analyze(choice: AuthChoice = authChoice): Promise<void> {
  if (choice.authMode === "current-tab") {
    try {
      const granted = await chrome.permissions.request({ permissions: ["cookies"] });
      if (!granted) throw { code: "COOKIE_PERMISSION_DENIED", message: "Cookie access was not granted. You can continue anonymously.", recoverable: true };
    } catch (caught) {
      setError(caught); await render(); return;
    }
  }
  await perform(async () => {
    summary = await send<YtDlpMediaSummary>(MSG.probe, choice as unknown as Record<string, unknown>);
    authChoice = choice;
  });
}

function selectedKey(): string | null {
  return root.querySelector<HTMLSelectElement>("#companion-quality")?.value ?? summary?.selections[0]?.key ?? null;
}

async function startDownload(): Promise<void> {
  if (!summary) return;
  const selectionKey = selectedKey();
  if (!selectionKey) return;
  await perform(async () => {
    await send(MSG.download, { probeToken: summary!.probeToken, selectionKey, ...authChoice });
  });
}

function parseSeconds(id: string): number | null {
  const value = Number(root.querySelector<HTMLInputElement>(id)?.value);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) : null;
}

async function startClip(allowFullDownloadFallback = false): Promise<void> {
  if (!summary) return;
  const selectionKey = selectedKey();
  const startMs = parseSeconds("#companion-clip-start");
  const endMs = parseSeconds("#companion-clip-end");
  const mode = root.querySelector<HTMLSelectElement>("#companion-clip-mode")?.value as "fast" | "exact";
  if (!selectionKey || startMs === null || endMs === null || endMs <= startMs) {
    setError({ code: "INVALID_REQUEST", message: "Enter a clip end time after its start time.", recoverable: true });
    await render(); return;
  }
  lastClip = { probeToken: summary.probeToken, selectionKey, startMs, endMs, mode };
  await perform(async () => {
    await send(MSG.clip, { ...lastClip!, allowFullDownloadFallback, ...authChoice });
    if (allowFullDownloadFallback) fallback = null;
  });
}

async function approveFallback(): Promise<void> {
  if (!lastClip || !fallback) return;
  await perform(async () => {
    await send(MSG.clip, {
      ...lastClip!,
      allowFullDownloadFallback: true,
      resumeJobId: fallback!.jobId,
      ...authChoice,
    });
    fallback = null;
  });
}

async function approvePersistedFallback(job: DownloadState): Promise<void> {
  const clip = job.operation?.clip;
  const selectionKey = job.operation?.qualityKey;
  if (!summary || !clip || !selectionKey) {
    setError({ code: "FORMAT_UNAVAILABLE", message: "This analysis expired. Analyze the active page again before approving the fallback.", recoverable: true });
    await render(); return;
  }
  await perform(async () => {
    await send(MSG.clip, {
      probeToken: summary!.probeToken,
      selectionKey,
      startMs: clip.startMs,
      endMs: clip.endMs,
      mode: clip.mode,
      allowFullDownloadFallback: true,
      resumeJobId: job.id,
      ...authChoice,
    });
  });
}

async function retryFastClip(): Promise<void> {
  if (!lastClip) return;
  await perform(async () => {
    await send(MSG.clip, { ...lastClip!, mode: "fast", allowFullDownloadFallback: false, ...authChoice });
  });
}

async function retryPersistedFast(job: DownloadState): Promise<void> {
  const clip = job.operation?.clip;
  const selectionKey = job.operation?.qualityKey;
  if (!summary || !clip || !selectionKey) {
    setError({ code: "FORMAT_UNAVAILABLE", message: "Analyze the active page again before retrying this clip.", recoverable: true });
    await render(); return;
  }
  await perform(async () => {
    await send(MSG.clip, {
      probeToken: summary!.probeToken,
      selectionKey,
      startMs: clip.startMs,
      endMs: clip.endMs,
      mode: "fast",
      allowFullDownloadFallback: false,
      ...authChoice,
    });
  });
}

function healthView(container: HTMLElement): void {
  const card = document.createElement("section");
  card.className = "companion-card";
  const missingTools = health?.issues.some((issue) => issue.code === "TOOLS_MISSING") ?? false;
  const title = text(
    "companion-title",
    !health
      ? "Companion required"
      : health.healthy
        ? "Media Sniper Companion"
        : missingTools
          ? "Media tools required"
          : "Update needed",
  );
  card.append(title);
  if (!health) {
    card.append(text("companion-copy", "Install the companion once to analyze and save page media without a terminal."));
    card.append(button("Install companion", async () => { await chrome.tabs.create({ url: __COMPANION_INSTALL_URL__ }); }));
    card.append(button("Check again", checkHealth, true));
  } else if (!health.healthy) {
    card.append(text(
      "companion-copy",
      health.issues.map((issue) => companionFailureMessage(issue.code)).join(" ") || "Managed tools need attention.",
    ));
    card.append(button(missingTools ? "Install tools" : "Get update", async () => {
      await send(missingTools ? MSG.installTools : MSG.updateTools);
      await chrome.tabs.create({ url: `${__COMPANION_INSTALL_URL__}#managed-tools` });
    }));
    card.append(text(
      "companion-privacy",
      "Install the latest signed Media Sniper release, then return here and choose Check again.",
    ));
    card.append(button("Check again", checkHealth, true));
  } else {
    const versions = [health.ytDlpVersion && `yt-dlp ${health.ytDlpVersion}`, health.ffmpegVersion && `FFmpeg ${health.ffmpegVersion}`].filter(Boolean).join(" · ");
    card.append(text("companion-copy", versions || "Companion ready"));
    card.append(button("Analyze this page with yt-dlp", () => analyze({ authMode: "anonymous" })));
  }
  container.append(card);
}

function errorView(container: HTMLElement): void {
  if (!error) return;
  const card = document.createElement("section");
  card.className = "companion-card companion-error";
  const title = ({
    AUTH_REQUIRED: "This video needs your YouTube session.",
    AUTH_SCOPE_INSUFFICIENT: "Broader session access needed",
    FORMAT_UNAVAILABLE: "Download option changed",
    TOOLS_MISSING: "Media tools required",
    TOOLS_INCOMPATIBLE: "Update needed",
  } as Partial<Record<CompanionErrorCode, string>>)[error.code]
    ?? error.code.replace(/_/g, " ");
  card.append(text("companion-title", title));
  if (error.code !== "AUTH_REQUIRED") card.append(text("companion-copy", error.message));
  if (error.code === "COMPANION_NOT_INSTALLED") {
    card.append(button("Install companion", async () => { await chrome.tabs.create({ url: __COMPANION_INSTALL_URL__ }); }));
    card.append(button("Check again", checkHealth, true));
  } else if (error.code === "AUTH_REQUIRED") {
    card.append(button("Retry using this Brave session", () => analyze({ authMode: "current-tab" })));
    card.append(text(
      "companion-privacy",
      "Media Sniper passes only this page's cookies to the local companion. They are discarded afterward and never saved in history.",
    ));
  } else if (error.code === "AUTH_SCOPE_INSUFFICIENT" && health?.capabilities.braveProfileCookies) {
    renderProfileChoice(card);
  } else if (error.code === "TOOLS_MISSING" || error.code === "TOOLS_INCOMPATIBLE") {
    card.append(button(error.code === "TOOLS_MISSING" ? "Install tools" : "Get update", async () => {
      await send(error!.code === "TOOLS_MISSING" ? MSG.installTools : MSG.updateTools);
      await chrome.tabs.create({ url: `${__COMPANION_INSTALL_URL__}#managed-tools` });
    }));
    card.append(text(
      "companion-privacy",
      "Install the latest signed Media Sniper release, then return here and choose Check again.",
    ));
  } else if (error.code === "FORMAT_UNAVAILABLE") {
    card.append(button("Analyze again", () => analyze({ authMode: "anonymous" })));
  } else if (error.code === "EXACT_CLIP_UNSUPPORTED" && lastClip) {
    card.append(button("Try Fast mode", retryFastClip));
    card.append(text("companion-privacy", "Fast mode is keyframe-aligned. Media Sniper will never downgrade an Exact clip silently."));
  } else if (error.code === "JOB_INTERRUPTED") {
    card.append(button("Analyze again", () => analyze({ authMode: "anonymous" })));
  }
  container.append(card);
}

function renderProfileChoice(container: HTMLElement): void {
  const disclosure = text("companion-privacy", "Advanced: Brave profile mode can read cookies across related sites and may show a macOS Keychain prompt. It cannot use a private-window session.");
  const select = document.createElement("select");
  select.className = "companion-select";
  select.setAttribute("aria-label", "Brave profile");
  for (const profile of health?.braveProfiles ?? []) {
    const option = document.createElement("option"); option.value = profile.id; option.textContent = profile.name; select.append(option);
  }
  const consent = document.createElement("label"); consent.className = "companion-consent";
  const checkbox = document.createElement("input"); checkbox.type = "checkbox";
  consent.append(checkbox, document.createTextNode(" I understand this grants broader cookie access."));
  const retry = button("Retry with selected Brave profile", () => {
    if (!checkbox.checked || !select.value) return;
    void analyze({ authMode: "brave-profile", profileId: select.value });
  }, true);
  checkbox.addEventListener("change", () => { retry.disabled = !checkbox.checked || !select.value; });
  retry.disabled = true;
  container.append(disclosure, select, consent, retry);
}

function summaryView(container: HTMLElement): void {
  if (!summary) return;
  const card = document.createElement("section"); card.className = "companion-card";
  card.append(text("companion-kicker", "Current page via companion"));
  card.append(text("companion-title", summary.title));
  const details = [summary.uploader, summary.durationMs ? `${Math.round(summary.durationMs / 1000)} sec` : undefined, summary.extractorKey].filter(Boolean).join(" · ");
  card.append(text("companion-copy", details));
  if (summary.isLive || summary.isDrm) {
    card.append(text("companion-warning", summary.isLive ? "Live companion media cannot be clipped in v1." : "DRM-protected media cannot be downloaded or clipped."));
  }
  const quality = document.createElement("select"); quality.id = "companion-quality"; quality.className = "companion-select";
  quality.setAttribute("aria-label", "Companion quality");
  for (const selection of summary.selections) {
    const option = document.createElement("option"); option.value = selection.key;
    option.textContent = `${selection.label}${selection.estimatedBytes ? ` · about ${formatFileSize(selection.estimatedBytes)}` : ""}`;
    quality.append(option);
  }
  card.append(quality);
  if (!summary.selections.length) {
    quality.disabled = true;
    card.append(text("companion-warning", "No supported single-video quality was found for this page."));
  }
  if (!summary.isDrm && !summary.isLive) card.append(button("Download", startDownload));

  if (!summary.isLive && !summary.isDrm) {
    const clip = document.createElement("details"); clip.className = "companion-clip";
    const heading = document.createElement("summary"); heading.textContent = "Create clip"; clip.append(heading);
    const fields = document.createElement("div"); fields.className = "companion-fields";
    const start = document.createElement("input"); start.id = "companion-clip-start"; start.type = "number"; start.min = "0"; start.step = "0.001"; start.value = "0"; start.placeholder = "Start seconds";
    const end = document.createElement("input"); end.id = "companion-clip-end"; end.type = "number"; end.min = "0.001"; end.step = "0.001"; end.value = summary.durationMs ? String(Math.min(10, summary.durationMs / 1000)) : "10"; end.placeholder = "End seconds";
    const mode = document.createElement("select"); mode.id = "companion-clip-mode";
    for (const [value, label] of [["fast", "Fast · keyframe-aligned"], ["exact", "Exact · validated"]]) {
      const option = document.createElement("option"); option.value = value; option.textContent = label; mode.append(option);
    }
    fields.append(start, end, mode); clip.append(fields, button("Create clip", () => startClip(false)));
    clip.append(text("companion-privacy", "If section downloading is unavailable, Media Sniper will ask before downloading the full source."));
    card.append(clip);
  }
  container.append(card);
}

function fallbackView(container: HTMLElement): void {
  if (!fallback || !lastClip) return;
  const card = document.createElement("section"); card.className = "companion-card companion-warning-card";
  card.append(text("companion-title", "Full source download required"));
  const estimate = fallback.estimatedBytes ? ` The estimated transfer is ${formatFileSize(fallback.estimatedBytes)}.` : " The total size is unknown.";
  card.append(text("companion-copy", `This source cannot be clipped by section.${estimate} The full source is temporary and will be removed after the clip finishes.`));
  card.append(button("Download source, then create clip", approveFallback));
  card.append(button("Cancel", async () => {
    await send(MSG.cancel, { jobId: fallback!.jobId });
    fallback = null;
  }, true));
  container.append(card);
}

async function jobsView(container: HTMLElement): Promise<void> {
  const jobs = (await getAllDownloads())
    .filter((item) => item.operation?.backend === "yt-dlp")
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 10);
  if (!jobs.length) return;
  const terminal = new Set([DownloadStage.COMPLETED, DownloadStage.FAILED, DownloadStage.CANCELLED]);
  const active = jobs.filter((job) => !terminal.has(job.progress.stage) || Boolean(job.operation?.companion?.fallbackReason));
  const current = summary
    ? jobs.filter((job) =>
        job.operation?.companion?.mediaId === summary!.mediaId &&
        job.operation.companion.extractorKey === summary!.extractorKey)
    : [];
  const currentIds = new Set(current.map((job) => job.id));
  const featured = active.filter((job) => currentIds.has(job.id));
  if (current[0] && !featured.some((job) => job.id === current[0].id)) featured.push(current[0]);

  if (featured.length) {
    const section = document.createElement("section"); section.className = "companion-jobs";
    section.append(text("companion-kicker", "Current companion activity"));
    for (const job of featured) section.append(jobView(job, job.id === current[0]?.id));
    container.append(section);
  }

  const otherActive = active.filter((job) => !currentIds.has(job.id));
  if (otherActive.length) {
    const section = document.createElement("section"); section.className = "companion-jobs";
    section.append(text("companion-kicker", "Other active companion jobs"));
    for (const job of otherActive) section.append(jobView(job));
    container.append(section);
  }

  const featuredIds = new Set([...featured, ...otherActive].map((job) => job.id));
  const previous = jobs.filter((job) => !featuredIds.has(job.id));
  if (previous.length) {
    const history = document.createElement("details"); history.className = "companion-history";
    const heading = document.createElement("summary");
    heading.textContent = `Previous companion activity (${previous.length})`;
    history.append(heading);
    for (const job of previous) history.append(jobView(job));
    container.append(history);
  }
}

function jobView(job: DownloadState, currentPage = false): HTMLElement {
  const card = document.createElement("div"); card.className = "companion-card companion-job";
  const mediaTitle = job.operation?.companion?.title ?? "Companion media";
  if (currentPage && job.progress.stage === DownloadStage.COMPLETED) {
    card.append(text("companion-title", job.operation?.kind === "clip" ? "Clip saved" : "Download saved"));
    card.append(text("companion-copy", mediaTitle));
  } else {
    card.append(text("companion-title", mediaTitle));
  }
  const percentage = job.progress.percentage === undefined ? "" : ` · ${Math.round(job.progress.percentage)}%`;
  const progressMessage = job.progress.stage === DownloadStage.COMPLETED
    ? "Saved to Downloads/Media Sniper"
    : job.progress.message ?? job.progress.stage;
  card.append(text("companion-copy", `${progressMessage}${percentage}`));
  const waitingFallback = Boolean(job.operation?.companion?.fallbackReason);
  const active = !waitingFallback && ![DownloadStage.COMPLETED, DownloadStage.FAILED, DownloadStage.CANCELLED].includes(job.progress.stage);
  if (active) card.append(button("Cancel", async () => { await send(MSG.cancel, { jobId: job.id }); }, true));
  if (job.progress.stage === DownloadStage.COMPLETED) {
    card.append(button("Show in folder", async () => { await send(MSG.reveal, { id: job.id }); }));
    card.append(button("Open output", async () => { await send(MSG.open, { id: job.id }); }, true));
    card.append(text("companion-privacy", "Cloud upload is unavailable for companion-written files in v1."));
  }
  if (job.progress.error) {
    card.append(text(
      "companion-warning",
      companionFailureMessage(job.operation?.companion?.errorCode ?? "INTERNAL_ERROR"),
    ));
  }
  if (job.operation?.companion?.errorCode === "EXACT_CLIP_UNSUPPORTED") {
    card.append(button("Try Fast mode", () => retryPersistedFast(job), true));
  }
  if (job.operation?.companion?.fallbackReason && fallback?.jobId !== job.id) {
    const estimate = job.operation.companion.fallbackEstimatedBytes;
    card.append(text("companion-warning", `A full temporary source download needs approval.${estimate ? ` Estimated size: ${formatFileSize(estimate)}.` : " Size is unknown."}`));
    card.append(button("Download source, then create clip", () => approvePersistedFallback(job)));
    card.append(button("Decline", async () => { await send(MSG.cancel, { jobId: job.id }); }, true));
  }
  return card;
}

async function render(): Promise<void> {
  if (!root) return;
  root.replaceChildren();
  const heading = text("companion-section-heading", "Page analysis"); root.append(heading);
  if (busy) root.append(text("companion-loading", "Working with the companion…"));
  healthView(root); errorView(root); summaryView(root); fallbackView(root); await jobsView(root);
}

function installStyles(): void {
  const style = document.createElement("style");
  style.textContent = `
    #companionPanel{padding:0 var(--space-3) var(--space-2)}
    .companion-section-heading,.companion-kicker{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-tertiary);margin:8px 0}
    .companion-card{display:block;background:var(--surface-1);border:1px solid var(--border);border-radius:var(--radius-md);padding:var(--space-3);margin-bottom:var(--space-2)}
    .companion-title{font-weight:600;color:var(--text-primary);margin-bottom:4px;overflow-wrap:anywhere}
    .companion-copy,.companion-privacy,.companion-warning{color:var(--text-secondary);font-size:11px;line-height:1.4;margin:5px 0}
    .companion-privacy{color:var(--text-tertiary)}.companion-warning{color:var(--warning)}.companion-error{border-color:var(--error)}
    .companion-btn{font-size:11px;padding:5px 9px;margin:5px 5px 0 0}.companion-btn:disabled{opacity:.55;cursor:wait}
    .companion-select,.companion-fields input,.companion-fields select{width:100%;box-sizing:border-box;margin:5px 0;padding:6px;border:1px solid var(--border-hover);border-radius:var(--radius-sm);background:var(--surface-2);color:var(--text-primary)}
    .companion-consent{display:block;font-size:11px;color:var(--text-secondary);margin:7px 0}.companion-clip{margin-top:8px}.companion-clip summary{cursor:pointer;color:var(--accent)}
    .companion-loading{font-size:11px;color:var(--text-secondary);margin-bottom:6px}.companion-job{padding:8px}.companion-warning-card{border-color:var(--warning)}
    .companion-history>summary{cursor:pointer;color:var(--text-secondary);font-size:11px;margin:8px 0}.companion-history[open]>summary{margin-bottom:8px}
  `;
  document.head.append(style);
}

export async function initializeCompanionPopup(): Promise<void> {
  const list = document.getElementById("detectedVideosList");
  if (!list || document.getElementById("companionPanel")) return;
  installStyles();
  root = document.createElement("div"); root.id = "companionPanel";
  list.parentElement?.insertBefore(root, list);
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== MSG.changed) return;
    if (message.payload?.activeTabChanged === true) {
      error = null; fallback = null; lastClip = null; authChoice = { authMode: "anonymous" };
      void send<{ summaries: YtDlpMediaSummary[] }>(MSG.state)
        .then((state) => { summary = state.summaries[0] ?? null; })
        .catch(() => { summary = null; })
        .finally(() => void render());
      return;
    }
    if ((message.payload as CompanionFallback)?.reason) fallback = message.payload as CompanionFallback;
    if ((message.payload as ErrorView)?.code) setError(message.payload);
    void render();
  });
  await render();
  try {
    const state = await send<{ summaries: YtDlpMediaSummary[] }>(MSG.state);
    summary = state.summaries[0] ?? null;
  } catch {
    // Health below provides the actionable recovery state.
  }
  await checkHealth();
}
