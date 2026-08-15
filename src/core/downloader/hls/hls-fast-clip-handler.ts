import type { ClipRequest, TrackClipSelection } from "../../clipping/types";
import { generateClipFilename } from "../../clipping/filename";
import { selectIndependentTrackWindows, selectSegmentWindow } from "../../clipping/segment-window";
import { assertValidClipRange } from "../../clipping/validation";
import {
  parseHlsMasterDescriptor,
  parseTimedMediaPlaylist,
  isMasterPlaylist,
  isMediaPlaylist,
  selectHlsClipVariant,
  type HlsMasterDescriptor,
} from "../../parsers/m3u8-parser";
import type { TimedParsedPlaylist } from "../../parsers/playlist-utils";
import type { AppSettings } from "../../storage/settings";
import { DownloadStage, VideoFormat } from "../../types";
import { deleteClipOperationChunks, type ClipTrackKind } from "../../database/clip-chunks";
import {
  downloadSelectedFragments,
  mapDenseSelectionToInputParts,
  type SelectedFragmentDownloadResult,
  type SelectedInputPart,
} from "../selected-fragment-downloader";
import {
  addOperationHeaderRules,
  removeHeaderRules,
  type OperationHeaderRuleScope,
} from "../header-rules";
import { processWithFFmpeg, type ProcessWithFFmpegResult } from "../../ffmpeg/ffmpeg-bridge";
import { fetchTextWithFinalUrl } from "../../utils/fetch-utils";
import { canDownloadHLSManifest } from "../../utils/drm-utils";
import { saveBlobUrlToFile } from "../../utils/blob-utils";
import { CancellationError, DownloadError } from "../../utils/errors";
import { ClippingError } from "../../clipping/errors";
import { throwIfAborted } from "../../utils/cancellation";
import { logger } from "../../utils/logger";
import { MessageType, type FastSegmentedClipPayload } from "../../../shared/messages";

export interface HlsFastClipProgress {
  stage: DownloadStage;
  percentage: number;
  message: string;
  downloadedBytes?: number;
  completedParts?: number;
  totalParts?: number;
}

export interface HlsFastClipResult {
  filePath: string;
  filename: string;
  accuracy: "keyframe-aligned";
  requestedDurationMs: number;
  actualDurationMs?: number;
  mediaFormat: FastSegmentedClipPayload["mediaFormat"];
  selectedVideoPlaylistUrl: string;
  selectedAudioPlaylistUrl?: string;
  selectedVideoParts: number;
  selectedAudioParts: number;
  downloadedBytes: number;
  warning?: string;
}

export interface HlsManifestFetchOptions {
  signal: AbortSignal;
  maxRetries: number;
  retryDelayMs: number;
  retryBackoffFactor: number;
}

export interface HlsFastClipProcessJob {
  operationId: string;
  filename: string;
  payload: Omit<FastSegmentedClipPayload, "downloadId">;
  timeoutMs: number;
  signal: AbortSignal;
  onProgress?: (progress: number, message: string) => void;
}

export interface HlsFastClipHandlerDependencies {
  fetchManifest?: (
    url: string,
    options: HlsManifestFetchOptions,
  ) => Promise<{ text: string; finalUrl: string }>;
  downloadSelected?: typeof downloadSelectedFragments;
  addRules?: (scope: OperationHeaderRuleScope) => Promise<number[]>;
  removeRules?: typeof removeHeaderRules;
  deleteOperationChunks?: typeof deleteClipOperationChunks;
  process?: (job: HlsFastClipProcessJob) => Promise<ProcessWithFFmpegResult>;
  save?: typeof saveBlobUrlToFile;
}

interface ResolvedMediaPlaylist {
  url: string;
  text: string;
  parsed: TimedParsedPlaylist;
}

interface TrackDownloadPlan {
  kind: ClipTrackKind;
  selection: TrackClipSelection;
  parts: SelectedInputPart[];
}

const defaultFetchManifest: NonNullable<HlsFastClipHandlerDependencies["fetchManifest"]> =
  (url, options) =>
    fetchTextWithFinalUrl(
      url,
      options.maxRetries,
      options.signal,
      false,
      options.retryDelayMs,
      options.retryBackoffFactor,
    );

