import type { ClipRequest, ManifestQualitySelection } from "../core/clipping/types";
import { selectPlaybackCandidate } from "../core/playback/selection";
import type {
  ClipDraft,
  ClipDraftLocator,
  PlaybackCandidate,
} from "../core/playback/types";
import { VideoFormat, type VideoMetadata } from "../core/types";
import { normalizeUrl } from "../core/utils/url-utils";
import { MessageType, type PlaybackCandidatesMessageResponse } from "../shared/messages";
import {
  createClipEditor,
  type ClipEditorController,
  type ClipEditorDraft,
  type ClipEditorPlayback,
  type ClipEditorQualityOption,
  type ClipEditorSubmit,
} from "./clip-editor";

const controllers = new Map<string, ClipEditorController>();

interface ActiveTabContext {
  tabId: number;
  pageUrl: string;
}

async function getActiveTabContext(): Promise<ActiveTabContext> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error("The active tab is unavailable.");
  return { tabId: tab.id, pageUrl: tab.url ?? "" };
}

function sendMessage<T>(message: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) reject(new Error(lastError.message));
      else resolve(response);
    });
  });
}

function candidateLabel(candidate: PlaybackCandidate, index: number): string {
  let host = "Player";
  try { host = new URL(candidate.frameUrl).hostname || "Player"; } catch {}
  const state = !candidate.paused && !candidate.ended ? "playing" : "paused";
  return `${index + 1}. ${host} · ${state}`;
}

async function loadDraft(locator: ClipDraftLocator): Promise<ClipDraft | null> {
  const response = await sendMessage<{ success: boolean; draft: ClipDraft | null; error?: string }>({
    type: MessageType.GET_CLIP_DRAFT,
    payload: { locator },
  });
  if (!response?.success) throw new Error(response?.error || "Could not restore clip marks.");
  return response.draft;
}

function toEditorDraft(draft: ClipDraft | null): ClipEditorDraft | undefined {
  if (!draft || draft.startMs === undefined || draft.endMs === undefined) return undefined;
  return {
    startMs: draft.startMs,
    endMs: draft.endMs,
    mode: draft.mode,
    qualityKey: draft.quality?.qualityKey,
    updatedAt: draft.updatedAt,
  };
}

async function persistDraft(
  locator: ClipDraftLocator,
  draft: ClipEditorDraft,
  qualities?: ClipEditorQualityOption[],
): Promise<void> {
  const quality = qualities?.find((item) => item.key === draft.qualityKey)?.selection;
  for (const [mark, timeMs] of [["start", draft.startMs], ["end", draft.endMs]] as const) {
    const response = await sendMessage<{ success: boolean; error?: string }>({
      type: MessageType.SET_CLIP_MARK,
      payload: { locator, mark, timeMs, mode: draft.mode, quality },
    });
    if (!response?.success) throw new Error(response?.error || "Could not save clip marks.");
  }
}

function playbackProvider(
  context: ActiveTabContext,
  video: VideoMetadata,
): (preferredPageVideoId?: string) => Promise<ClipEditorPlayback | null> {
  return async (preferredPageVideoId) => {
    const response = await sendMessage<PlaybackCandidatesMessageResponse>({
      type: MessageType.GET_PLAYBACK_CANDIDATES,
      payload: { tabId: context.tabId, pageVideoId: video.pageVideoId },
    });
    if (!response?.success || response.candidates.length === 0) return null;

    const preferred = preferredPageVideoId
      ? response.candidates.find((candidate) => candidate.pageVideoId === preferredPageVideoId)
      : undefined;
    const selection = selectPlaybackCandidate(response.candidates, {
      pageVideoId: video.pageVideoId,
      sourceUrl: video.url,
    });
    const candidate = preferred ?? selection.candidate;
    if (!candidate) return null;
    return {
      pageVideoId: candidate.pageVideoId,
      currentTimeMs: candidate.currentTimeMs,
      durationMs: candidate.durationMs,
      label: selection.ambiguous ? "Choose a player" : candidateLabel(candidate, 0),
      alternatives: selection.alternatives.map((item, index) => ({
        pageVideoId: item.pageVideoId,
        label: candidateLabel(item, index),
      })),
    };
  };
}

