/**
 * Offscreen document script for FFmpeg processing
 * Handles HLS video processing using FFmpeg.wasm
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import {
  MessageType,
  type FastSegmentedClipPayload,
} from "../shared/messages";
import { readChunkRange } from "../core/database/chunks";
import {
  clipTrackNamespace,
  deleteClipOperationChunks,
  type ClipTrackKind,
} from "../core/database/clip-chunks";
import { buildFastSegmentedClipArgs } from "../core/ffmpeg/fast-segmented-args";
import { MediaJobQueue } from "../core/media/media-job-queue";
import { runAbortableMediaJob } from "../core/media/abortable-media-job";
import {
  MediabunnyCapabilityError,
  processMediabunnyClip,
} from "../core/media/mediabunny-clip-processor";
import { logger } from "../core/utils/logger";

let ffmpegInstance: FFmpeg | null = null;

/**
 * Initialize FFmpeg instance
 */
async function getFFmpeg(): Promise<FFmpeg> {
  if (!ffmpegInstance) {
    logger.info("Initializing FFmpeg in offscreen document");
    ffmpegInstance = new FFmpeg();

    await ffmpegInstance.load({
      coreURL: chrome.runtime.getURL("./ffmpeg/core/ffmpeg-core.js"),
      wasmURL: chrome.runtime.getURL("./ffmpeg/core/ffmpeg-core.wasm"),
    });

    ffmpegInstance.on("log", ({ message }) => {
      logger.debug("FFmpeg:", message);
    });

    logger.info("FFmpeg initialized successfully");
  }

  return ffmpegInstance;
}

/**
 * Reset FFmpeg instance so the next call to getFFmpeg() creates a fresh one.
 * Must be called after any FFmpeg failure (e.g. Aborted()) to avoid reusing
 * a corrupted WASM instance.
 */
function resetFFmpeg(): void {
  if (ffmpegInstance) {
    try {
      ffmpegInstance.terminate();
    } catch {
      // Instance may already be in a broken state
    }
    ffmpegInstance = null;
    logger.info("FFmpeg instance reset after failure");
  }
}

const mediaJobQueue = new MediaJobQueue();
const mediaJobControllers = new Map<string, AbortController>();

const VALID_DOWNLOAD_ID = /^[a-zA-Z0-9_-]+$/;

function validateDownloadId(downloadId: string): void {
  if (!downloadId || !VALID_DOWNLOAD_ID.test(downloadId)) {
    throw new Error(`Invalid downloadId: ${downloadId}`);
  }
}

/**
 * Concatenate chunks from IndexedDB
 */
interface ConcatenateResult {
  blob: Blob;
  missingCount: number;
  totalCount: number;
}

async function concatenateChunks(
  downloadId: string,
  startIndex: number,
  length: number,
): Promise<ConcatenateResult> {
  const chunkMap = await readChunkRange(downloadId, startIndex, length);

  const chunks: BlobPart[] = [];
  let missingCount = 0;
  let totalBytes = 0;

  for (let i = 0; i < length; i++) {
    const chunk = chunkMap.get(startIndex + i);
    if (chunk) {
      chunks.push(chunk as BlobPart);
      totalBytes += chunk.byteLength;
    } else {
      missingCount++;
      logger.warn(`Missing chunk at index ${startIndex + i} for ${downloadId}`);
    }
  }

  logger.info(
    `Concatenated ${chunks.length}/${length} chunks (${totalBytes} bytes, ${missingCount} missing) for ${downloadId}`,
  );

  return {
    blob: new Blob(chunks, { type: "video/mp2t" }),
    missingCount,
    totalCount: length,
  };
}

async function concatenateSelectedTrack(
  operationId: string,
  trackKind: ClipTrackKind,
  length: number,
): Promise<Blob> {
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new Error(`Invalid selected ${trackKind} part count: ${length}`);
  }
  const result = await concatenateChunks(
    clipTrackNamespace(operationId, trackKind),
    0,
    length,
  );
  if (result.missingCount > 0) {
    throw new Error(
      `Missing ${result.missingCount} required ${trackKind} clip input part(s)`,
    );
  }
  return result.blob;
}

/**
 * Process video and audio streams with FFmpeg
 */
