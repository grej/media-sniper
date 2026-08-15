import { afterEach, describe, expect, it, vi } from "vitest";
import { createClipEditor, formatEditorTime } from "../../src/popup/clip-editor";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("clip editor", () => {
  it("defaults to an unambiguous clock with a three-digit millisecond field", () => {
    expect(formatEditorTime(12_345)).toBe("00:00:12.345");
    expect(formatEditorTime(3_723_005)).toBe("01:02:03.005");
    expect(formatEditorTime(12_345, "seconds")).toBe("12.345");
  });

  it("honors the configured mode for a fresh draft while an existing draft wins", () => {
    const fresh = createClipEditor({
      sourceKey: "fresh",
      defaultMode: "exact",
      onSubmit: vi.fn(),
    });
    document.body.append(fresh.element);
    expect(fresh.element.querySelector<HTMLSelectElement>(".clip-mode-select")?.value)
      .toBe("exact");

    const restored = createClipEditor({
      sourceKey: "restored",
      defaultMode: "exact",
      draft: { startMs: 1_000, endMs: 2_000, mode: "fast" },
      onSubmit: vi.fn(),
    });
    document.body.append(restored.element);
    expect(restored.element.querySelector<HTMLSelectElement>(".clip-mode-select")?.value)
      .toBe("fast");
    fresh.destroy();
    restored.destroy();
  });

  it("checks Exact capability lazily and disables it with a specific reason", async () => {
    let resolveCapability!: (value: { supported: boolean; reason?: string }) => void;
    const controller = createClipEditor({
      sourceKey: "capability",
      checkExactCapability: () => new Promise((resolve) => { resolveCapability = resolve; }),
      onSubmit: vi.fn(),
    });
    document.body.append(controller.element);
    const exact = controller.element.querySelector<HTMLOptionElement>('option[value="exact"]')!;
    const message = controller.element.querySelector<HTMLElement>(".clip-capability")!;
    expect(exact.disabled).toBe(true);
    expect(message.textContent).toBe("Checking exact mode support…");

    resolveCapability({
      supported: false,
      reason: "This browser cannot encode source video to MP4.",
    });
    await Promise.resolve();
    expect(exact.disabled).toBe(true);
    expect(message.textContent).toBe("This browser cannot encode source video to MP4.");
    controller.destroy();
  });

  it("provides precise nudge controls, clamps them, and resets fresh defaults", () => {
    const controller = createClipEditor({
      sourceKey: "nudges",
      durationMs: 1_000,
      defaultMode: "exact",
      draft: { startMs: 100, endMs: 950, mode: "fast" },
      onSubmit: vi.fn(),
    });
    document.body.append(controller.element);

    const nudges = [...controller.element.querySelectorAll<HTMLButtonElement>(".clip-nudge-btn")];
    expect(nudges.map((control) => control.textContent)).toEqual([
      "-10s",
      "-1s",
      "-0.1s",
      "+0.1s",
      "+1s",
      "+10s",
    ]);

    const [start, end] = controller.element.querySelectorAll<HTMLInputElement>(".clip-time-input");
    start!.focus();
    nudges.find((control) => control.textContent === "-0.1s")!.click();
    expect(start!.value).toBe("00:00:00.000");
    end!.focus();
    nudges.find((control) => control.textContent === "+0.1s")!.click();
    expect(end!.value).toBe("00:00:01.000");

    controller.element.querySelector<HTMLButtonElement>(".clip-reset-btn")!.click();
    expect([start!.value, end!.value]).toEqual([
      "00:00:00.000",
      "00:00:01.000",
    ]);
    expect(controller.element.querySelector<HTMLSelectElement>(".clip-mode-select")?.value)
      .toBe("exact");
    controller.destroy();
  });

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
      allowFullFetchForDirect: undefined,
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
    expect(controller.element.querySelector<HTMLInputElement>(".clip-time-input")!.value).toBe("00:00:12.345");

    await vi.advanceTimersByTimeAsync(249);
    expect(getPlayback).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getPlayback).toHaveBeenCalledTimes(2);

    controller.element.querySelector<HTMLButtonElement>('[data-mark="end"]')!.click();
    controller.element.querySelector<HTMLButtonElement>(".clip-submit-btn")!.click();
    await Promise.resolve();
    expect(onSubmit.mock.calls[0]?.[0].clip.markSource).toBe("playback");
    controller.destroy();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getPlayback).toHaveBeenCalledTimes(2);
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

  it("toggles between clock and decimal-seconds display without changing the range", () => {
    const controller = createClipEditor({
      sourceKey: "source",
      draft: { startMs: 62_125, endMs: 65_500, mode: "fast" },
      onSubmit: vi.fn(),
    });
    document.body.append(controller.element);
    expect(controller.element.querySelector<HTMLOutputElement>(".clip-duration")?.textContent)
      .toBe("00:00:03.375");
    const display = controller.element.querySelector<HTMLSelectElement>(".clip-time-display-select")!;
    display.value = "seconds";
    display.dispatchEvent(new Event("change", { bubbles: true }));
    expect([...controller.element.querySelectorAll<HTMLInputElement>(".clip-time-input")]
      .map((input) => input.value)).toEqual(["62.125", "65.500"]);
    expect(controller.element.querySelector<HTMLOutputElement>(".clip-duration")?.textContent)
      .toBe("3.375");
    display.value = "clock";
    display.dispatchEvent(new Event("change", { bubbles: true }));
    expect([...controller.element.querySelectorAll<HTMLInputElement>(".clip-time-input")]
      .map((input) => input.value)).toEqual(["00:01:02.125", "00:01:05.500"]);
    controller.destroy();
  });

  it("requires an explicit player choice before playback marks", async () => {
    const getPlayback = vi.fn(async (preferred?: string) => ({
      pageVideoId: preferred ?? "video-a",
      currentTimeMs: preferred === "video-b" ? 22_000 : 11_000,
      durationMs: 120_000,
      label: preferred ? "Chosen player" : "Choose a player",
      requiresSelection: !preferred,
      alternatives: [
        { pageVideoId: "video-a", label: "Player A" },
        { pageVideoId: "video-b", label: "Player B" },
      ],
    }));
    const controller = createClipEditor({
      sourceKey: "ambiguous",
      getPlayback,
      onSubmit: vi.fn(),
    });
    document.body.append(controller.element);
    await Promise.resolve();
    await Promise.resolve();

    const player = controller.element.querySelector<HTMLSelectElement>(".clip-player-select")!;
    const start = controller.element.querySelector<HTMLButtonElement>('[data-mark="start"]')!;
    expect(player.value).toBe("");
    expect(start.disabled).toBe(true);
    expect(controller.element.querySelector(".clip-current-time")?.getAttribute("aria-live"))
      .toBe("off");

    player.value = "video-b";
    player.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(getPlayback).toHaveBeenLastCalledWith("video-b");
    expect(start.disabled).toBe(false);
    start.click();
    expect(controller.element.querySelector<HTMLInputElement>(".clip-time-input")?.value)
      .toBe("00:00:22.000");
    controller.destroy();
  });

  it("ignores a pending playback response after destruction", async () => {
    let resolvePlayback!: (value: { currentTimeMs: number; label: string }) => void;
    const getPlayback = vi.fn(() => new Promise<{ currentTimeMs: number; label: string }>((resolve) => {
      resolvePlayback = resolve;
    }));
    const controller = createClipEditor({
      sourceKey: "pending",
      getPlayback,
      onSubmit: vi.fn(),
    });
    document.body.append(controller.element);
    controller.destroy();
    resolvePlayback({ currentTimeMs: 42_000, label: "Late player" });
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.element.querySelector(".clip-current-time")?.textContent)
      .toBe("Finding player…");
  });

  it("emits explicit direct full-fetch consent only when checked", async () => {
    const onSubmit = vi.fn();
    const controller = createClipEditor({
      sourceKey: "direct",
      showDirectFullFetchConsent: true,
      onSubmit,
    });
    document.body.append(controller.element);
    controller.element.querySelector<HTMLInputElement>(".clip-full-fetch-consent input")!.checked = true;
    controller.element.querySelector<HTMLButtonElement>(".clip-submit-btn")!.click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ allowFullFetchForDirect: true }));
    controller.destroy();
  });
});
