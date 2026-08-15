import type {
  ClipRequest,
  IndependentTrackClipSelection,
  TrackClipSelection,
} from "../../clipping/types";
import { generateClipFilename } from "../../clipping/filename";
import { assertValidClipRange } from "../../clipping/validation";
import {
  parseTimedDashTracks,
  selectDashTrackWindows,
  type DashTrackSelectionOptions,
} from "../../parsers/mpd-parser";
import type { AppSettings } from "../../storage/settings";
import { DownloadStage, VideoFormat } from "../../types";
import {
  deleteClipOperationChunks,
  type ClipTrackKind,
} from "../../database/clip-chunks";
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
import {
  processWithFFmpeg,
  type ProcessWithFFmpegResult,
} from "../../ffmpeg/ffmpeg-bridge";
import { fetchTextWithFinalUrl } from "../../utils/fetch-utils";
import { saveBlobUrlToFile } from "../../utils/blob-utils";
import { CancellationError, DownloadError } from "../../utils/errors";
import { throwIfAborted } from "../../utils/cancellation";
import { logger } from "../../utils/logger";
import {
  MessageType,
  type FastSegmentedClipPayload,
} from "../../../shared/messages";

export interface DashFastClipProgress {
  stage: DownloadStage;
  percentage: number;
  message: string;
  downloadedBytes?: number;
  completedParts?: number;
  totalParts?: number;
}

export interface DashFastClipResult {
  filePath: string;
  filename: string;
  accuracy: "keyframe-aligned";
  requestedDurationMs: number;
  actualDurationMs?: number;
  mediaFormat: "dash-fmp4";
  inputKind: "combined" | "separate";
  videoRepresentationId: string;
  audioRepresentationId?: string;
  selectedVideoParts: number;
  selectedAudioParts: number;
  downloadedBytes: number;
  warning?: string;
}

export interface DashManifestFetchOptions {
  signal: AbortSignal;
  maxRetries: number;
  retryDelayMs: number;
  retryBackoffFactor: number;
}

export interface DashFastClipProcessJob {
  operationId: string;
  filename: string;
  payload: Omit<FastSegmentedClipPayload, "downloadId">;
  timeoutMs: number;
  signal: AbortSignal;
  onProgress?: (progress: number, message: string) => void;
}

export interface DashFastClipHandlerDependencies {
  fetchManifest?: (
    url: string,
    options: DashManifestFetchOptions,
  ) => Promise<{ text: string; finalUrl: string }>;
  parseTracks?: typeof parseTimedDashTracks;
  selectWindows?: typeof selectDashTrackWindows;
  downloadSelected?: typeof downloadSelectedFragments;
  /** Optional media fetch implementation, primarily for integration testing. */
  fetchMedia?: typeof fetch;
  addRules?: (scope: OperationHeaderRuleScope) => Promise<number[]>;
  removeRules?: typeof removeHeaderRules;
  deleteOperationChunks?: typeof deleteClipOperationChunks;
  process?: (job: DashFastClipProcessJob) => Promise<ProcessWithFFmpegResult>;
  save?: typeof saveBlobUrlToFile;
}

interface TrackDownloadPlan {
  kind: ClipTrackKind;
  selection: TrackClipSelection;
  parts: SelectedInputPart[];
}

const defaultFetchManifest: NonNullable<
  DashFastClipHandlerDependencies["fetchManifest"]
> = (url, options) =>
  fetchTextWithFinalUrl(
    url,
    options.maxRetries,
    options.signal,
    false,
    options.retryDelayMs,
    options.retryBackoffFactor,
  );

const defaultProcess: NonNullable<DashFastClipHandlerDependencies["process"]> =
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

function selectedResourceUrls(plans: readonly TrackDownloadPlan[]): string[] {
  return plans.flatMap((plan) => plan.parts.map((part) => part.uri));
}

function selectionOptions(request: ClipRequest): DashTrackSelectionOptions {
  return {
    ...(request.manifestQuality?.selectedBandwidth !== undefined
      ? { videoBandwidth: request.manifestQuality.selectedBandwidth }
      : {}),
    ...(request.manifestQuality?.representationId
      ? { videoRepresentationId: request.manifestQuality.representationId }
      : {}),
  };
}