/**
 * Safely clean up intermediate files from FFmpeg's virtual filesystem
 */
async function cleanupFiles(
  ffmpeg: FFmpeg,
  filenames: string[],
): Promise<void> {
  for (const name of filenames) {
    try {
      await ffmpeg.deleteFile(name);
    } catch {
      logger.debug(
        `Could not delete intermediate file ${name} (may not exist)`,
      );
    }
  }
}

/**
 * Build a user-facing warning string from missing chunk counts.
 * Returns undefined if no chunks are missing.
 */
function buildMissingChunksWarning(
  missingCount: number,
  totalCount: number,
): string | undefined {
  if (missingCount === 0 || totalCount === 0) return undefined;
  const pct = ((missingCount / totalCount) * 100).toFixed(1);
  return `${missingCount} of ${totalCount} chunks were missing (${pct}%) — video may have gaps`;
}

/**
 * Process a single stream (video-only, media playlist, or audio-only muxed content).
 * Handles concatenation, writing, and converting to MP4.
 *
 * Note: HLS streams from master playlists often have audio muxed into the video
 * segments (indicated by codecs like "avc1.64001e,mp4a.40.2"). When there's no
 * separate audio playlist, we copy ALL streams to preserve the embedded audio.
 */
async function processSingleStream(
  ffmpeg: FFmpeg,
  downloadId: string,
  length: number,
  startIndex: number,
  streamLabel: string,
  outputFileName: string,
  ffmpegArgs: string[],
  onProgress?: (progress: number, message: string) => void,
): Promise<string | undefined> {
  const inputFile = `${downloadId}_${streamLabel}.ts`;

  try {
    onProgress?.(0.2, `Concatenating ${streamLabel} chunks`);
    const result = await concatenateChunks(downloadId, startIndex, length);

    onProgress?.(0.5, `Writing ${streamLabel} stream`);
    await ffmpeg.writeFile(inputFile, await fetchFile(result.blob));

    onProgress?.(0.7, "Converting to MP4");
    await ffmpeg.exec(["-y", "-i", inputFile, ...ffmpegArgs, outputFileName]);

    return buildMissingChunksWarning(result.missingCount, result.totalCount);
  } finally {
    await cleanupFiles(ffmpeg, [inputFile]);
  }
}

/**
 * Process audio only stream with FFmpeg
 */
async function processAudioOnly(
  ffmpeg: FFmpeg,
  downloadId: string,
  audioLength: number,
  outputFileName: string,
  onProgress?: (progress: number, message: string) => void,
): Promise<string | undefined> {
  return processSingleStream(
    ffmpeg,
    downloadId,
    audioLength,
    0,
    "audio",
    outputFileName,
    ["-c:a", "copy", "-movflags", "+faststart"],
    onProgress,
  );
}

/**
 * Process HLS chunks and convert to MP4
 */
interface ProcessResult {
  blobUrl: string;
  warning?: string;
}

async function processHLSChunks(
  downloadId: string,
  videoLength: number,
  audioLength: number,
  audioDownloadId?: string,
  onProgress?: (progress: number, message: string) => void,
): Promise<ProcessResult> {
  validateDownloadId(downloadId);
  const ffmpeg = await getFFmpeg();

  const outputFileName = `/tmp/${downloadId}.mp4`;

  // Process based on available streams
  try {
    let warning: string | undefined;

    if (videoLength > 0 && audioLength > 0) {
      if (!audioDownloadId) {
        throw new Error("audioDownloadId required for HLS video+audio mux");
      }
      validateDownloadId(audioDownloadId);
      warning = await processHlsVideoAndAudioSeparate(
        ffmpeg,
        downloadId,
        videoLength,
        audioDownloadId,
        audioLength,
        outputFileName,
        onProgress,
      );
    } else if (videoLength > 0) {
      warning = await processSingleStream(
        ffmpeg,
        downloadId,
        videoLength,
        0,
        "video",
        outputFileName,
        ["-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart"],
        onProgress,
      );
    } else if (audioLength > 0) {
      warning = await processAudioOnly(
        ffmpeg,
        downloadId,
        audioLength,
        outputFileName,
        onProgress,
      );
    } else {
      throw new Error("No video or audio chunks to process");
    }

    // Read the output file
    const data = await ffmpeg.readFile(outputFileName);
    onProgress?.(1, "Done");

    // Create blob URL
    const blob = new Blob([data as BlobPart], { type: "video/mp4" });
    const blobUrl = URL.createObjectURL(blob);

    // Cleanup output file
    try {
      await ffmpeg.deleteFile(outputFileName);
    } catch {
      // File may not exist, ignore error
    }

    return { blobUrl, warning };
  } catch (error) {
    resetFFmpeg();
    logger.error(`FFmpeg processing failed for ${downloadId}:`, error);
    throw error;
  }
}

