import type {
  ClipMarkSource,
  ClipMode,
  ClipSpec,
  ManifestQualitySelection,
} from "../core/clipping/types";
import { formatTimeMs, tryParseTimeInput } from "../core/clipping/time";
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
}

export interface ClipEditorOptions {
  sourceKey: string;
  durationMs?: number;
  draft?: ClipEditorDraft;
  qualities?: ClipEditorQualityOption[];
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
    mode: options.draft?.mode ?? "fast",
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
  input.value = formatTimeMs(valueMs);
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
  let currentPlayback: ClipEditorPlayback | null = null;
  let preferredPageVideoId: string | undefined;
  let markSource: ClipMarkSource = "manual";
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
  current.setAttribute("aria-live", "polite");
  const close = button("×", "clip-close-btn", "Close clip editor");
  close.setAttribute("aria-label", "Close clip editor");
  header.append(title, current, close);

  const fields = document.createElement("div");
  fields.className = "clip-time-fields";
  const start = createTimeControl("start", initial.startMs);
  const end = createTimeControl("end", initial.endMs);
  fields.append(start.root, end.root);

  const nudgeRow = document.createElement("div");
  nudgeRow.className = "clip-nudges";
  for (const seconds of [-5, -1, 1, 5]) {
    const nudge = button(
      `${seconds > 0 ? "+" : ""}${seconds}s`,
      "clip-nudge-btn",
      `Move the focused timestamp by ${seconds} seconds`,
    );
    nudge.dataset.deltaMs = String(seconds * 1_000);
    nudgeRow.append(nudge);
  }

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

  const capability = document.createElement("div");
  capability.className = "clip-capability";
  capability.textContent = "Exact support is checked after the source is planned.";

  const error = document.createElement("div");
  error.className = "clip-error";
  error.setAttribute("role", "alert");
  error.setAttribute("aria-live", "assertive");

  const footer = document.createElement("div");
  footer.className = "clip-editor-footer";
  const submit = button("Download clip", "primary-btn clip-submit-btn");
  footer.append(submit);

  root.append(header, fields, nudgeRow, optionsRow, capability, error, footer);

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
      submit.disabled = true;
      return false;
    }
    error.textContent = parsed.value.warning ?? "";
    start.input.value = formatTimeMs(parsed.value.startMs);
    end.input.value = formatTimeMs(parsed.value.endMs);
    submit.disabled = false;
    return true;
  };

  const updateCurrent = () => {
    if (!currentPlayback) {
      current.textContent = options.getPlayback ? "No matching player — manual timestamps available" : "Manual timestamps";
      return;
    }
    current.textContent = `${currentPlayback.label ? `${currentPlayback.label} · ` : ""}${formatTimeMs(currentPlayback.currentTimeMs)}`;
    const alternatives = currentPlayback.alternatives ?? [];
    playerLabel.hidden = alternatives.length < 2;
    if (alternatives.length >= 2) {
      const previous = preferredPageVideoId ?? currentPlayback.pageVideoId;
      player.replaceChildren(...alternatives.map((alternative, index) => {
        const option = document.createElement("option");
        option.value = alternative.pageVideoId;
        option.textContent = alternative.label || `Player ${index + 1}`;
        return option;
      }));
      if (previous && alternatives.some((candidate) => candidate.pageVideoId === previous)) {
        player.value = previous;
      }
    }
  };

  const refreshPlayback = async () => {
    if (!options.getPlayback || polling || destroyed) return;
    polling = true;
    try {
      currentPlayback = await options.getPlayback(preferredPageVideoId);
      updateCurrent();
    } catch {
      currentPlayback = null;
      updateCurrent();
    } finally {
      polling = false;
    }
  };

  const mark = (input: HTMLInputElement) => {
    if (!currentPlayback) {
      error.textContent = "No matching player is available. Enter the timestamp manually.";
      return;
    }
    input.value = formatTimeMs(currentPlayback.currentTimeMs);
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
    input.value = formatTimeMs(Math.max(0, parsed.milliseconds! + Number(nudge.dataset.deltaMs)));
    markSource = "manual";
    normalizeAndValidate();
    void persist();
  });
  mode.addEventListener("change", () => void persist());
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