const defaultProcess: NonNullable<HlsFastClipHandlerDependencies["process"]> =
  (job) =>
    processWithFFmpeg({
      requestType: MessageType.OFFSCREEN_PROCESS_FAST_SEGMENTED_CLIP,
      responseType: MessageType.OFFSCREEN_PROCESS_FAST_SEGMENTED_CLIP_RESPONSE,
      downloadId: job.operationId,
      payload: job.payload,
      filename: job.filename,
      timeout: job.timeoutMs,
      abortSignal: job.signal,
      onProgress: job.onProgress,
    });

function resolveUrl(value: string, baseUrl: string): string {
  return new URL(value, baseUrl).href;
}

function assertSupportedClipManifest(text: string): void {
  try {
    canDownloadHLSManifest(text);
  } catch (error) {
    throw new ClippingError(
      "DRM_PROTECTED",
      error instanceof Error ? error.message : "Unsupported HLS encryption",
      { cause: error },
    );
  }
  if (/#EXT-X-SESSION-KEY:/i.test(text)) {
    throw new ClippingError(
      "DRM_PROTECTED",
      "HLS session-key encryption is not supported for clips",
    );
  }
  for (const match of text.matchAll(/#EXT-X-KEY:([^\r\n]*)/gi)) {
    const attributes = match[1] ?? "";
    const method = attributes.match(/(?:^|,)METHOD=([^,]+)/i)?.[1]?.trim().toUpperCase();
    if (method && method !== "NONE" && method !== "AES-128") {
      throw new ClippingError(
        "DRM_PROTECTED",
        `Unsupported HLS encryption method: ${method}`,
      );
    }
    const keyFormat = attributes.match(/(?:^|,)KEYFORMAT="([^"]+)"/i)?.[1];
    if (keyFormat && keyFormat.toLowerCase() !== "identity") {
      throw new ClippingError(
        "DRM_PROTECTED",
        `Unsupported HLS key format: ${keyFormat}`,
      );
    }
    if (/METHOD=AES-128(?:,|$)/i.test(attributes) && !/(?:^|,)URI="[^"]+"/i.test(attributes)) {
      throw new DownloadError("AES-128 HLS encryption is missing a key URI");
    }
  }
}

function assertVod(playlist: TimedParsedPlaylist, label: string): void {
  if (!playlist.endList) {
    throw new ClippingError(
      "NO_TIMELINE",
      `${label} is live; create a recording instead of a clip`,
    );
  }
  if (playlist.segments.length === 0) {
    throw new ClippingError("NO_TIMELINE", `${label} contains no media segments`);
  }
  if (
    playlist.segments.some(
      (segment) =>
        segment.init &&
        segment.encryption &&
        !segment.encryption.explicitIv,
    )
  ) {
    throw new ClippingError(
      "MEDIA_PROCESSING_FAILED",
      `${label} has an encrypted initialization segment without an explicit IV`,
    );
  }
}

function assertNoDiscontinuityCrossing(
  selection: TrackClipSelection,
  label: string,
): void {
  const sequences = new Set(
    selection.mediaSegments.map((segment) => segment.discontinuitySequence ?? 0),
  );
  if (sequences.size > 1) {
    throw new ClippingError(
      "HLS_DISCONTINUITY_UNSUPPORTED",
      `${label} clip crosses an HLS discontinuity; choose a range within one timeline`,
    );
  }
}

function playlistContainer(
  playlist: TimedParsedPlaylist,
): "hls-ts" | "hls-fmp4" {
  return playlist.segments.some((segment) => segment.init)
    ? "hls-fmp4"
    : "hls-ts";
}

function associatedSelectionForExplicitVideo(
  descriptor: HlsMasterDescriptor,
  videoUrl: string,
): { videoUrl: string | null; audioUrl: string | null } | null {
  const normalized = new URL(videoUrl).href;
  const variant = descriptor.variants.find(
    (candidate) => new URL(candidate.uri).href === normalized,
  );
  if (!variant) return null;
  const audio = variant.audioGroupId
    ? descriptor.audioRenditions
        .filter(
          (candidate) =>
            candidate.groupId === variant.audioGroupId && candidate.uri,
        )
        .sort(
          (left, right) =>
            Number(right.isDefault) - Number(left.isDefault) ||
            Number(right.autoselect) - Number(left.autoselect),
        )[0]
    : undefined;
  return { videoUrl: variant.uri, audioUrl: audio?.uri ?? null };
}

function selectedResourceUrls(plans: readonly TrackDownloadPlan[]): string[] {
  const urls: string[] = [];
  for (const plan of plans) {
    for (const part of plan.parts) {
      urls.push(part.uri);
      if (part.encryption?.keyUri) urls.push(part.encryption.keyUri);
    }
  }
  return urls;
}