function buildRequest(
  video: VideoMetadata,
  context: ActiveTabContext,
  value: ClipEditorSubmit,
): ClipRequest {
  return {
    url: normalizeUrl(video.url),
    format: video.format,
    clip: value.clip,
    metadata: video,
    pageUrl: context.pageUrl || video.pageUrl,
    tabId: context.tabId,
    pageVideoId: video.pageVideoId,
    frameId: video.frameId,
    manifestQuality: value.manifestQuality,
    outputContainer: "mp4",
  };
}

async function mountEditor(
  key: string,
  container: HTMLElement,
  video: VideoMetadata,
  qualities?: ClipEditorQualityOption[],
): Promise<ClipEditorController> {
  controllers.get(key)?.destroy();
  container.replaceChildren();
  const context = await getActiveTabContext();
  const locator: ClipDraftLocator = {
    tabId: context.tabId,
    frameId: video.frameId ?? -1,
    pageVideoId: video.pageVideoId,
    sourceKey: normalizeUrl(video.url),
  };
  let draft: ClipDraft | null = null;
  try { draft = await loadDraft(locator); } catch {}

  const controller = createClipEditor({
    sourceKey: key,
    durationMs: video.duration ? Math.round(video.duration * 1_000) : undefined,
    draft: toEditorDraft(draft),
    qualities,
    getPlayback: playbackProvider(context, video),
    persistDraft: (value) => persistDraft(locator, value, qualities),
    onSubmit: async (value) => {
      const request = buildRequest(video, context, value);
      const response = await sendMessage<{ success: boolean; request?: ClipRequest; error?: string }>({
        type: MessageType.CLIP_REQUEST,
        payload: request,
      });
      if (!response?.success) throw new Error(response?.error || "The clip request was rejected.");
    },
    onClose: () => controllers.delete(key),
  });
  controllers.set(key, controller);
  container.append(controller.element);
  return controller;
}

export async function toggleDetectedClipEditor(
  button: HTMLElement,
  video: VideoMetadata,
): Promise<void> {
  const key = `detected:${normalizeUrl(video.url)}`;
  const card = button.closest<HTMLElement>(".video-item");
  const container = card?.querySelector<HTMLElement>(".clip-editor-slot");
  if (!container) return;
  if (container.childElementCount > 0) {
    controllers.get(key)?.destroy();
    controllers.delete(key);
    container.replaceChildren();
    return;
  }
  await mountEditor(key, container, video);
}

function selectedManualQuality(): ClipEditorQualityOption[] | undefined {
  const video = document.querySelector<HTMLSelectElement>("#videoQualitySelect");
  const audio = document.querySelector<HTMLSelectElement>("#audioQualitySelect");
  if (!video || video.closest<HTMLElement>("#hlsQualitySelection")?.style.display === "none") return undefined;

  const selection: ManifestQualitySelection = {
    videoPlaylistUrl: video.value || null,
    audioPlaylistUrl: audio?.value || null,
  };
  const selectedBandwidth = Number(video.value);
  if (Number.isFinite(selectedBandwidth) && selectedBandwidth > 0 && !video.value.startsWith("http")) {
    selection.selectedBandwidth = selectedBandwidth;
    delete selection.videoPlaylistUrl;
    delete selection.audioPlaylistUrl;
  }
  const label = [video.selectedOptions[0]?.textContent, audio?.selectedOptions[0]?.textContent]
    .filter(Boolean)
    .join(" + ");
  return [{ key: JSON.stringify(selection), label: label || "Selected quality", selection }];
}

export async function renderManualClipEditor(
  container: HTMLElement,
  url: string,
  format: VideoFormat,
  title = "Manual media",
): Promise<void> {
  const normalizedUrl = normalizeUrl(url);
  const context = await getActiveTabContext();
  const metadata: VideoMetadata = {
    url: normalizedUrl,
    format,
    title,
    pageUrl: context.pageUrl || normalizedUrl,
  };
  await mountEditor(`manual:${normalizedUrl}`, container, metadata, selectedManualQuality());
}

export function destroyClipEditors(): void {
  for (const controller of controllers.values()) controller.destroy();
  controllers.clear();
}
