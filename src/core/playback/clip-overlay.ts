import type { ClipMode } from '../clipping/types';
import { formatClockTimeMs } from '../clipping/time';
import { MessageType } from '../../shared/messages';
import { selectPlaybackCandidate } from './selection';
import type { ClipDraft, ClipDraftLocator, PlaybackCandidate } from './types';

export interface ClipOverlayRegistry {
  getCandidates(frameUrl?: string): PlaybackCandidate[];
  getElement?(pageVideoId: string): HTMLVideoElement | undefined;
}

export interface ClipOverlayOptions {
  registry: ClipOverlayRegistry;
  sendMessage: (message: unknown) => Promise<unknown>;
  openExtensionUi: () => Promise<void>;
  document?: Document;
  window?: Window;
  defaultMode?: ClipMode;
  refreshIntervalMs?: number;
  isCandidateEligible?: (candidate: PlaybackCandidate) => boolean;
}

interface DraftResponse {
  success?: boolean;
  draft?: ClipDraft | null;
  error?: string;
}

const PLACEHOLDER_TAB_ID = 0;
const PLACEHOLDER_FRAME_ID = -1;

/** Fixed-width clock used by the always-visible page controls. */
export function formatOverlayTimeMs(milliseconds: number): string {
  return formatClockTimeMs(milliseconds);
}

/** Isolated Shadow DOM controls for marking a clip from page playback. */
export class ClipOverlayController {
  private readonly registry: ClipOverlayRegistry;
  private readonly sendMessage: (message: unknown) => Promise<unknown>;
  private readonly openExtensionUi: () => Promise<void>;
  private readonly document: Document;
  private readonly window: Window;
  private readonly refreshIntervalMs: number;
  private readonly isCandidateEligible: (candidate: PlaybackCandidate) => boolean;
  private host?: HTMLDivElement;
  private timer?: number;
  private candidate?: PlaybackCandidate;
  private draft?: ClipDraft | null;
  private loadedPageVideoId?: string;
  private preferredPageVideoId?: string;
  private playerChoiceSignature = '';
  private defaultMode: ClipMode;
  private enabled = false;

  constructor(options: ClipOverlayOptions) {
    this.registry = options.registry;
    this.sendMessage = options.sendMessage;
    this.openExtensionUi = options.openExtensionUi;
    this.document = options.document ?? document;
    this.window = options.window ?? window;
    this.defaultMode = options.defaultMode ?? 'fast';
    this.refreshIntervalMs = options.refreshIntervalMs ?? 500;
    this.isCandidateEligible = options.isCandidateEligible ?? (() => true);
  }

