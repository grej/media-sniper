import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageType } from "../../../src/shared/messages";

vi.mock("../../../src/core/ffmpeg/offscreen-manager", () => ({
  createOffscreenDocument: vi.fn().mockResolvedValue(undefined),
}));

import { processMediabunnyClipOffscreen } from "../../../src/core/media/mediabunny-clip-bridge";

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function emit(payload: Record<string, unknown>) {
  for (const listener of [...listeners]) listener({
    type: MessageType.OFFSCREEN_PROCESS_MEDIABUNNY_CLIP_RESPONSE,
    payload: { downloadId: "op-1", ...payload },
  });
}

describe("Mediabunny offscreen bridge", () => {
  it("correlates progress and returns a binary-free result", async () => {
    const progress = vi.fn();
    const promise = processMediabunnyClipOffscreen({
      operationId: "op-1",
      url: "https://cdn.test/video.mp4",
      startMs: 1_000,
      endMs: 2_000,
      exact: true,
      timeoutMs: 10_000,
      onProgress: progress,
    });
    await Promise.resolve();
    emit({ type: "progress", progress: 0.4, processedTimeMs: 1_400, message: "Encoding" });
    emit({ type: "success", blobUrl: "blob:result", size: 123, accuracy: "exact", actualDurationMs: 1_025 });

    await expect(promise).resolves.toEqual({
      blobUrl: "blob:result",
      size: 123,
      accuracy: "exact",
      actualDurationMs: 1_025,
    });
    expect(progress).toHaveBeenCalledWith(0.4, 1_400, "Encoding");
    const request = sent.find((message) => message.type === MessageType.OFFSCREEN_PROCESS_MEDIABUNNY_CLIP);
    expect(request.payload).not.toHaveProperty("blob");
    expect(request.payload).not.toHaveProperty("bytes");
  });

  it("cancels the matching offscreen job and revokes a late Blob URL", async () => {
    const controller = new AbortController();
    const promise = processMediabunnyClipOffscreen({
      operationId: "op-1",
      url: "https://cdn.test/video.mp4",
      startMs: 1_000,
      endMs: 2_000,
      exact: false,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await expect(promise).rejects.toThrow(/cancel/i);
    expect(sent).toContainEqual({
      type: MessageType.OFFSCREEN_CANCEL_MEDIA_JOB,
      payload: { downloadId: "op-1" },
    });

    emit({ type: "success", blobUrl: "blob:late", size: 10, accuracy: "keyframe-aligned" });
    expect(sent).toContainEqual({
      type: MessageType.REVOKE_BLOB_URL,
      payload: { blobUrl: "blob:late" },
    });
  });

  it("times out deterministically", async () => {
    vi.useFakeTimers();
    const promise = processMediabunnyClipOffscreen({
      operationId: "op-1",
      url: "https://cdn.test/video.mp4",
      startMs: 1_000,
      endMs: 2_000,
      exact: false,
      timeoutMs: 50,
    });
    await Promise.resolve();
    const rejection = expect(promise).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });
});
