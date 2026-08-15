import { MessageType } from "../../shared/messages";
import { createOffscreenDocument } from "../ffmpeg/offscreen-manager";
import { revokeBlobUrl } from "../utils/blob-utils";
import { CancellationError } from "../utils/errors";
import { ClippingError } from "../clipping/errors";

export interface MediabunnyOffscreenClipJob {
  operationId: string;
  url: string;
  startMs: number;
  endMs: number;
  exact: boolean;
  fullFetch?: boolean;
  maxFullFetchBytes?: number;
  maxOutputBytes?: number;
  maxCacheSize?: number;
  parallelism?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  retryBackoffFactor?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: number, processedTimeMs?: number, message?: string) => void;
}

export interface MediabunnyOffscreenClipResult {
  blobUrl: string;
  size: number;
  accuracy: "keyframe-aligned" | "exact";
  actualDurationMs?: number;
}

interface MediabunnyResponse {
  type: MessageType.OFFSCREEN_PROCESS_MEDIABUNNY_CLIP_RESPONSE;
  payload: {
    downloadId: string;
    type: "success" | "progress" | "error";
    blobUrl?: string;
    size?: number;
    accuracy?: "keyframe-aligned" | "exact";
    actualDurationMs?: number;
    progress?: number;
    processedTimeMs?: number;
    message?: string;
    error?: string;
    capabilityError?: boolean;
  };
}

export async function processMediabunnyClipOffscreen(
  job: MediabunnyOffscreenClipJob,
): Promise<MediabunnyOffscreenClipResult> {
  if (job.signal?.aborted) throw new CancellationError();
  await createOffscreenDocument();

  return new Promise<MediabunnyOffscreenClipResult>((resolve, reject) => {
    let settled = false;
    let revokeLate = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(onMessage);
      job.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      revokeLate = true;
      cleanup();
      reject(error);
    };
    const onLateMessage = (message: MediabunnyResponse) => {
      if (
        !revokeLate ||
        message.type !== MessageType.OFFSCREEN_PROCESS_MEDIABUNNY_CLIP_RESPONSE ||
        message.payload?.downloadId !== job.operationId ||
        message.payload.type === "progress"
      ) return;
      if (message.payload.type === "success" && message.payload.blobUrl) {
        revokeBlobUrl(message.payload.blobUrl);
      }
      chrome.runtime.onMessage.removeListener(onLateMessage);
    };
    const onAbort = () => {
      chrome.runtime.sendMessage({
        type: MessageType.OFFSCREEN_CANCEL_MEDIA_JOB,
        payload: { downloadId: job.operationId },
      });
      fail(new CancellationError());
    };
    const onMessage = (message: MediabunnyResponse) => {
      if (
        message.type !== MessageType.OFFSCREEN_PROCESS_MEDIABUNNY_CLIP_RESPONSE ||
        message.payload?.downloadId !== job.operationId
      ) return;
      if (settled) return;
      if (message.payload.type === "progress") {
        job.onProgress?.(
          message.payload.progress ?? 0,
          message.payload.processedTimeMs,
          message.payload.message,
        );
        return;
      }
      if (message.payload.type === "error") {
        const detail = message.payload.error || "Mediabunny clip processing failed";
        fail(message.payload.capabilityError
          ? new ClippingError("EXACT_CODEC_UNSUPPORTED", detail)
          : /in-memory limit|safety limit/i.test(detail)
            ? new ClippingError("OUTPUT_TOO_LARGE", detail)
            : new Error(detail));
        return;
      }
      if (!message.payload.blobUrl || message.payload.size === undefined || !message.payload.accuracy) {
        fail(new Error("Mediabunny returned an incomplete clip result"));
        return;
      }
      settled = true;
      cleanup();
      chrome.runtime.onMessage.removeListener(onLateMessage);
      resolve({
        blobUrl: message.payload.blobUrl,
        size: message.payload.size,
        accuracy: message.payload.accuracy,
        actualDurationMs: message.payload.actualDurationMs,
      });
    };

    chrome.runtime.onMessage.addListener(onMessage);
    chrome.runtime.onMessage.addListener(onLateMessage);
    job.signal?.addEventListener("abort", onAbort, { once: true });
    chrome.runtime.sendMessage({
      type: MessageType.OFFSCREEN_PROCESS_MEDIABUNNY_CLIP,
      payload: {
        downloadId: job.operationId,
        url: job.url,
        startMs: job.startMs,
        endMs: job.endMs,
        exact: job.exact,
        fullFetch: job.fullFetch,
        maxFullFetchBytes: job.maxFullFetchBytes,
        maxOutputBytes: job.maxOutputBytes,
        maxCacheSize: job.maxCacheSize,
        parallelism: job.parallelism,
        maxRetries: job.maxRetries,
        retryDelayMs: job.retryDelayMs,
        retryBackoffFactor: job.retryBackoffFactor,
      },
    }, () => {
      if (chrome.runtime.lastError) {
        fail(new Error(`Failed to send Mediabunny job: ${chrome.runtime.lastError.message}`));
      }
    });
    timeout = setTimeout(() => fail(new Error("Mediabunny clip processing timeout")), job.timeoutMs);
  });
}
