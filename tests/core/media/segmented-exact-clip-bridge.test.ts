import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageType } from "../../../src/shared/messages";

vi.mock("../../../src/core/ffmpeg/offscreen-manager", () => ({
  createOffscreenDocument: vi.fn().mockResolvedValue(undefined),
}));

import { processSegmentedExactClipOffscreen } from "../../../src/core/media/segmented-exact-clip-bridge";

type Listener = (message: any) => void;
let listeners: Set<Listener>;
let sent: any[];

beforeEach(() => {
  listeners = new Set();
  sent = [];
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: undefined,
      onMessage: {
        addListener: (listener: Listener) => listeners.add(listener),
        removeListener: (listener: Listener) => listeners.delete(listener),
      },
      sendMessage: (message: any, callback?: () => void) => {
        sent.push(message);
        callback?.();
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function emit(payload: Record<string, unknown>) {
  for (const listener of [...listeners]) listener({
    type: MessageType.OFFSCREEN_PROCESS_EXACT_SEGMENTED_CLIP_RESPONSE,
    payload: { downloadId: "op-exact", ...payload },
  });
}

const payload = {
  mediaFormat: "dash-fmp4" as const,
  inputKind: "separate" as const,
  durationMs: 3_000,
  maxOutputBytes: 20_000_000,
  videoLength: 3,
  audioLength: 4,
  videoRelativeStartMs: 4_500,
  audioRelativeStartMs: 4_500,
};

describe("Exact segmented offscreen bridge", () => {
  it("sends only chunk metadata, correlates progress, and returns measured duration", async () => {
    const progress = vi.fn();
    const promise = processSegmentedExactClipOffscreen({
      operationId: "op-exact",
      payload,
      timeoutMs: 10_000,
      onProgress: progress,
    });
    await Promise.resolve();

    emit({ type: "progress", progress: 0.5, processedTimeMs: 1_500, message: "Encoding exact clip" });
    emit({ type: "success", blobUrl: "blob:exact", size: 456, accuracy: "exact", actualDurationMs: 3_018 });

    await expect(promise).resolves.toEqual({
      blobUrl: "blob:exact",
      size: 456,
      accuracy: "exact",
      actualDurationMs: 3_018,
    });
    expect(progress).toHaveBeenCalledWith(0.5, 1_500, "Encoding exact clip");

    const request = sent.find(
      (message) => message.type === MessageType.OFFSCREEN_PROCESS_EXACT_SEGMENTED_CLIP,
    );
    expect(request.payload).toMatchObject({ downloadId: "op-exact", ...payload });
    expect(request.payload).not.toHaveProperty("blob");
    expect(request.payload).not.toHaveProperty("bytes");
    expect(request.payload).not.toHaveProperty("videoBytes");
    expect(request.payload).not.toHaveProperty("audioBytes");
  });

  it("maps stable capability and memory errors to clipping errors", async () => {
    const capability = processSegmentedExactClipOffscreen({
      operationId: "op-exact",
      payload,
      timeoutMs: 10_000,
    });
    await Promise.resolve();
    emit({ type: "error", error: "VP9 cannot be decoded", capabilityError: true });
    await expect(capability).rejects.toMatchObject({ code: "EXACT_CODEC_UNSUPPORTED" });

    const memory = processSegmentedExactClipOffscreen({
      operationId: "op-exact",
      payload,
      timeoutMs: 10_000,
    });
    await Promise.resolve();
    emit({ type: "error", error: "Selected input exceeds the in-memory limit" });
    await expect(memory).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE" });
  });

  it("cancels the matching job and revokes a late Blob URL", async () => {
    const controller = new AbortController();
    const promise = processSegmentedExactClipOffscreen({
      operationId: "op-exact",
      payload,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await expect(promise).rejects.toThrow(/cancel/i);
    expect(sent).toContainEqual({
      type: MessageType.OFFSCREEN_CANCEL_MEDIA_JOB,
      payload: { downloadId: "op-exact" },
    });

    emit({ type: "success", blobUrl: "blob:late", size: 10, accuracy: "exact" });
    expect(sent).toContainEqual({
      type: MessageType.REVOKE_BLOB_URL,
      payload: { blobUrl: "blob:late" },
    });
  });
});