export class HlsFastClipHandler {
  private readonly fetchManifest: NonNullable<HlsFastClipHandlerDependencies["fetchManifest"]>;
  private readonly downloadSelected: typeof downloadSelectedFragments;
  private readonly addRules: NonNullable<HlsFastClipHandlerDependencies["addRules"]>;
  private readonly removeRules: typeof removeHeaderRules;
  private readonly deleteOperationChunks: typeof deleteClipOperationChunks;
  private readonly process: NonNullable<HlsFastClipHandlerDependencies["process"]>;
  private readonly save: typeof saveBlobUrlToFile;

  constructor(dependencies: HlsFastClipHandlerDependencies = {}) {
    this.fetchManifest = dependencies.fetchManifest ?? defaultFetchManifest;
    this.downloadSelected = dependencies.downloadSelected ?? downloadSelectedFragments;
    this.addRules = dependencies.addRules ?? addOperationHeaderRules;
    this.removeRules = dependencies.removeRules ?? removeHeaderRules;
    this.deleteOperationChunks =
      dependencies.deleteOperationChunks ?? deleteClipOperationChunks;
    this.process = dependencies.process ?? defaultProcess;
    this.save = dependencies.save ?? saveBlobUrlToFile;
  }

  async clip(
    request: ClipRequest,
    operationId: string,
    settings: AppSettings,
    signal: AbortSignal,
    onProgress?: (progress: HlsFastClipProgress) => void,
  ): Promise<HlsFastClipResult> {
    if (request.format !== VideoFormat.HLS && request.format !== VideoFormat.M3U8) {
      throw new TypeError("HlsFastClipHandler only accepts HLS or M3U8 requests");
    }
    if (request.clip.mode !== "fast") {
      throw new TypeError("HlsFastClipHandler only implements Fast clips");
    }
    assertValidClipRange(request.clip, {
      maxDurationMs: settings.clipping.maxClipDurationMs,
    });
    throwIfAborted(signal);

    const ruleIds = new Set<number>();
    const pageUrl = request.pageUrl ?? request.metadata.pageUrl;
    const fetchOptions: HlsManifestFetchOptions = {
      signal,
      maxRetries: settings.advanced.maxRetries,
      retryDelayMs: settings.advanced.retryDelayMs,
      retryBackoffFactor: settings.advanced.retryBackoffFactor,
    };
    const addScopedRules = async (urls: readonly string[]) => {
      if (!pageUrl || urls.length === 0) return;
      const added = await this.addRules({ operationId, urls, pageUrl });
      for (const id of added) ruleIds.add(id);
    };

    try {
      onProgress?.({
        stage: DownloadStage.PLANNING,
        percentage: 1,
        message: "Resolving HLS playlist",
      });
      await addScopedRules([request.url]);
      const root = await this.fetchManifest(request.url, fetchOptions);
      assertSupportedClipManifest(root.text);

      let video: ResolvedMediaPlaylist;
      let audio: ResolvedMediaPlaylist | undefined;
      let combined = false;

      if (isMediaPlaylist(root.text)) {
        const parsed = parseTimedMediaPlaylist(root.text, root.finalUrl);
        assertVod(parsed, "HLS media playlist");
        video = { url: root.finalUrl, text: root.text, parsed };
        combined = true;
      } else if (isMasterPlaylist(root.text)) {
        const descriptor = parseHlsMasterDescriptor(root.text, root.finalUrl);
        const quality = request.manifestQuality;
        const automatic = selectHlsClipVariant(
          descriptor,
          quality?.selectedBandwidth,
        );
        const explicitVideo = quality?.videoPlaylistUrl
          ? resolveUrl(quality.videoPlaylistUrl, root.finalUrl)
          : undefined;
        const associated = explicitVideo
          ? associatedSelectionForExplicitVideo(descriptor, explicitVideo)
          : null;
        const videoUrl = explicitVideo ?? automatic.videoUrl;
        const audioWasExplicit =
          quality !== undefined &&
          Object.prototype.hasOwnProperty.call(quality, "audioPlaylistUrl");
        const inferredAudioUrl = explicitVideo
          ? associated?.audioUrl ?? null
          : automatic.audioUrl;
        const audioUrl = audioWasExplicit
          ? quality?.audioPlaylistUrl
            ? resolveUrl(quality.audioPlaylistUrl, root.finalUrl)
            : null
          : inferredAudioUrl;

        if (!videoUrl) throw new DownloadError("HLS master has no selectable video variant");
        await addScopedRules([videoUrl, ...(audioUrl ? [audioUrl] : [])]);
        const [videoResponse, audioResponse] = await Promise.all([
          this.fetchManifest(videoUrl, fetchOptions),
          audioUrl ? this.fetchManifest(audioUrl, fetchOptions) : Promise.resolve(undefined),
        ]);
        assertSupportedClipManifest(videoResponse.text);
        const parsedVideo = parseTimedMediaPlaylist(
          videoResponse.text,
          videoResponse.finalUrl,
        );
        assertVod(parsedVideo, "HLS video playlist");
        video = {
          url: videoResponse.finalUrl,
          text: videoResponse.text,
          parsed: parsedVideo,
        };
        if (audioResponse) {
          assertSupportedClipManifest(audioResponse.text);
          const parsedAudio = parseTimedMediaPlaylist(
            audioResponse.text,
            audioResponse.finalUrl,
          );
          assertVod(parsedAudio, "HLS audio playlist");
          audio = {
            url: audioResponse.finalUrl,
            text: audioResponse.text,
            parsed: parsedAudio,
          };
        } else {
          combined = true;
        }
      } else {
        throw new DownloadError("URL is not a valid HLS master or media playlist");
      }

      const authoritativeDurationMs = audio
        ? Math.min(video.parsed.durationMs, audio.parsed.durationMs)
        : video.parsed.durationMs;
      const range = assertValidClipRange(request.clip, {
        durationMs: authoritativeDurationMs,
        maxDurationMs: settings.clipping.maxClipDurationMs,
      });
      const filename = generateClipFilename({
        title: request.metadata.title,
        suppliedFilename: request.filename,
        startMs: range.startMs,
        endMs: range.endMs,
        quality:
          request.metadata.quality ??
          (request.manifestQuality?.selectedBandwidth
            ? `${request.manifestQuality.selectedBandwidth}bps`
            : undefined),
        outputContainer: "mp4",
      });

      let plans: TrackDownloadPlan[];
      let mediaFormat: FastSegmentedClipPayload["mediaFormat"];
      let processPayload: Omit<FastSegmentedClipPayload, "downloadId">;
      if (combined) {
        const selection = selectSegmentWindow(
          video.parsed.segments,
          range.startMs,
          range.endMs,
          "fast",
        );
        if (!selection) throw new DownloadError("Clip range contains no HLS media");
        assertNoDiscontinuityCrossing(selection, "Combined HLS");
        const parts = mapDenseSelectionToInputParts(selection.denseMediaSegments);
        plans = [{ kind: "combined", selection, parts }];
        mediaFormat = playlistContainer(video.parsed);
        processPayload = {
          mediaFormat,
          inputKind: "combined",
          durationMs: range.durationMs,
          combinedLength: parts.length,
          combinedRelativeStartMs: selection.relativeStartMs,
        };
      } else {
        const selected = selectIndependentTrackWindows(
          video.parsed.segments,
          audio!.parsed.segments,
          range.startMs,
          range.endMs,
          "fast",
        );
        if (!selected.video || !selected.audio) {
          throw new DownloadError("Clip range is missing required HLS video or audio media");
        }
        assertNoDiscontinuityCrossing(selected.video, "HLS video");
        assertNoDiscontinuityCrossing(selected.audio, "HLS audio");
        const videoContainer = playlistContainer(video.parsed);
        const audioContainer = playlistContainer(audio!.parsed);
        if (videoContainer !== audioContainer) {
          throw new DownloadError(
            "Mixed TS and fMP4 HLS tracks are not supported in one Fast clip",
          );
        }
        mediaFormat = videoContainer;
        const videoParts = mapDenseSelectionToInputParts(
          selected.video.denseMediaSegments,
        );
        const audioParts = mapDenseSelectionToInputParts(
          selected.audio.denseMediaSegments,
        );
        plans = [
          { kind: "video", selection: selected.video, parts: videoParts },
          { kind: "audio", selection: selected.audio, parts: audioParts },
        ];
        processPayload = {
          mediaFormat,
          inputKind: "separate",
          durationMs: range.durationMs,
          videoLength: videoParts.length,
          audioLength: audioParts.length,
          videoRelativeStartMs: selected.video.relativeStartMs,
          audioRelativeStartMs: selected.audio.relativeStartMs,
        };
      }

      await addScopedRules([
        video.url,
        ...(audio ? [audio.url] : []),
        ...selectedResourceUrls(plans),
      ]);
      throwIfAborted(signal);
      onProgress?.({
        stage: DownloadStage.DOWNLOADING,
        percentage: 5,
        message: "Downloading selected HLS segments",
        completedParts: 0,
        totalParts: plans.reduce((sum, plan) => sum + plan.parts.length, 0),
      });

      const trackProgress = new Map<ClipTrackKind, {
        completedParts: number;
        totalParts: number;
        downloadedBytes: number;
      }>();
      const downloadController = new AbortController();
      const cancelDownloads = () => downloadController.abort();
      signal.addEventListener("abort", cancelDownloads, { once: true });
      let downloadResults: SelectedFragmentDownloadResult[];
      try {
        let primaryDownloadError: unknown;
        const jobs = plans.map((plan) =>
          this.downloadSelected({
            operationId,
            trackKind: plan.kind,
            parts: plan.parts,
            signal: downloadController.signal,
            maxConcurrent: settings.maxConcurrent,
            maxRetries: settings.advanced.maxRetries,
            retryDelayMs: settings.advanced.retryDelayMs,
            retryBackoffFactor: settings.advanced.retryBackoffFactor,
            onProgress: (progress) => {
              trackProgress.set(plan.kind, progress);
              const aggregate = [...trackProgress.values()].reduce(
                (result, item) => ({
                  completedParts: result.completedParts + item.completedParts,
                  totalParts: result.totalParts + item.totalParts,
                  downloadedBytes: result.downloadedBytes + item.downloadedBytes,
                }),
                { completedParts: 0, totalParts: 0, downloadedBytes: 0 },
              );
              // Include tracks that have not produced their first progress event.
              aggregate.totalParts = plans.reduce(
                (sum, candidate) => sum + candidate.parts.length,
                0,
              );
              onProgress?.({
                stage: DownloadStage.DOWNLOADING,
                percentage:
                  5 + (aggregate.completedParts / aggregate.totalParts) * 70,
                message: "Downloading selected HLS segments",
                ...aggregate,
              });
            },
          }).catch((error) => {
            if (primaryDownloadError === undefined) primaryDownloadError = error;
            downloadController.abort();
            throw error;
          }),
        );
        const settled = await Promise.allSettled(jobs);
        const failure = settled.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failure) throw primaryDownloadError ?? failure.reason;
        downloadResults = settled.map(
          (result) => (result as PromiseFulfilledResult<SelectedFragmentDownloadResult>).value,
        );
      } finally {
        signal.removeEventListener("abort", cancelDownloads);
      }
      throwIfAborted(signal);

      onProgress?.({
        stage: DownloadStage.PROCESSING,
        percentage: 76,
        message: "Creating keyframe-aligned MP4 clip",
      });
      const processed = await this.process({
        operationId,
        filename,
        payload: processPayload,
        timeoutMs: settings.ffmpegTimeout,
        signal,
        onProgress: (progress, message) =>
          onProgress?.({
            stage: DownloadStage.PROCESSING,
            percentage: 76 + Math.min(1, Math.max(0, progress)) * 20,
            message: message || "Processing HLS clip",
          }),
      });
      onProgress?.({
        stage: DownloadStage.SAVING,
        percentage: 98,
        message: "Saving MP4 clip",
      });
      const filePath = await this.save(processed.blobUrl, filename, operationId);
      const downloadedBytes = downloadResults.reduce(
        (sum, result) => sum + result.downloadedBytes,
        0,
      );
      return {
        filePath,
        filename,
        accuracy: "keyframe-aligned",
        requestedDurationMs: range.durationMs,
        mediaFormat,
        selectedVideoPlaylistUrl: video.url,
        selectedAudioPlaylistUrl: audio?.url,
        selectedVideoParts: plans.find((plan) => plan.kind !== "audio")?.parts.length ?? 0,
        selectedAudioParts: plans.find((plan) => plan.kind === "audio")?.parts.length ?? 0,
        downloadedBytes,
        warning: processed.warning,
      };
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new CancellationError();
      }
      throw error;
    } finally {
      const cleanup = await Promise.allSettled([
        this.deleteOperationChunks(operationId),
        this.removeRules([...ruleIds]),
      ]);
      for (const result of cleanup) {
        if (result.status === "rejected") {
          logger.warn(`HLS clip cleanup failed: ${String(result.reason)}`);
        }
      }
    }
  }
}
