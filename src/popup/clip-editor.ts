import type {
  ClipMarkSource,
  ClipMode,
  ClipSpec,
  ManifestQualitySelection,
} from "../core/clipping/types";
import { formatClockTimeMs, tryParseTimeInput } from "../core/clipping/time";
import { validateClipRange } from "../core/clipping/validation";

export interface ClipEditorDraft {
  startMs: number;
  endMs: number;
  mode: ClipMode;
  qualityKey?: string;
  updatedAt?: number;
}

export interface ClipEditorPlayback {
  pageVideoId?: string;
  currentTimeMs: number;
  durationMs?: number;
  label?: string;
  alternatives?: Array<{ pageVideoId: string; label: string }>;
  requiresSelection?: boolean;
}

export interface ClipEditorQualityOption {
  key: string;
  label: string;
  selection?: ManifestQualitySelection;
}

export interface ClipEditorSubmit {
  clip: ClipSpec;
  qualityKey?: string;
  manifestQuality?: ManifestQualitySelection;
  allowFullFetchForDirect?: boolean;
}

export interface ExactCapabilityResult {
  supported: boolean;
  reason?: string;
}

export interface ClipEditorOptions {
  sourceKey: string;
  durationMs?: number;
  draft?: ClipEditorDraft;
  defaultMode?: ClipMode;
  qualities?: ClipEditorQualityOption[];
  showDirectFullFetchConsent?: boolean;
  checkExactCapability?: () => Promise<ExactCapabilityResult>;
  getPlayback?: (preferredPageVideoId?: string) => Promise<ClipEditorPlayback | null>;
  persistDraft?: (draft: ClipEditorDraft) => void | Promise<void>;
  onSubmit: (value: ClipEditorSubmit) => void | Promise<void>;
  onClose?: () => void;
}

export interface ClipEditorController {
  element: HTMLElement;
  destroy(): void;
  refreshPlayback(): Promise<void>;
}

const DEFAULT_CLIP_END_MS = 30_000;
const PLAYBACK_POLL_MS = 250;

type TimeDisplay = "clock" | "seconds";

/** Popup clock display always includes HH:MM:SS and a fixed three-digit ms field. */
export function formatEditorTime(milliseconds: number, display: TimeDisplay = "clock"): string {
  if (display === "seconds") return (milliseconds / 1_000).toFixed(3);
  return formatClockTimeMs(milliseconds);
}

function button(label: string, className: string, title?: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  if (title) element.title = title;
  return element;
}

function normalizeInitialDraft(options: ClipEditorOptions): ClipEditorDraft {
  const durationMs = options.durationMs;
  const defaultEndMs = durationMs
    ? Math.min(durationMs, DEFAULT_CLIP_END_MS)
    : DEFAULT_CLIP_END_MS;
  return {
    startMs: options.draft?.startMs ?? 0,
    endMs: options.draft?.endMs ?? defaultEndMs,
    mode: options.draft?.mode ?? options.defaultMode ?? "fast",
    qualityKey: options.draft?.qualityKey,
    updatedAt: options.draft?.updatedAt,
  };
}

function createTimeControl(
  field: "start" | "end",
  valueMs: number,
): { root: HTMLElement; input: HTMLInputElement; setButton: HTMLButtonElement } {
  const root = document.createElement("div");
  root.className = "clip-time-control";

  const label = document.createElement("label");
  const input = document.createElement("input");
  input.id = `clip-${field}-${crypto.randomUUID()}`;
  input.className = "clip-time-input";
  input.inputMode = "decimal";
  input.autocomplete = "off";
  input.value = formatEditorTime(valueMs);
  input.setAttribute("aria-describedby", `${input.id}-hint`);
  label.htmlFor = input.id;
  label.textContent = field === "start" ? "Start" : "End";

  const setButton = button(
    `Set ${field}`,
    "clip-mark-btn",
    `Use the selected player's current time as the clip ${field}`,
  );
  setButton.dataset.mark = field;

  const hint = document.createElement("span");
  hint.id = `${input.id}-hint`;
  hint.className = "sr-only";
  hint.textContent = "Enter seconds, MM:SS.mmm, or HH:MM:SS.mmm";

  root.append(label, input, setButton, hint);
  return { root, input, setButton };
}

