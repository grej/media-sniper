import {
  MessageType,
  type ExactSegmentedClipPayload,
  type ExactSegmentedClipResponsePayload,
} from "../../shared/messages";
import { createOffscreenDocument } from "../ffmpeg/offscreen-manager";
import { revokeBlobUrl } from "../utils/blob-utils";
import { CancellationError } from "../utils/errors";
import { ClippingError } from "../clipping/errors";

export interface SegmentedExactOffscreenJob {
  operationId: string;
  payload: Omit<ExactSegmentedClipPayload, "downloadId">;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (
    progress: number,
    processedTimeMs?: number,
    message?: string,
  ) => void;
}
export interface SegmentedExactOffscreenResult {
  blobUrl: string;
  size: number;
  accuracy: "exact";
  actualDurationMs?: number;
}

interface ExactResponse {
  type: MessageType.OFFSCREEN_PROCESS_EXACT_SEGMENTED_CLIP_RESPONSE;
  payload: ExactSegmentedClipResponsePayload;
}

export async function processSegmentedExactClipOffscreen(
  job: SegmentedExactOffscreenJob,
): Promise<SegmentedExactOffscreenResult> {
  if (job.signal?.aborted) throw new CancellationError();
  await createOffscreenDocument();

  return new Promise<SegmentedExactOffscreenResult>((resolve, reject) => {
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
    const cancelOffscreen = () =>
      chrome.runtime.sendMessage({
        type: MessageType.OFFSCREEN_CANCEL_MEDIA_JOB,
        payload: { downloadId: job.operationId },
      });
    const onAbort = () => {
      cancelOffscreen();
      fail(new CancellationError());
    };
    const onLateMessage = (message: ExactResponse) => {
      if (
        !revokeLate ||
        message.type !== MessageType.OFFSCREEN_PROCESS_EXACT_SEGMENTED_CLIP_RESPONSE ||
        message.payload?.downloadId !== job.operationId ||
        message.payload.type === "progress"
      ) return;
      if (message.payload.type === "success" && message.payload.blobUrl) {
        revokeBlobUrl(message.payload.blobUrl);
      }
      chrome.runtime.onMessage.removeListener(onLateMessage);
    };
    const onMessage = (message: ExactResponse) => {
      if (
        message.type !== MessageType.OFFSCREEN_PROCESS_EXACT_SEGMENTED_CLIP_RESPONSE ||
        message.payload?.downloadId !== job.operationId ||
        settled
      ) return;
      if (message.payload.type === "progress") {
        job.onProgress?.(
          message.payload.progress ?? 0,
          message.payload.processedTimeMs,
          message.payload.message,
        );
        return;
      }
      if (message.payload.type === "error") {
        const detail = message.payload.error || "Exact segmented processing failed";
        fail(
          message.payload.capabilityError
            ? new ClippingError("EXACT_CODEC_UNSUPPORTED", detail)
            : /in-memory limit|output exceeds/i.test(detail)
              ? new ClippingError("OUTPUT_TOO_LARGE", detail)
              : new ClippingError("MEDIA_PROCESSING_FAILED", detail),
        );
        return;
      }
      if (
        !message.payload.blobUrl ||
        message.payload.size === undefined ||
        message.payload.accuracy !== "exact"
      ) {
        fail(new ClippingError("MEDIA_PROCESSING_FAILED", "Incomplete Exact segmented result"));
        return;
      }
      settled = true;
      cleanup();
      chrome.runtime.onMessage.removeListener(onLateMessage);
      resolve({
        blobUrl: message.payload.blobUrl,
        size: message.payload.size,
        accuracy: "exact",
        actualDurationMs: message.payload.actualDurationMs,
      });
    };

    chrome.runtime.onMessage.addListener(onMessage);
    chrome.runtime.onMessage.addListener(onLateMessage);
    job.signal?.addEventListener("abort", onAbort, { once: true });
    chrome.runtime.sendMessage(
      {
        type: MessageType.OFFSCREEN_PROCESS_EXACT_SEGMENTED_CLIP,
        payload: { downloadId: job.operationId, ...job.payload },
      },
      () => {
        if (chrome.runtime.lastError) {
          fail(new Error(`Failed to send Exact segmented job: ${chrome.runtime.lastError.message}`));
        }
      },
    );
    timeout = setTimeout(() => {
      cancelOffscreen();
      fail(new Error("Exact segmented processing timeout"));
    }, job.timeoutMs);
  });
}