function requireSelections(
  selected: IndependentTrackClipSelection,
  hasAudioTrack: boolean,
): asserts selected is IndependentTrackClipSelection & {
  video: TrackClipSelection;
} {
  if (!selected.video || (hasAudioTrack && !selected.audio)) {
    throw new DownloadError(
      "Clip range is missing required DASH video or audio media",
    );
  }
}

export class DashFastClipHandler {
  private readonly fetchManifest: NonNullable<
    DashFastClipHandlerDependencies["fetchManifest"]
  >;
  private readonly parseTracks: typeof parseTimedDashTracks;
  private readonly selectWindows: typeof selectDashTrackWindows;
  private readonly downloadSelected: typeof downloadSelectedFragments;
  private readonly fetchMedia?: typeof fetch;
  private readonly addRules: NonNullable<DashFastClipHandlerDependencies["addRules"]>;
  private readonly removeRules: typeof removeHeaderRules;
  private readonly deleteOperationChunks: typeof deleteClipOperationChunks;
  private readonly process: NonNullable<DashFastClipHandlerDependencies["process"]>;
  private readonly save: typeof saveBlobUrlToFile;

  constructor(dependencies: DashFastClipHandlerDependencies = {}) {
    this.fetchManifest = dependencies.fetchManifest ?? defaultFetchManifest;
    this.parseTracks = dependencies.parseTracks ?? parseTimedDashTracks;
    this.selectWindows = dependencies.selectWindows ?? selectDashTrackWindows;
    this.downloadSelected =
      dependencies.downloadSelected ?? downloadSelectedFragments;
    this.fetchMedia = dependencies.fetchMedia;
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
    onProgress?: (progress: DashFastClipProgress) => void,
  ): Promise<DashFastClipResult> {
    if (request.format !== VideoFormat.DASH) {
      throw new TypeError("DashFastClipHandler only accepts DASH requests");
    }
    if (request.clip.mode !== "fast") {
      throw new TypeError("DashFastClipHandler only implements Fast clips");
    }
    assertValidClipRange(request.clip, {
      maxDurationMs: settings.clipping.maxClipDurationMs,
    });
    throwIfAborted(signal);

    const ruleIds = new Set<number>();
    const pageUrl = request.pageUrl || request.metadata.pageUrl || request.url;
    const fetchOptions: DashManifestFetchOptions = {
      signal,
      maxRetries: settings.advanced.maxRetries,
      retryDelayMs: settings.advanced.retryDelayMs,
      retryBackoffFactor: settings.advanced.retryBackoffFactor,
    };
    const addScopedRules = async (urls: readonly string[]) => {
      if (urls.length === 0) return;
      const added = await this.addRules({ operationId, urls, pageUrl });
      for (const id of added) ruleIds.add(id);
    };

    try {
      onProgress?.({
        stage: DownloadStage.PLANNING,
        percentage: 1,
        message: "Resolving DASH manifest",
      });
      await addScopedRules([request.url]);
      const manifest = await this.fetchManifest(request.url, fetchOptions);
      const tracks = this.parseTracks(
        manifest.text,
        manifest.finalUrl,
        selectionOptions(request),
      );
      const range = assertValidClipRange(request.clip, {
        durationMs: tracks.durationMs,
        maxDurationMs: settings.clipping.maxClipDurationMs,
      });
      const selected = this.selectWindows(
        tracks,
        range.startMs,
        range.endMs,
        "fast",
      );
      requireSelections(selected, tracks.audio !== null);

      const filename = generateClipFilename({
        title: request.metadata.title,
        suppliedFilename: request.filename,
        startMs: range.startMs,
        endMs: range.endMs,
        quality:
          request.metadata.quality ??
          (tracks.video.height ? `${tracks.video.height}p` : undefined),
        outputContainer: "mp4",
      });

      const plans: TrackDownloadPlan[] = [];
      let processPayload: Omit<FastSegmentedClipPayload, "downloadId">;
      let inputKind: DashFastClipResult["inputKind"];
      if (tracks.audio && selected.audio) {
        const videoParts = mapDenseSelectionToInputParts(
          selected.video.denseMediaSegments,
        );
        const audioParts = mapDenseSelectionToInputParts(
          selected.audio.denseMediaSegments,
        );
        plans.push(
          { kind: "video", selection: selected.video, parts: videoParts },
          { kind: "audio", selection: selected.audio, parts: audioParts },
        );
        inputKind = "separate";
        processPayload = {
          mediaFormat: "dash-fmp4",
          inputKind,
          durationMs: range.durationMs,
          videoLength: videoParts.length,
          audioLength: audioParts.length,
          videoRelativeStartMs: selected.video.relativeStartMs,
          audioRelativeStartMs: selected.audio.relativeStartMs,
        };
      } else {
        const parts = mapDenseSelectionToInputParts(
          selected.video.denseMediaSegments,
        );
        plans.push({ kind: "combined", selection: selected.video, parts });
        inputKind = "combined";
        processPayload = {
          mediaFormat: "dash-fmp4",
          inputKind,
          durationMs: range.durationMs,
          combinedLength: parts.length,
          combinedRelativeStartMs: selected.video.relativeStartMs,
        };
      }

      // Parsing, representation selection, timing checks, and Period checks all
      // complete before any selected media resource can be requested.
      await addScopedRules([
        manifest.finalUrl,
        ...selectedResourceUrls(plans),
      ]);
      throwIfAborted(signal);
      const totalParts = plans.reduce(
        (sum, plan) => sum + plan.parts.length,
        0,
      );
      onProgress?.({
        stage: DownloadStage.DOWNLOADING,
        percentage: 5,
        message: "Downloading selected DASH parts",
        completedParts: 0,
        totalParts,
      });

      const trackProgress = new Map<
        ClipTrackKind,
        {
          completedParts: number;
          totalParts: number;
          downloadedBytes: number;
        }
      >();
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
            ...(this.fetchMedia ? { fetchFn: this.fetchMedia } : {}),
            onProgress: (progress) => {
              trackProgress.set(plan.kind, progress);
              const aggregate = [...trackProgress.values()].reduce(
                (result, item) => ({
                  completedParts:
                    result.completedParts + item.completedParts,
                  totalParts: result.totalParts + item.totalParts,
                  downloadedBytes:
                    result.downloadedBytes + item.downloadedBytes,
                }),
                { completedParts: 0, totalParts: 0, downloadedBytes: 0 },
              );
              aggregate.totalParts = totalParts;
              onProgress?.({
                stage: DownloadStage.DOWNLOADING,
                percentage:
                  5 + (aggregate.completedParts / aggregate.totalParts) * 70,
                message: "Downloading selected DASH parts",
                ...aggregate,
              });
            },
          }).catch((error) => {
            if (primaryDownloadError === undefined) {
              primaryDownloadError = error;
            }
            downloadController.abort();
            throw error;
          }),
        );
        const settled = await Promise.allSettled(jobs);
        const failure = settled.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failure) throw primaryDownloadError ?? failure.reason;
        downloadResults = settled.map(
          (result) =>
            (result as PromiseFulfilledResult<SelectedFragmentDownloadResult>)
              .value,
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
            message: message || "Processing DASH clip",
          }),
      });
      onProgress?.({
        stage: DownloadStage.SAVING,
        percentage: 98,
        message: "Saving MP4 clip",
      });
      const filePath = await this.save(
        processed.blobUrl,
        filename,
        operationId,
      );
      const downloadedBytes = downloadResults.reduce(
        (sum, result) => sum + result.downloadedBytes,
        0,
      );
      return {
        filePath,
        filename,
        accuracy: "keyframe-aligned",
        requestedDurationMs: range.durationMs,
        mediaFormat: "dash-fmp4",
        inputKind,
        videoRepresentationId: tracks.video.representationId,
        ...(tracks.audio
          ? { audioRepresentationId: tracks.audio.representationId }
          : {}),
        selectedVideoParts:
          plans.find((plan) => plan.kind !== "audio")?.parts.length ?? 0,
        selectedAudioParts:
          plans.find((plan) => plan.kind === "audio")?.parts.length ?? 0,
        downloadedBytes,
        warning: processed.warning,
      };
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
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
          logger.warn(`DASH clip cleanup failed: ${String(result.reason)}`);
        }
      }
    }
  }
}
