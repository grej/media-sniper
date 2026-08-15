import { afterEach, describe, expect, it, vi } from "vitest";
import { createClipEditor } from "../../src/popup/clip-editor";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("clip editor", () => {
  it("submits a normalized typed manual clip request", async () => {
    const onSubmit = vi.fn();
    const controller = createClipEditor({ sourceKey: "source", onSubmit });
    document.body.append(controller.element);

    const [start, end] = controller.element.querySelectorAll<HTMLInputElement>(".clip-time-input");
    start!.value = "62.125";
    start!.dispatchEvent(new Event("input", { bubbles: true }));
    end!.value = "1:05.500";
    end!.dispatchEvent(new Event("input", { bubbles: true }));
    controller.element.querySelector<HTMLButtonElement>(".clip-submit-btn")!.click();
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith({
      clip: { startMs: 62_125, endMs: 65_500, mode: "fast", markSource: "manual" },
      qualityKey: undefined,
      manifestQuality: undefined,
    });
    controller.destroy();
  });

  it("marks the start and end from playback and polls no faster than 4Hz", async () => {
    vi.useFakeTimers();
    const getPlayback = vi.fn()
      .mockResolvedValueOnce({ currentTimeMs: 12_345, durationMs: 120_000, label: "Main player" })
      .mockResolvedValue({ currentTimeMs: 22_345, durationMs: 120_000, label: "Main player" });
    const onSubmit = vi.fn();
    const controller = createClipEditor({ sourceKey: "source", getPlayback, onSubmit });
    document.body.append(controller.element);
    await Promise.resolve();
    await Promise.resolve();

    expect(getPlayback).toHaveBeenCalledTimes(1);
    controller.element.querySelector<HTMLButtonElement>('[data-mark="start"]')!.click();
    expect(controller.element.querySelector<HTMLInputElement>(".clip-time-input")!.value).toBe("00:12.345");

    await vi.advanceTimersByTimeAsync(249);
    expect(getPlayback).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getPlayback).toHaveBeenCalledTimes(2);

    controller.element.querySelector<HTMLButtonElement>('[data-mark="end"]')!.click();
    controller.element.querySelector<HTMLButtonElement>(".clip-submit-btn")!.click();
    await Promise.resolve();
    expect(onSubmit.mock.calls[0]?.[0].clip.markSource).toBe("playback");
    controller.destroy();
  });

  it("shows accessible errors and blocks invalid ranges", () => {
    const onSubmit = vi.fn();
    const controller = createClipEditor({ sourceKey: "source", onSubmit });
    document.body.append(controller.element);
    const [start, end] = controller.element.querySelectorAll<HTMLInputElement>(".clip-time-input");
    start!.value = "10";
    start!.dispatchEvent(new Event("input", { bubbles: true }));
    end!.value = "9";
    end!.dispatchEvent(new Event("input", { bubbles: true }));

    const error = controller.element.querySelector<HTMLElement>(".clip-error")!;
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent?.toLowerCase()).toContain("end time");
    expect(controller.element.querySelector<HTMLButtonElement>(".clip-submit-btn")!.disabled).toBe(true);
    controller.destroy();
  });

  it("persists marks, mode, and quality changes", async () => {
    const persistDraft = vi.fn();
    const controller = createClipEditor({
      sourceKey: "source",
      draft: { startMs: 1_000, endMs: 9_000, mode: "exact", qualityKey: "720p" },
      qualities: [
        { key: "1080p", label: "1080p" },
        { key: "720p", label: "720p" },
      ],
      persistDraft,
      onSubmit: vi.fn(),
    });
    document.body.append(controller.element);
    const mode = controller.element.querySelector<HTMLSelectElement>(".clip-mode-select")!;
    const quality = controller.element.querySelector<HTMLSelectElement>(".clip-quality-select")!;
    expect(mode.value).toBe("exact");
    expect(quality.value).toBe("720p");

    mode.value = "fast";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    expect(persistDraft).toHaveBeenCalledWith(expect.objectContaining({ mode: "fast", qualityKey: "720p" }));
    controller.destroy();
  });
});
