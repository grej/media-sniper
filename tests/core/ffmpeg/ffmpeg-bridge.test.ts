import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageType } from "@/shared/messages";

vi.mock("@/core/ffmpeg/offscreen-manager", () => ({
  createOffscreenDocument: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/core/utils/blob-utils", () => ({ revokeBlobUrl: vi.fn() }));

import { processWithFFmpeg } from "@/core/ffmpeg/ffmpeg-bridge";

describe("processWithFFmpeg cancellation", () => {
  const listeners = new Set<(message: unknown) => void>();
  const sendMessage = vi.fn((_message: unknown, callback?: () => void) => callback?.());

  beforeEach(() => {
    listeners.clear();
    sendMessage.mockClear();
    vi.stubGlobal("chrome", {
      runtime: {
        lastError: undefined,
        onMessage: {
          addListener: (listener: (message: unknown) => void) => listeners.add(listener),
          removeListener: (listener: (message: unknown) => void) => listeners.delete(listener),
        },
        sendMessage,
      },
    });
  });

  it("forwards abort to the offscreen media job", async () => {
    const controller = new AbortController();
    const result = processWithFFmpeg({
      requestType: MessageType.OFFSCREEN_PROCESS_FAST_SEGMENTED_CLIP,
      responseType: MessageType.OFFSCREEN_PROCESS_FAST_SEGMENTED_CLIP_RESPONSE,
      downloadId: "clip_cancel",
      payload: { inputKind: "combined" },
      filename: "clip",
      timeout: 5_000,
      abortSignal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "CancellationError" });
    expect(sendMessage).toHaveBeenCalledWith(
      {
        type: MessageType.OFFSCREEN_CANCEL_MEDIA_JOB,
        payload: { downloadId: "clip_cancel" },
      },
      expect.any(Function),
    );
  });
});