export function createClipEditor(options: ClipEditorOptions): ClipEditorController {
  const initial = normalizeInitialDraft(options);
  const freshDefaults = normalizeInitialDraft({ ...options, draft: undefined });
  let currentPlayback: ClipEditorPlayback | null = null;
  let preferredPageVideoId: string | undefined;
  let markSource: ClipMarkSource = "manual";
  let timeDisplay: TimeDisplay = "clock";
  let destroyed = false;
  let polling = false;

  const root = document.createElement("section");
  root.className = "clip-editor";
  root.dataset.sourceKey = options.sourceKey;
  root.setAttribute("aria-label", "Clip editor");

  const header = document.createElement("div");
  header.className = "clip-editor-header";
  const title = document.createElement("strong");
  title.textContent = "Create clip";
  const current = document.createElement("span");
  current.className = "clip-current-time";
  current.textContent = options.getPlayback ? "Finding player…" : "Manual timestamps";
  // Polling updates this value four times per second; do not spam screen readers.
  current.setAttribute("aria-live", "off");
  const close = button("×", "clip-close-btn", "Close clip editor");
  close.setAttribute("aria-label", "Close clip editor");
  header.append(title, current, close);

  const fields = document.createElement("div");
  fields.className = "clip-time-fields";
  const start = createTimeControl("start", initial.startMs);
  const end = createTimeControl("end", initial.endMs);
  fields.append(start.root, end.root);

  const durationRow = document.createElement("div");
  durationRow.className = "clip-duration-row";
  const durationLabel = document.createElement("span");
  durationLabel.textContent = "Duration";
  const duration = document.createElement("output");
  duration.className = "clip-duration";
  duration.setAttribute("aria-label", "Clip duration");
  durationRow.append(durationLabel, duration);

  const nudgeRow = document.createElement("div");
  nudgeRow.className = "clip-nudges";
  for (const seconds of [-10, -1, -0.1, 0.1, 1, 10]) {
    const nudge = button(
      `${seconds > 0 ? "+" : ""}${seconds}s`,
      "clip-nudge-btn",
      `Move the focused timestamp by ${seconds} seconds`,
    );
    nudge.dataset.deltaMs = String(Math.round(seconds * 1_000));
    nudgeRow.append(nudge);
  }
  const reset = button("Reset", "clip-reset-btn", "Reset clip marks and options");
  nudgeRow.append(reset);

  const optionsRow = document.createElement("div");
  optionsRow.className = "clip-options";
  const modeLabel = document.createElement("label");
  modeLabel.textContent = "Accuracy";
  const mode = document.createElement("select");
  mode.className = "clip-mode-select";
  mode.innerHTML = '<option value="fast">Fast (keyframe-aligned)</option><option value="exact">Exact</option>';
  mode.value = initial.mode;
  modeLabel.append(mode);
  optionsRow.append(modeLabel);

  const displayLabel = document.createElement("label");
  displayLabel.textContent = "Time display";
  const display = document.createElement("select");
  display.className = "clip-time-display-select";
  display.innerHTML = '<option value="clock">Clock (HH:MM:SS.mmm)</option><option value="seconds">Seconds (s.mmm)</option>';
  displayLabel.append(display);
  optionsRow.append(displayLabel);

  const playerLabel = document.createElement("label");
  playerLabel.textContent = "Player";
  const player = document.createElement("select");
  player.className = "clip-player-select";
  playerLabel.append(player);
  playerLabel.hidden = true;
  optionsRow.append(playerLabel);

  let quality: HTMLSelectElement | undefined;
  if (options.qualities?.length) {
    const qualityLabel = document.createElement("label");
    qualityLabel.textContent = "Quality";
    quality = document.createElement("select");
    quality.className = "clip-quality-select";
    for (const item of options.qualities) {
      const choice = document.createElement("option");
      choice.value = item.key;
      choice.textContent = item.label;
      quality.append(choice);
    }
    if (initial.qualityKey && options.qualities.some((item) => item.key === initial.qualityKey)) {
      quality.value = initial.qualityKey;
    }
    qualityLabel.append(quality);
    optionsRow.append(qualityLabel);
  }

  let fullFetchConsent: HTMLInputElement | undefined;
  if (options.showDirectFullFetchConsent) {
    const consentLabel = document.createElement("label");
    consentLabel.className = "clip-full-fetch-consent";
    fullFetchConsent = document.createElement("input");
    fullFetchConsent.type = "checkbox";
    consentLabel.append(
      fullFetchConsent,
      document.createTextNode(" Allow a full source fetch only if Range is unavailable and the source is below the configured safety limit"),
    );
    optionsRow.append(consentLabel);
  }

  const capability = document.createElement("div");
  capability.className = "clip-capability";
  const exactOption = mode.querySelector<HTMLOptionElement>('option[value="exact"]')!;
  let exactCapabilityKnown = !options.checkExactCapability;
  let exactCapabilitySupported = true;
  if (options.checkExactCapability) {
    exactOption.disabled = true;
    capability.textContent = "Checking exact mode support…";
  } else {
    capability.textContent = "Exact source compatibility is verified during planning.";
  }

  const error = document.createElement("div");
  error.className = "clip-error";
  error.setAttribute("role", "alert");
  error.setAttribute("aria-live", "assertive");

  const footer = document.createElement("div");
  footer.className = "clip-editor-footer";
  const submit = button("Download clip", "primary-btn clip-submit-btn");
  footer.append(submit);

  root.append(header, fields, durationRow, nudgeRow, optionsRow, capability, error, footer);

  const parseInputs = () => {
    const parsedStart = tryParseTimeInput(start.input.value);
    const parsedEnd = tryParseTimeInput(end.input.value);
    if (!parsedStart.ok) return { error: parsedStart.error?.userMessage ?? parsedStart.error?.message };
    if (!parsedEnd.ok) return { error: parsedEnd.error?.userMessage ?? parsedEnd.error?.message };
    const result = validateClipRange(
      { startMs: parsedStart.milliseconds!, endMs: parsedEnd.milliseconds! },
      { durationMs: currentPlayback?.durationMs ?? options.durationMs },
    );
    if (!result.valid) return { error: result.error.userMessage };
    return { value: result.value };
  };

  const persist = async () => {
    const parsed = parseInputs();
    if (!parsed.value || !options.persistDraft) return;
    await options.persistDraft({
      startMs: parsed.value.startMs,
      endMs: parsed.value.endMs,
      mode: mode.value as ClipMode,
      qualityKey: quality?.value,
      updatedAt: Date.now(),
    });
  };

  const normalizeAndValidate = (): boolean => {
    const parsed = parseInputs();
    if (!parsed.value) {
      error.textContent = parsed.error ?? "Enter a valid clip range.";
      duration.textContent = "—";
      submit.disabled = true;
      return false;
    }
    error.textContent = parsed.value.warning ?? "";
    start.input.value = formatEditorTime(parsed.value.startMs, timeDisplay);
    end.input.value = formatEditorTime(parsed.value.endMs, timeDisplay);
    duration.textContent = formatEditorTime(parsed.value.durationMs, timeDisplay);
    submit.disabled = mode.value === "exact"
      && (!exactCapabilityKnown || !exactCapabilitySupported);
    return true;
  };

  const updateCurrent = () => {
    if (!currentPlayback) {
      current.textContent = options.getPlayback ? "No matching player — manual timestamps available" : "Manual timestamps";
      start.setButton.disabled = true;
      end.setButton.disabled = true;
      return;
    }
    current.textContent = currentPlayback.requiresSelection
      ? "Choose a player before marking playback time"
      : `${currentPlayback.label ? `${currentPlayback.label} · ` : ""}${formatEditorTime(currentPlayback.currentTimeMs, timeDisplay)}`;
    const alternatives = currentPlayback.alternatives ?? [];
    playerLabel.hidden = alternatives.length < 2;
    if (alternatives.length >= 2) {
      const previous = preferredPageVideoId;
      const choices = alternatives.map((alternative, index) => {
        const option = document.createElement("option");
        option.value = alternative.pageVideoId;
        option.textContent = alternative.label || `Player ${index + 1}`;
        return option;
      });
      if (currentPlayback.requiresSelection) {
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Choose a player…";
        choices.unshift(placeholder);
      }
      player.replaceChildren(...choices);
      if (previous && alternatives.some((candidate) => candidate.pageVideoId === previous)) {
        player.value = previous;
      } else if (currentPlayback.requiresSelection) {
        player.value = "";
      }
    }
    start.setButton.disabled = Boolean(currentPlayback.requiresSelection);
    end.setButton.disabled = Boolean(currentPlayback.requiresSelection);
  };

  const refreshPlayback = async () => {
    if (!options.getPlayback || polling || destroyed) return;
    polling = true;
    try {
      const playback = await options.getPlayback(preferredPageVideoId);
      if (destroyed) return;
      currentPlayback = playback;
      updateCurrent();
    } catch {
      if (destroyed) return;
      currentPlayback = null;
      updateCurrent();
    } finally {
      polling = false;
    }
  };

  const mark = (input: HTMLInputElement) => {
    if (!currentPlayback || currentPlayback.requiresSelection) {
      error.textContent = currentPlayback?.requiresSelection
        ? "Choose a player before marking playback time."
        : "No matching player is available. Enter the timestamp manually.";
      return;
    }
    input.value = formatEditorTime(currentPlayback.currentTimeMs, timeDisplay);
    markSource = "playback";
    normalizeAndValidate();
    void persist();
  };

  start.setButton.addEventListener("click", () => mark(start.input));
  end.setButton.addEventListener("click", () => mark(end.input));
  start.input.addEventListener("focus", () => { start.input.dataset.focused = "true"; delete end.input.dataset.focused; });
  end.input.addEventListener("focus", () => { end.input.dataset.focused = "true"; delete start.input.dataset.focused; });
  for (const input of [start.input, end.input]) {
    input.addEventListener("input", () => {
      markSource = "manual";
      normalizeAndValidate();
    });
    input.addEventListener("change", () => void persist());
    input.addEventListener("blur", normalizeAndValidate);
  }
  nudgeRow.addEventListener("click", (event) => {
    const nudge = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-delta-ms]");
    if (!nudge) return;
    const input = end.input.dataset.focused ? end.input : start.input;
    const parsed = tryParseTimeInput(input.value);
    if (!parsed.ok) return;
    const knownDurationMs = currentPlayback?.durationMs ?? options.durationMs;
    const adjusted = Math.max(
      0,
      parsed.milliseconds! + Number(nudge.dataset.deltaMs),
    );
    const clamped = knownDurationMs === undefined
      ? adjusted
      : Math.min(adjusted, knownDurationMs);
    input.value = formatEditorTime(clamped, timeDisplay);
    markSource = "manual";
    normalizeAndValidate();
    void persist();
  });
  reset.addEventListener("click", () => {
    start.input.value = formatEditorTime(freshDefaults.startMs, timeDisplay);
    end.input.value = formatEditorTime(freshDefaults.endMs, timeDisplay);
    mode.value = freshDefaults.mode;
    if (quality) quality.selectedIndex = 0;
    if (fullFetchConsent) fullFetchConsent.checked = false;
    markSource = "manual";
    normalizeAndValidate();
    void persist();
  });
  mode.addEventListener("change", () => {
    normalizeAndValidate();
    void persist();
  });
  display.addEventListener("change", () => {
    const parsedStart = tryParseTimeInput(start.input.value);
    const parsedEnd = tryParseTimeInput(end.input.value);
    timeDisplay = display.value as TimeDisplay;
    if (parsedStart.ok) start.input.value = formatEditorTime(parsedStart.milliseconds!, timeDisplay);
    if (parsedEnd.ok) end.input.value = formatEditorTime(parsedEnd.milliseconds!, timeDisplay);
    normalizeAndValidate();
    updateCurrent();
  });
  quality?.addEventListener("change", () => void persist());
  player.addEventListener("change", () => {
    preferredPageVideoId = player.value;
    void refreshPlayback();
  });
  submit.addEventListener("click", async () => {
    const parsed = parseInputs();
    if (!parsed.value) {
      normalizeAndValidate();
      return;
    }
    submit.disabled = true;
    error.textContent = "";
    const qualityOption = options.qualities?.find((item) => item.key === quality?.value);
    try {
      await options.onSubmit({
        clip: {
          startMs: parsed.value.startMs,
          endMs: parsed.value.endMs,
          mode: mode.value as ClipMode,
          markSource,
        },
        qualityKey: quality?.value,
        manifestQuality: qualityOption?.selection,
        allowFullFetchForDirect: fullFetchConsent?.checked || undefined,
      });
      await persist();
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : String(cause);
    } finally {
      submit.disabled = false;
    }
  });
  close.addEventListener("click", () => {
    controller.destroy();
    root.remove();
    options.onClose?.();
  });

  normalizeAndValidate();
  if (options.checkExactCapability) {
    void options.checkExactCapability().then((result) => {
      if (destroyed) return;
      exactCapabilityKnown = true;
      exactCapabilitySupported = result.supported;
      exactOption.disabled = !result.supported;
      capability.textContent = result.supported
        ? "Exact mode is supported by this browser; source codecs are verified during planning."
        : result.reason || "Exact mode is unavailable in this browser.";
      if (!result.supported && mode.value === "exact") mode.value = "fast";
      normalizeAndValidate();
    }).catch(() => {
      if (destroyed) return;
      exactCapabilityKnown = true;
      exactCapabilitySupported = false;
      exactOption.disabled = true;
      capability.textContent = "Exact mode capability could not be verified in this browser.";
      if (mode.value === "exact") mode.value = "fast";
      normalizeAndValidate();
    });
  }
  void refreshPlayback();
  const interval = options.getPlayback
    ? window.setInterval(() => void refreshPlayback(), PLAYBACK_POLL_MS)
    : undefined;

  const controller: ClipEditorController = {
    element: root,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (interval !== undefined) window.clearInterval(interval);
    },
    refreshPlayback,
  };
  return controller;
}