/**
 * Process HLS recording: video and audio stored under separate downloadId namespaces.
 * Video: (videoDownloadId, 0, videoLength), Audio: (audioDownloadId, 0, audioLength).
 * Uses .ts intermediate files and -bsf:a aac_adtstoasc (HLS/MPEG-TS container).
 */
async function processHlsVideoAndAudioSeparate(
  ffmpeg: FFmpeg,
  videoDownloadId: string,
  videoLength: number,
  audioDownloadId: string,
  audioLength: number,
  outputFileName: string,
  onProgress?: (progress: number, message: string) => void,
): Promise<string | undefined> {
  const videoFile = `${videoDownloadId}_video.ts`;
  const audioFile = `${audioDownloadId}_audio.ts`;

  try {
    onProgress?.(0.1, "Concatenating chunks");
    const [videoResult, audioResult] = await Promise.all([
      concatenateChunks(videoDownloadId, 0, videoLength),
      concatenateChunks(audioDownloadId, 0, audioLength),
    ]);

    onProgress?.(0.5, "Writing video stream");
    await ffmpeg.writeFile(videoFile, await fetchFile(videoResult.blob));

    onProgress?.(0.6, "Writing audio stream");
    await ffmpeg.writeFile(audioFile, await fetchFile(audioResult.blob));

    onProgress?.(0.7, "Merging video and audio");
    await ffmpeg.exec([
      "-y",
      "-i", videoFile,
      "-i", audioFile,
      "-c:v", "copy",
      "-c:a", "copy",
      "-bsf:a", "aac_adtstoasc",
      "-shortest",
      "-movflags", "+faststart",
      outputFileName,
    ]);

    const totalMissing = videoResult.missingCount + audioResult.missingCount;
    const totalChunks = videoResult.totalCount + audioResult.totalCount;
    return buildMissingChunksWarning(totalMissing, totalChunks);
  } finally {
    await cleanupFiles(ffmpeg, [videoFile, audioFile]);
  }
}

async function processDashSingleStream(
  ffmpeg: FFmpeg,
  downloadId: string,
  fragmentCount: number,
  outputFileName: string,
  onProgress?: (progress: number, message: string) => void,
): Promise<string | undefined> {
  const inputFile = `${downloadId}_media.mp4`;

  try {
    onProgress?.(0.2, "Concatenating segments");
    const result = await concatenateChunks(downloadId, 0, fragmentCount);

    onProgress?.(0.5, "Writing media stream");
    await ffmpeg.writeFile(inputFile, await fetchFile(result.blob));

    onProgress?.(0.7, "Converting to MP4");
    await ffmpeg.exec([
      "-y",
      "-i", inputFile,
      "-c", "copy",
      "-movflags", "+faststart",
      outputFileName,
    ]);

    return buildMissingChunksWarning(result.missingCount, result.totalCount);
  } finally {
    await cleanupFiles(ffmpeg, [inputFile]);
  }
}

/**
 * Process DASH recording: video and audio stored under separate downloadId namespaces.
 * Video: (videoDownloadId, 0, videoLength), Audio: (audioDownloadId, 0, audioLength).
 */