  get element(): HTMLDivElement | undefined {
    return this.host;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) this.mount();
    else this.unmount();
  }

  setDefaultMode(mode: ClipMode): void {
    this.defaultMode = mode;
  }

  destroy(): void {
    this.enabled = false;
    this.unmount();
  }

  private mount(): void {
    if (this.host || !this.document.documentElement) return;
    const host = this.document.createElement('div');
    host.dataset.mediaSniperClipOverlay = '';
    host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { color-scheme: dark; }
        .panel { display:none; width:260px; box-sizing:border-box; padding:10px; border:1px solid rgba(255,255,255,.16); border-radius:10px; background:rgba(17,24,39,.94); color:#f9fafb; box-shadow:0 12px 30px rgba(0,0,0,.35); font:12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; backdrop-filter:blur(8px); }
        .panel.visible { display:block; }
        .header { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
        .brand { font-weight:650; letter-spacing:.01em; }
        .time { color:#93c5fd; font-variant-numeric:tabular-nums; }
        .marks { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:8px; color:#d1d5db; }
        .mark-value { color:#fff; font-variant-numeric:tabular-nums; }
        .player-choice { display:block; margin-bottom:8px; color:#d1d5db; }
        .player-choice[hidden] { display:none; }
        select { display:block; width:100%; box-sizing:border-box; margin-top:3px; border:1px solid rgba(255,255,255,.16); border-radius:5px; background:#111827; color:#fff; padding:5px; font:11px/1.2 inherit; }
        .buttons { display:flex; gap:6px; }
        button { appearance:none; border:1px solid rgba(255,255,255,.16); border-radius:6px; background:#1f2937; color:#f9fafb; padding:6px 8px; font:600 11px/1.2 inherit; cursor:pointer; }
        button:hover { background:#374151; }
        button:disabled { opacity:.5; cursor:not-allowed; }
        button:focus-visible { outline:2px solid #60a5fa; outline-offset:2px; }
        .open { margin-left:auto; color:#bfdbfe; }
        .status { min-height:16px; margin-top:6px; color:#9ca3af; font-size:10px; }
        .status.error { color:#fca5a5; }
      </style>
      <section class="panel" role="region" aria-label="Media Sniper clip controls">
        <div class="header"><span class="brand">Media Sniper</span><span class="time" aria-label="Current playback time">00:00:00.000</span></div>
        <label class="player-choice" hidden>Player<select class="player-select"><option value="">Choose a player…</option></select></label>
        <div class="marks">
          <span>Start <span class="mark-value start-value">—</span></span>
          <span>End <span class="mark-value end-value">—</span></span>
        </div>
        <div class="buttons">
          <button type="button" data-mark="start" aria-label="Mark clip start at current playback time">Mark start</button>
          <button type="button" data-mark="end" aria-label="Mark clip end at current playback time">Mark end</button>
          <button type="button" class="open" aria-label="Open Media Sniper clip editor">Clip</button>
        </div>
        <div class="status" role="status" aria-live="polite"></div>
      </section>`;
    shadow.querySelectorAll<HTMLButtonElement>('[data-mark]').forEach((button) => {
      button.addEventListener('click', () => {
        const mark = button.dataset.mark as 'start' | 'end';
        void this.mark(mark);
      });
    });
    shadow.querySelector<HTMLButtonElement>('.open')?.addEventListener('click', () => {
      void this.openUi();
    });
    shadow.querySelector<HTMLSelectElement>('.player-select')?.addEventListener('change', (event) => {
      this.preferredPageVideoId = (event.currentTarget as HTMLSelectElement).value || undefined;
      this.refresh();
    });
    this.document.documentElement.append(host);
    this.host = host;
    this.refresh();
    this.timer = this.window.setInterval(() => this.refresh(), this.refreshIntervalMs);
  }

  private unmount(): void {
    if (this.timer !== undefined) this.window.clearInterval(this.timer);
    this.timer = undefined;
    this.host?.remove();
    this.host = undefined;
    this.candidate = undefined;
    this.draft = undefined;
    this.loadedPageVideoId = undefined;
    this.preferredPageVideoId = undefined;
    this.playerChoiceSignature = '';
  }

  private refresh(): void {
    if (!this.host) return;
    const panel = this.host.shadowRoot!.querySelector('.panel');
    if (this.document.fullscreenElement) {
      this.candidate = undefined;
      panel?.classList.remove('visible');
      return;
    }
    const candidates = this.registry.getCandidates(this.window.location.href)
      .filter(this.isCandidateEligible);
    const selection = selectPlaybackCandidate(candidates);
    const choice = this.host.shadowRoot!.querySelector<HTMLElement>('.player-choice');
    const select = this.host.shadowRoot!.querySelector<HTMLSelectElement>('.player-select');
    choice?.toggleAttribute('hidden', !selection.ambiguous);
    if (selection.ambiguous && select) {
      const priorChoice = this.preferredPageVideoId;
      const labels = selection.alternatives.map((candidate, index) => ({
        candidate,
        label: this.candidateLabel(candidate, index),
      }));
      const signature = JSON.stringify(labels.map(({ candidate, label }) => [
        candidate.pageVideoId,
        label,
      ]));
      if (signature !== this.playerChoiceSignature) {
        select.replaceChildren(this.createPlayerOption('', 'Choose a player…'));
        labels.forEach(({ candidate, label }) => {
          select.append(this.createPlayerOption(candidate.pageVideoId, label));
        });
        this.playerChoiceSignature = signature;
      }
      if (priorChoice && selection.alternatives.some(({ pageVideoId }) => pageVideoId === priorChoice)) {
        select.value = priorChoice;
      } else {
        this.preferredPageVideoId = undefined;
      }
    } else {
      this.preferredPageVideoId = undefined;
      this.playerChoiceSignature = '';
    }
    this.candidate = selection.ambiguous
      ? selection.alternatives.find(({ pageVideoId }) => pageVideoId === this.preferredPageVideoId)
      : selection.candidate;
    const shadow = this.host.shadowRoot!;
    panel?.classList.toggle('visible', candidates.length > 0);
    const anchorCandidate = this.candidate ?? selection.candidate;
    if (anchorCandidate) this.positionNearCandidate(anchorCandidate);
    shadow.querySelectorAll<HTMLButtonElement>('[data-mark]')
      .forEach((button) => { button.disabled = !this.candidate; });
    if (!this.candidate) {
      const time = shadow.querySelector<HTMLElement>('.time');
      if (time) time.textContent = selection.ambiguous ? 'Choose player' : '00:00:00.000';
      this.loadedPageVideoId = undefined;
      this.draft = null;
      this.renderDraft();
      if (selection.ambiguous) this.setStatus('Choose a player before marking.');
      return;
    }
    const time = shadow.querySelector<HTMLElement>('.time');
    if (time) time.textContent = formatOverlayTimeMs(this.candidate.currentTimeMs);
    if (this.loadedPageVideoId !== this.candidate.pageVideoId) {
      this.loadedPageVideoId = this.candidate.pageVideoId;
      this.draft = null;
      this.renderDraft();
      void this.loadDraft(this.candidate);
    }
    if (this.statusText() === 'Choose a player before marking.') this.setStatus('');
  }

  private createPlayerOption(value: string, label: string): HTMLOptionElement {
    const option = this.document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }

  private candidateLabel(candidate: PlaybackCandidate, index: number): string {
    let host = `Player ${index + 1}`;
    try { host = new URL(candidate.frameUrl).hostname || host; } catch {}
    const state = !candidate.paused && !candidate.ended ? 'playing' : 'paused';
    return `${host} · ${state}`;
  }

  private positionNearCandidate(candidate: PlaybackCandidate): void {
    const video = this.registry.getElement?.(candidate.pageVideoId);
    if (!video) {
      this.host!.style.left = 'auto';
      this.host!.style.top = 'auto';
      this.host!.style.right = '16px';
      this.host!.style.bottom = '16px';
      return;
    }
    const rect = video.getBoundingClientRect();
    const margin = 8;
    const panelWidth = 260;
    const estimatedPanelHeight = 170;
    const left = Math.max(
      margin,
      Math.min(rect.right - panelWidth, this.window.innerWidth - panelWidth - margin),
    );
    const below = rect.bottom + margin;
    const top = below + estimatedPanelHeight <= this.window.innerHeight
      ? below
      : Math.max(margin, rect.top - estimatedPanelHeight - margin);
    this.host!.style.left = `${Math.round(left)}px`;
    this.host!.style.top = `${Math.round(top)}px`;
    this.host!.style.right = 'auto';
    this.host!.style.bottom = 'auto';
  }

  private locator(candidate: PlaybackCandidate): ClipDraftLocator {
    return {
      tabId: PLACEHOLDER_TAB_ID,
      frameId: PLACEHOLDER_FRAME_ID,
      pageVideoId: candidate.pageVideoId,
      sourceKey: candidate.currentSrc || this.window.location.href,
    };
  }

  private async loadDraft(candidate: PlaybackCandidate): Promise<void> {
    try {
      const response = await this.sendMessage({
        type: MessageType.GET_CLIP_DRAFT,
        payload: { locator: this.locator(candidate) },
      }) as DraftResponse;
      if (this.candidate?.pageVideoId !== candidate.pageVideoId) return;
      if (response?.success === false) throw new Error(response.error || 'Could not load clip marks');
      this.draft = response?.draft ?? null;
      this.renderDraft();
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), true);
    }
  }

  private async mark(mark: 'start' | 'end'): Promise<void> {
    this.refresh();
    const candidate = this.candidate;
    if (!candidate) return;
    this.setStatus('Saving…');
    try {
      const response = await this.sendMessage({
        type: MessageType.SET_CLIP_MARK,
        payload: {
          locator: this.locator(candidate),
          mark,
          timeMs: candidate.currentTimeMs,
          mode: this.draft?.mode ?? this.defaultMode,
          quality: this.draft?.quality,
        },
      }) as DraftResponse;
      if (response?.success === false) throw new Error(response.error || 'Could not save clip mark');
      this.draft = response?.draft ?? this.draft ?? null;
      this.renderDraft();
      this.setStatus(`${mark === 'start' ? 'Start' : 'End'} saved.`);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), true);
    }
  }

  private async openUi(): Promise<void> {
    try {
      await this.openExtensionUi();
      this.setStatus('Opened extension UI.');
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : 'Could not open extension UI', true);
    }
  }

  private renderDraft(): void {
    const shadow = this.host?.shadowRoot;
    if (!shadow) return;
    const start = shadow.querySelector<HTMLElement>('.start-value');
    const end = shadow.querySelector<HTMLElement>('.end-value');
    if (start) start.textContent = this.draft?.startMs === undefined
      ? '—'
      : formatOverlayTimeMs(this.draft.startMs);
    if (end) end.textContent = this.draft?.endMs === undefined
      ? '—'
      : formatOverlayTimeMs(this.draft.endMs);
  }

  private statusText(): string {
    return this.host?.shadowRoot?.querySelector<HTMLElement>('.status')?.textContent ?? '';
  }

  private setStatus(message: string, error = false): void {
    const status = this.host?.shadowRoot?.querySelector<HTMLElement>('.status');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('error', error);
  }
}
