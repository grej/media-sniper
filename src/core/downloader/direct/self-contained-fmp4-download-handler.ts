import { getDownload, storeDownload } from "../../database/downloads";
import { deleteChunks, storeChunk } from "../../database/chunks";
import { processWithFFmpeg } from "../../ffmpeg/ffmpeg-bridge";
import { DownloadStage, type VideoMetadata } from "../../types";
import { CancellationError, DownloadError } from "../../utils/errors";
import { saveBlobUrlToFile } from "../../utils/blob-utils";
import { logger } from "../../utils/logger";
import { sanitizeFilename } from "../../utils/file-utils";
import { addHeaderRules, removeHeaderRules } from "../header-rules";
import type { DownloadProgressCallback, DirectDownloadHandlerResult } from "../types";
import { MessageType } from "../../../shared/messages";
import { fetchSelfContainedFmp4ToChunks } from "./self-contained-fmp4-fetch";

export interface SelfContainedFmp4DownloadHandlerOptions {
  onProgress?: DownloadProgressCallback;
  ffmpegTimeout?: number;
  maxRetries?: number;
}

export class SelfContainedFmp4DownloadHandler {
  private readonly onProgress?: DownloadProgressCallback;
  private readonly timeout: number;
  private readonly maxRetries: number;

  constructor(options: SelfContainedFmp4DownloadHandlerOptions = {}) {
    this.onProgress = options.onProgress;
    this.timeout = options.ffmpegTimeout ?? 15 * 60 * 1000;
    this.maxRetries = options.maxRetries ?? 3;
  }

  private async updateProgress(
    stateId: string,
    downloaded: number,
    total?: number,
    message = "Downloading complete fMP4...",
  ): Promise<void> {
    const state = await getDownload(stateId);
    if (!state) return;
    state.progress.stage = DownloadStage.DOWNLOADING;
    state.progress.downloaded = downloaded;
    state.progress.total = total;
    state.progress.percentage = total ? downloaded / total * 100 : 0;
    state.progress.message = message;
    state.updatedAt = Date.now();
    await storeDownload(state);
    this.onProgress?.(state);
  }

  async download(
    url: string,
    filename: string,
    stateId: string,
    metadata: VideoMetadata,
    abortSignal: AbortSignal,
  ): Promise<DirectDownloadHandlerResult> {
    let headerRuleIds: number[] = [];
    let lastProgressAt = 0;
    let progressUpdates = Promise.resolve();
    await deleteChunks(stateId);
    try {
      if (metadata.pageUrl) {
        try {
          headerRuleIds = await addHeaderRules(stateId, url, metadata.pageUrl);
        } catch (error) {
          logger.warn("Failed to install fMP4 request headers", error);
        }
      }

      const fetched = await fetchSelfContainedFmp4ToChunks({
        url,
        signal: abortSignal,
        maxRetries: this.maxRetries,
        storeChunk: (index, data) => storeChunk(stateId, index, data),
        onProgress: ({ downloaded, total }) => {
          const now = Date.now();
          if (now - lastProgressAt < 250 && downloaded !== total) return;
          lastProgressAt = now;
          progressUpdates = progressUpdates.then(() => this.updateProgress(
            stateId,
            downloaded,
            total,
            "Downloading complete fMP4...",
          )).catch((error) => {
            logger.warn("Failed to persist fMP4 progress", error);
          });
        },
      });

      await progressUpdates;
      await this.updateProgress(
        stateId,
        fetched.totalBytes,
        fetched.totalBytes,
        fetched.usedRangeFallback
          ? "Reassembled byte ranges; preparing MP4..."
          : "Complete fMP4 received; preparing MP4...",
      );

      const state = await getDownload(stateId);
      if (state) {
        state.progress.stage = DownloadStage.SAVING;
        state.progress.message = "Saving MP4...";
        await storeDownload(state);
        this.onProgress?.(state);
      }

      const safeName = sanitizeFilename(filename).replace(/\.[^/.]+$/, "") || "video";
      const { blobUrl } = await processWithFFmpeg({
        requestType: MessageType.OFFSCREEN_CREATE_MEDIA_BLOB,
        responseType: MessageType.OFFSCREEN_CREATE_MEDIA_BLOB_RESPONSE,
        downloadId: stateId,
        payload: {
          chunkCount: fetched.chunkCount,
          mimeType: "video/mp4",
        },
        filename: safeName,
        timeout: this.timeout,
        abortSignal,
      });
      const filePath = await saveBlobUrlToFile(blobUrl, `${safeName}.mp4`, stateId);

      const completed = await getDownload(stateId);
      if (completed) {
        completed.localPath = filePath;
        completed.metadata.fileExtension = "mp4";
        completed.metadata.isSelfContainedFmp4 = true;
        completed.progress.stage = DownloadStage.COMPLETED;
        completed.progress.message = "Download completed";
        completed.progress.downloaded = fetched.totalBytes;
        completed.progress.total = fetched.totalBytes;
        completed.progress.percentage = 100;
        completed.updatedAt = Date.now();
        await storeDownload(completed);
        this.onProgress?.(completed);
      }
      return { filePath, fileExtension: "mp4" };
    } catch (error) {
      if (abortSignal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new CancellationError();
      }
      throw error instanceof DownloadError
        ? error
        : new DownloadError(`Complete fMP4 download failed: ${error}`);
    } finally {
      await deleteChunks(stateId).catch((error) =>
        logger.warn("Failed to clean fMP4 chunks", error));
      if (headerRuleIds.length > 0) {
        await removeHeaderRules(headerRuleIds).catch((error) =>
          logger.warn("Failed to remove fMP4 request headers", error));
      }
    }
  }
}