async function processDashVideoAndAudioSeparate(
  ffmpeg: FFmpeg,
  videoDownloadId: string,
  videoLength: number,
  audioDownloadId: string,
  audioLength: number,
  outputFileName: string,
  onProgress?: (progress: number, message: string) => void,
): Promise<string | undefined> {
  const videoFile = `${videoDownloadId}_video.mp4`;
  const audioFile = `${audioDownloadId}_audio.mp4`;

  try {
    onProgress?.(0.1, "Concatenating chunks");
    const [videoResult, audioResult] = await Promise.all([
      concatenateChunks(videoDownloadId, 0, videoLength),
      concatenateChunks(audioDownloadId, 0, audioLength),
    ]);

    onProgress?.(0.5, "Writing video stream");
    await ffmpeg.writeFile(videoFile, await fetchFile(videoResult.blob));

    onProgress?.(0.6, "Writing audio stream");
    await ffmpeg.writeFile(audioFile, await fetchFile(audioResult.blob));

    onProgress?.(0.7, "Merging video and audio");
    await ffmpeg.exec([
      "-y",
      "-i", videoFile,
      "-i", audioFile,
      "-c:v", "copy",
      "-c:a", "copy",
      "-shortest",
      "-movflags", "+faststart",
      outputFileName,
    ]);

    const totalMissing = videoResult.missingCount + audioResult.missingCount;
    const totalChunks = videoResult.totalCount + audioResult.totalCount;
    return buildMissingChunksWarning(totalMissing, totalChunks);
  } finally {
    await cleanupFiles(ffmpeg, [videoFile, audioFile]);
  }
}

async function processDashChunks(
  downloadId: string,
  videoLength: number,
  audioLength: number,
  audioDownloadId?: string,
  onProgress?: (progress: number, message: string) => void,
): Promise<ProcessResult> {
  validateDownloadId(downloadId);
  const ffmpeg = await getFFmpeg();

  const outputFileName = `/tmp/${downloadId}.mp4`;

  try {
    let warning: string | undefined;

    if (videoLength > 0 && audioLength > 0) {
      if (!audioDownloadId) {
        throw new Error("audioDownloadId required for DASH video+audio mux");
      }
      validateDownloadId(audioDownloadId);
      warning = await processDashVideoAndAudioSeparate(
        ffmpeg,
        downloadId,
        videoLength,
        audioDownloadId,
        audioLength,
        outputFileName,
        onProgress,
      );
    } else if (videoLength > 0) {
      warning = await processDashSingleStream(
        ffmpeg,
        downloadId,
        videoLength,
        outputFileName,
        onProgress,
      );
    } else {
      throw new Error("No DASH chunks to process");
    }

    const data = await ffmpeg.readFile(outputFileName);
    onProgress?.(1, "Done");

    const blob = new Blob([data as BlobPart], { type: "video/mp4" });
    const blobUrl = URL.createObjectURL(blob);

    try {
      await ffmpeg.deleteFile(outputFileName);
    } catch {
      // File may not exist, ignore error
    }

    return { blobUrl, warning };
  } catch (error) {
    resetFFmpeg();
    logger.error(`FFmpeg DASH processing failed for ${downloadId}:`, error);
    throw error;
  }
}

/**
 * Process M3U8 media playlist chunks and convert to MP4
 */
async function processM3u8Chunks(
  downloadId: string,
  fragmentCount: number,
  onProgress?: (progress: number, message: string) => void,
): Promise<ProcessResult> {
  validateDownloadId(downloadId);
  const ffmpeg = await getFFmpeg();

  const outputFileName = `/tmp/${downloadId}.mp4`;

  if (fragmentCount === 0) {
    throw new Error("No fragments to process");
  }

  try {
    // Process M3U8 media playlist
    const warning = await processSingleStream(
      ffmpeg,
      downloadId,
      fragmentCount,
      0,
      "media",
      outputFileName,
      ["-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart"],
      onProgress,
    );

    // Read the output file
    const data = await ffmpeg.readFile(outputFileName);
    onProgress?.(1, "Done");

    // Create blob URL
    const blob = new Blob([data as BlobPart], { type: "video/mp4" });
    const blobUrl = URL.createObjectURL(blob);

    // Cleanup output file
    try {
      await ffmpeg.deleteFile(outputFileName);
    } catch {
      // File may not exist, ignore error
    }

    return { blobUrl, warning };
  } catch (error) {
    resetFFmpeg();
    logger.error(`FFmpeg processing failed for ${downloadId}:`, error);
    throw error;
  }
}

