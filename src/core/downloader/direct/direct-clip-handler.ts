import type { ClipRequest } from "../../clipping/types";
import { generateClipFilename } from "../../clipping/filename";
import { assertValidClipRange } from "../../clipping/validation";
import { ClippingError } from "../../clipping/errors";
import type { AppSettings } from "../../storage/settings";
import { DownloadStage, VideoFormat } from "../../types";
import { saveBlobUrlToFile } from "../../utils/blob-utils";
import {
  processMediabunnyClipOffscreen,
  type MediabunnyOffscreenClipResult,
} from "../../media/mediabunny-clip-bridge";
import {
  assertDirectClipPreflightAllowed,
  preflightDirectClipSource,
  type DirectClipPreflightResult,
} from "./direct-clip-preflight";
import { addOperationHeaderRules, removeHeaderRules } from "../header-rules";

export interface DirectClipProgress {
  stage: DownloadStage;
  percentage: number;
  message: string;
  downloadedBytes?: number;
}

export interface DirectClipHandlerResult extends MediabunnyOffscreenClipResult {
  filePath: string;
  filename: string;
  preflight: DirectClipPreflightResult;
  requestedDurationMs: number;
  warning?: string;
}

export interface DirectClipHandlerDependencies {
  preflight?: typeof preflightDirectClipSource;
  process?: typeof processMediabunnyClipOffscreen;
  save?: typeof saveBlobUrlToFile;
  setupRequestContext?: (
    request: ClipRequest,
    operationId: string,
  ) => Promise<(() => void | Promise<void>) | undefined>;
}

export class DirectClipHandler {
  private readonly preflight: typeof preflightDirectClipSource;
  private readonly process: typeof processMediabunnyClipOffscreen;
  private readonly save: typeof saveBlobUrlToFile;
  private readonly setupRequestContext?: DirectClipHandlerDependencies["setupRequestContext"];

  constructor(dependencies: DirectClipHandlerDependencies = {}) {
    this.preflight = dependencies.preflight ?? preflightDirectClipSource;
    this.process = dependencies.process ?? processMediabunnyClipOffscreen;
    this.save = dependencies.save ?? saveBlobUrlToFile;
    this.setupRequestContext = dependencies.setupRequestContext ?? (async (request, operationId) => {
      const ruleIds = await addOperationHeaderRules({
        operationId,
        urls: [request.url],
        pageUrl: request.pageUrl || request.metadata.pageUrl || request.url,
      });
      return () => removeHeaderRules(ruleIds);
    });
  }

  async clip(
    request: ClipRequest,
    operationId: string,
    settings: AppSettings,
    signal: AbortSignal,
    onProgress?: (progress: DirectClipProgress) => void,
  ): Promise<DirectClipHandlerResult> {
    if (request.format !== VideoFormat.DIRECT) {
      throw new TypeError("DirectClipHandler only accepts direct media requests");
    }
    const range = assertValidClipRange(request.clip, {
      durationMs: request.metadata.duration
        ? Math.round(request.metadata.duration * 1_000)
        : undefined,
      maxDurationMs: settings.clipping.maxClipDurationMs,
    });
    const filename = generateClipFilename({
      title: request.metadata.title,
      suppliedFilename: request.filename,
      startMs: range.startMs,
      endMs: range.endMs,
      quality: request.metadata.quality,
      outputContainer: "mp4",
    });

    let teardown: (() => void | Promise<void>) | undefined;
    try {
      teardown = await this.setupRequestContext?.(request, operationId);
      onProgress?.({ stage: DownloadStage.PLANNING, percentage: 1, message: "Checking byte-range support" });
      const preflight = await this.preflight(request.url, {
        maxSequentialBytes: settings.clipping.directNoRangeMaxBytes,
        signal,
      });
      assertDirectClipPreflightAllowed(preflight, request.allowFullFetchForDirect === true);

      onProgress?.({ stage: DownloadStage.PROCESSING, percentage: 5, message: "Planning media tracks" });
      const processed = await this.process({
        operationId,
        url: request.url,
        startMs: range.startMs,
        endMs: range.endMs,
        exact: request.clip.mode === "exact",
        fullFetch: preflight.capability === "small-sequential",
        maxFullFetchBytes: settings.clipping.directNoRangeMaxBytes,
        maxOutputBytes: settings.clipping.maxInMemoryClipBytes,
        maxCacheSize: settings.clipping.mediabunnyCacheBytes,
        parallelism: settings.clipping.mediabunnyParallelism,
        maxRetries: settings.advanced.maxRetries,
        retryDelayMs: settings.advanced.retryDelayMs,
        retryBackoffFactor: settings.advanced.retryBackoffFactor,
        timeoutMs: settings.ffmpegTimeout,
        signal,
        onProgress: (progress, _processedTimeMs, message) => onProgress?.({
          stage: DownloadStage.PROCESSING,
          percentage: Math.min(95, 5 + progress * 90),
          message: message ?? "Processing clip",
        }),
      });
      if (processed.size > settings.clipping.maxInMemoryClipBytes) {
        throw new ClippingError("OUTPUT_TOO_LARGE", "Clip output exceeded the configured in-memory size limit");
      }

      onProgress?.({ stage: DownloadStage.SAVING, percentage: 98, message: "Saving MP4 clip" });
      const filePath = await this.save(processed.blobUrl, filename, operationId);
      return {
        ...processed,
        filePath,
        filename,
        preflight,
        requestedDurationMs: range.durationMs,
      };
    } finally {
      await teardown?.();
    }
  }
}