async function processFastSegmentedClip(
  payload: FastSegmentedClipPayload,
  signal: AbortSignal,
  onProgress?: (progress: number, message: string) => void,
): Promise<ProcessResult> {
  const operationId = payload.downloadId;
  validateDownloadId(operationId);
  if (
    payload.mediaFormat !== "hls-ts" &&
    payload.mediaFormat !== "hls-fmp4" &&
    payload.mediaFormat !== "dash-fmp4"
  ) {
    throw new Error(`Unsupported segmented media format: ${payload.mediaFormat}`);
  }
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  const ffmpeg = await getFFmpeg();
  if (signal.aborted) {
    resetFFmpeg();
    throw new DOMException("Aborted", "AbortError");
  }
  const outputFile = `/tmp/${operationId}_fast_clip.mp4`;
  const inputFiles: string[] = [];
  const abortHandler = () => resetFFmpeg();
  signal.addEventListener("abort", abortHandler, { once: true });

  try {
    onProgress?.(0.1, "Loading selected clip parts");
    let args: string[];
    const inputExtension = payload.mediaFormat === "hls-ts" ? "ts" : "mp4";
    if (payload.inputKind === "combined") {
      const inputFile = `${operationId}_combined_input.${inputExtension}`;
      inputFiles.push(inputFile);
      const blob = await concatenateSelectedTrack(
        operationId,
        "combined",
        payload.combinedLength ?? 0,
      );
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      await ffmpeg.writeFile(inputFile, await fetchFile(blob));
      args = buildFastSegmentedClipArgs({
        input: {
          kind: "combined",
          inputFile,
          relativeStartMs: payload.combinedRelativeStartMs ?? 0,
        },
        mediaFormat: payload.mediaFormat,
        durationMs: payload.durationMs,
        outputFile,
      });
    } else if (payload.inputKind === "separate") {
      const videoFile = `${operationId}_video_input.${inputExtension}`;
      const audioFile = `${operationId}_audio_input.${inputExtension}`;
      inputFiles.push(videoFile, audioFile);
      const [videoBlob, audioBlob] = await Promise.all([
        concatenateSelectedTrack(operationId, "video", payload.videoLength ?? 0),
        concatenateSelectedTrack(operationId, "audio", payload.audioLength ?? 0),
      ]);
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      await ffmpeg.writeFile(videoFile, await fetchFile(videoBlob));
      await ffmpeg.writeFile(audioFile, await fetchFile(audioBlob));
      args = buildFastSegmentedClipArgs({
        input: {
          kind: "separate",
          videoFile,
          audioFile,
          videoRelativeStartMs: payload.videoRelativeStartMs ?? 0,
          audioRelativeStartMs: payload.audioRelativeStartMs ?? 0,
        },
        mediaFormat: payload.mediaFormat,
        durationMs: payload.durationMs,
        outputFile,
      });
    } else {
      throw new Error(`Unsupported fast clip input kind: ${payload.inputKind}`);
    }

    onProgress?.(0.65, "Stream-copying selected clip");
    await ffmpeg.exec(args);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const data = await ffmpeg.readFile(outputFile);
    const blob = new Blob([data as BlobPart], { type: "video/mp4" });
    onProgress?.(1, "Done");
    return { blobUrl: URL.createObjectURL(blob) };
  } catch (error) {
    resetFFmpeg();
    throw error;
  } finally {
    signal.removeEventListener("abort", abortHandler);
    await cleanupFiles(ffmpeg, [...inputFiles, outputFile]);
  }
}

/**
 * Send a message to the service worker, swallowing any errors
 * (the service worker might not be listening).
 */
function sendToServiceWorker(msg: object): void {
  chrome.runtime.sendMessage(msg, () => {
    if (chrome.runtime.lastError) {
      /* intentionally swallowed */
    }
  });
}

/**
 * Wire up an async FFmpeg processing handler for a given message type.
 * Returns true if the message was handled, false otherwise.
 */
function handleProcessingMessage(
  message: { type: string; payload: Record<string, unknown> },
  sendResponse: (response: unknown) => void,
  requestType: MessageType,
  responseType: MessageType,
  processFn: (
    payload: Record<string, unknown>,
    onProgress: (progress: number, message: string) => void,
  ) => Promise<ProcessResult>,
): boolean {
  if (message.type !== requestType) return false;

  const downloadId = message.payload.downloadId as string;
  validateDownloadId(downloadId);
  const controller = new AbortController();
  mediaJobControllers.get(downloadId)?.abort();
  mediaJobControllers.set(downloadId, controller);
  sendResponse({ acknowledged: true });

  mediaJobQueue.enqueue(() =>
    runAbortableMediaJob(controller.signal, resetFFmpeg, () =>
      processFn(message.payload, (progress, msg) => {
        sendToServiceWorker({
          type: responseType,
          payload: { downloadId, type: "progress", progress, message: msg },
        });
      }),
    ),
  )
    .then(({ blobUrl, warning }) => {
      sendToServiceWorker({
        type: responseType,
        payload: { downloadId, type: "success", blobUrl, warning },
      });
    })
    .catch((error) => {
      sendToServiceWorker({
        type: responseType,
        payload: {
          downloadId,
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    })
    .finally(() => {
      if (mediaJobControllers.get(downloadId) === controller) {
        mediaJobControllers.delete(downloadId);
      }
    });

  return true;
}

/**
 * Handle messages from service worker
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === MessageType.OFFSCREEN_PROCESS_FAST_SEGMENTED_CLIP) {
    const payload = message.payload as FastSegmentedClipPayload;
    validateDownloadId(payload.downloadId);
    const controller = new AbortController();
    mediaJobControllers.get(payload.downloadId)?.abort();
    mediaJobControllers.set(payload.downloadId, controller);
    sendResponse({ acknowledged: true });

    mediaJobQueue
      .enqueue(() =>
        processFastSegmentedClip(payload, controller.signal, (progress, msg) => {
          sendToServiceWorker({
            type: MessageType.OFFSCREEN_PROCESS_FAST_SEGMENTED_CLIP_RESPONSE,
            payload: {
              downloadId: payload.downloadId,
              type: "progress",
              progress,
              message: msg,
            },
          });
        }),
      )
      .then(({ blobUrl, warning }) => {
        sendToServiceWorker({
          type: MessageType.OFFSCREEN_PROCESS_FAST_SEGMENTED_CLIP_RESPONSE,
          payload: {
            downloadId: payload.downloadId,
            type: "success",
            blobUrl,
            warning,
          },
        });
      })
      .catch((error) => {
        sendToServiceWorker({
          type: MessageType.OFFSCREEN_PROCESS_FAST_SEGMENTED_CLIP_RESPONSE,
          payload: {
            downloadId: payload.downloadId,
            type: "error",
            error: error instanceof Error ? error.message : String(error),
          },
        });
      })
      .finally(async () => {
        await deleteClipOperationChunks(payload.downloadId).catch((error) =>
          logger.warn(
            `Failed to clean clip chunks for ${payload.downloadId}:`,
            error,
          ),
        );
        if (mediaJobControllers.get(payload.downloadId) === controller) {
          mediaJobControllers.delete(payload.downloadId);
        }
      });
    return true;
  }

  if (message.type === MessageType.OFFSCREEN_PROCESS_MEDIABUNNY_CLIP) {
    const { downloadId, url, startMs, endMs, exact } = message.payload as {
      downloadId: string;
      url: string;
      startMs: number;
      endMs: number;
      exact: boolean;
      maxCacheSize?: number;
      parallelism?: number;
      maxRetries?: number;
      retryDelayMs?: number;
      retryBackoffFactor?: number;
    };
    validateDownloadId(downloadId);

    const controller = new AbortController();
    mediaJobControllers.get(downloadId)?.abort();
    mediaJobControllers.set(downloadId, controller);
    sendResponse({ acknowledged: true });

    mediaJobQueue
      .enqueue(async () => {
        const result = await processMediabunnyClip({
          input: {
            kind: "url",
            url,
            requestInit: { credentials: "include" },
            maxCacheSize: message.payload.maxCacheSize as number | undefined,
            parallelism: message.payload.parallelism as number | undefined,
            getRetryDelay: (attempt) => {
              const maxRetries = (message.payload.maxRetries as number) ?? 3;
              if (attempt >= maxRetries) return null;
              const delayMs = (message.payload.retryDelayMs as number) ?? 100;
              const factor =
                (message.payload.retryBackoffFactor as number) ?? 1.15;
              return (delayMs * factor ** attempt) / 1000;
            },
            fetchFn: (input, init) =>
              fetch(
                new Request(input, {
                  ...init,
                  credentials: "include",
                }),
              ),
          },
          startMs,
          endMs,
          exact,
          signal: controller.signal,
          onProgress: (progress, processedTimeMs) => {
            sendToServiceWorker({
              type: MessageType.OFFSCREEN_PROCESS_MEDIABUNNY_CLIP_RESPONSE,
              payload: {
                downloadId,
                type: "progress",
                progress,
                processedTimeMs,
                message: exact ? "Encoding exact clip" : "Processing clip",
              },
            });
          },
        });

        const blobUrl = URL.createObjectURL(result.blob);
        return {
          blobUrl,
          size: result.blob.size,
          accuracy: result.accuracy,
        };
      })
      .then((result) => {
        sendToServiceWorker({
          type: MessageType.OFFSCREEN_PROCESS_MEDIABUNNY_CLIP_RESPONSE,
          payload: { downloadId, type: "success", ...result },
        });
      })
      .catch((error) => {
        sendToServiceWorker({
          type: MessageType.OFFSCREEN_PROCESS_MEDIABUNNY_CLIP_RESPONSE,
          payload: {
            downloadId,
            type: "error",
            error:
              error instanceof MediabunnyCapabilityError
                ? error.message
                : error instanceof Error
                  ? error.message
                  : String(error),
            capabilityError: error instanceof MediabunnyCapabilityError,
          },
        });
      })
      .finally(() => {
        if (mediaJobControllers.get(downloadId) === controller) {
          mediaJobControllers.delete(downloadId);
        }
      });

    return true;
  }

  if (message.type === MessageType.OFFSCREEN_CANCEL_MEDIA_JOB) {
    const downloadId = message.payload?.downloadId as string;
    mediaJobControllers.get(downloadId)?.abort();
    sendResponse({ acknowledged: true });
    return false;
  }

  if (
    handleProcessingMessage(
      message,
      sendResponse,
      MessageType.OFFSCREEN_PROCESS_HLS,
      MessageType.OFFSCREEN_PROCESS_HLS_RESPONSE,
      (payload, onProgress) =>
        processHLSChunks(
          payload.downloadId as string,
          payload.videoLength as number,
          payload.audioLength as number,
          payload.audioDownloadId as string | undefined,
          onProgress,
        ),
    )
  )
    return true;

  if (
    handleProcessingMessage(
      message,
      sendResponse,
      MessageType.OFFSCREEN_PROCESS_M3U8,
      MessageType.OFFSCREEN_PROCESS_M3U8_RESPONSE,
      (payload, onProgress) =>
        processM3u8Chunks(
          payload.downloadId as string,
          payload.fragmentCount as number,
          onProgress,
        ),
    )
  )
    return true;

  if (
    handleProcessingMessage(
      message,
      sendResponse,
      MessageType.OFFSCREEN_PROCESS_DASH,
      MessageType.OFFSCREEN_PROCESS_DASH_RESPONSE,
      (payload, onProgress) =>
        processDashChunks(
          payload.downloadId as string,
          payload.videoLength as number,
          payload.audioLength as number,
          payload.audioDownloadId as string | undefined,
          onProgress,
        ),
    )
  )
    return true;

  // Pre-warm FFmpeg while segments are downloading
  if (message.type === MessageType.WARMUP_FFMPEG) {
    sendResponse({ acknowledged: true });
    getFFmpeg().catch((err) => logger.error("FFmpeg warmup failed:", err));
    return false;
  }

  // Revoke a blob URL that was created in this offscreen document context
  if (message.type === MessageType.REVOKE_BLOB_URL) {
    const { blobUrl } = message.payload;
    URL.revokeObjectURL(blobUrl);
    sendResponse({ acknowledged: true });
    return false;
  }

  // Return false for messages we don't handle
  return false;
});

logger.info("Offscreen document script loaded");
