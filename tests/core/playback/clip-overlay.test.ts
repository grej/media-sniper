import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClipOverlayController,
  formatOverlayTimeMs,
} from '@/core/playback/clip-overlay';
import type { PlaybackCandidate } from '@/core/playback/types';
import { MessageType } from '@/shared/messages';

function candidate(overrides: Partial<PlaybackCandidate> = {}): PlaybackCandidate {
  return {
    pageVideoId: 'page-video-1',
    frameUrl: 'https://page.example/watch',
    currentSrc: 'blob:https://page.example/media',
    currentTimeMs: 12_345,
    durationMs: 120_000,
    paused: false,
    ended: false,
    readyState: 4,
    visible: true,
    intersectionRatio: 1,
    renderedArea: 230_400,
    muted: false,
    volume: 1,
    playbackRate: 1,
    seekableRanges: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    value: null,
  });
  document.documentElement.querySelectorAll('[data-media-sniper-clip-overlay]')
    .forEach((element) => element.remove());
});

describe('ClipOverlayController', () => {
  it('formats all visible times as fixed HH:MM:SS.mmm clocks', () => {
    expect(formatOverlayTimeMs(0)).toBe('00:00:00.000');
    expect(formatOverlayTimeMs(12_345)).toBe('00:00:12.345');
    expect(formatOverlayTimeMs(3_723_004)).toBe('01:02:03.004');
  });

  it('is opt-in and removes its isolated UI when disabled', () => {
    vi.useFakeTimers();
    const controller = new ClipOverlayController({
      registry: { getCandidates: () => [candidate()] },
      sendMessage: vi.fn().mockResolvedValue({ success: true, draft: null }),
      openExtensionUi: vi.fn().mockResolvedValue(undefined),
    });
    expect(controller.element).toBeUndefined();

    controller.setEnabled(true);
    const panel = controller.element?.shadowRoot?.querySelector('.panel.visible');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('role')).toBe('region');
    expect(panel?.getAttribute('aria-label')).toBe('Media Sniper clip controls');
    expect(controller.element?.shadowRoot?.querySelector('.time')?.textContent)
      .toBe('00:00:12.345');
    controller.setEnabled(false);
    expect(controller.element).toBeUndefined();
  });

  it('loads shared draft marks and saves the current integer playback time', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(async (message: any) => {
      if (message.type === MessageType.GET_CLIP_DRAFT) {
        return {
          success: true,
          draft: {
            locator: message.payload.locator,
            startMs: 1_000,
            mode: 'exact',
            updatedAt: 1,
          },
        };
      }
      return {
        success: true,
        draft: {
          locator: message.payload.locator,
          startMs: 1_000,
          endMs: message.payload.timeMs,
          mode: 'exact',
          updatedAt: 2,
        },
      };
    });
    const controller = new ClipOverlayController({
      registry: { getCandidates: () => [candidate()] },
      sendMessage,
      openExtensionUi: vi.fn().mockResolvedValue(undefined),
    });
    controller.setEnabled(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.element?.shadowRoot?.querySelector('.start-value')?.textContent)
      .toBe('00:00:01.000');

    controller.element?.shadowRoot
      ?.querySelector<HTMLButtonElement>('[data-mark="end"]')?.click();
    await Promise.resolve();
    await Promise.resolve();

    const setMessage = sendMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === MessageType.SET_CLIP_MARK);
    expect(setMessage).toEqual({
      type: MessageType.SET_CLIP_MARK,
      payload: {
        locator: {
          tabId: 0,
          frameId: -1,
          pageVideoId: 'page-video-1',
          sourceKey: 'blob:https://page.example/media',
        },
        mark: 'end',
        timeMs: 12_345,
        mode: 'exact',
        quality: undefined,
      },
    });
    expect(controller.element?.shadowRoot?.querySelector('.end-value')?.textContent)
      .toBe('00:00:12.345');
    controller.destroy();
  });

  it('opens extension UI from the overlay action', async () => {
    vi.useFakeTimers();
    const openExtensionUi = vi.fn().mockResolvedValue(undefined);
    const controller = new ClipOverlayController({
      registry: { getCandidates: () => [candidate()] },
      sendMessage: vi.fn().mockResolvedValue({ success: true, draft: null }),
      openExtensionUi,
    });
    controller.setEnabled(true);
    controller.element?.shadowRoot?.querySelector<HTMLButtonElement>('.open')?.click();
    await Promise.resolve();
    expect(openExtensionUi).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it('anchors beside the selected video and hides while fullscreen is active', () => {
    vi.useFakeTimers();
    const video = document.createElement('video');
    video.getBoundingClientRect = () => ({
      left: 100, top: 100, right: 740, bottom: 460, width: 640, height: 360,
    } as DOMRect);
    document.body.append(video);
    const controller = new ClipOverlayController({
      registry: {
        getCandidates: () => [candidate()],
        getElement: () => video,
      },
      sendMessage: vi.fn().mockResolvedValue({ success: true, draft: null }),
      openExtensionUi: vi.fn().mockResolvedValue(undefined),
    });
    controller.setEnabled(true);
    expect(controller.element?.style.left).toBe('480px');
    expect(controller.element?.style.top).toBe('468px');

    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: video,
    });
    vi.advanceTimersByTime(500);
    expect(controller.element?.shadowRoot?.querySelector('.panel.visible')).toBeNull();
    controller.destroy();
  });

  it('filters known ineligible media and requires an explicit ambiguous-player choice', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockResolvedValue({ success: true, draft: null });
    const ineligible = new ClipOverlayController({
      registry: { getCandidates: () => [candidate()] },
      isCandidateEligible: () => false,
      sendMessage,
      openExtensionUi: vi.fn().mockResolvedValue(undefined),
    });
    ineligible.setEnabled(true);
    expect(ineligible.element?.shadowRoot?.querySelector('.panel.visible')).toBeNull();
    ineligible.destroy();

    const ambiguous = new ClipOverlayController({
      registry: {
        getCandidates: () => [
          candidate({ pageVideoId: 'video-a' }),
          candidate({ pageVideoId: 'video-b' }),
        ],
      },
      sendMessage,
      openExtensionUi: vi.fn().mockResolvedValue(undefined),
    });
    ambiguous.setEnabled(true);
    const shadow = ambiguous.element!.shadowRoot!;
    const select = shadow.querySelector<HTMLSelectElement>('.player-select')!;
    const start = shadow.querySelector<HTMLButtonElement>('[data-mark="start"]')!;
    expect(select.value).toBe('');
    expect(start.disabled).toBe(true);
    expect(shadow.querySelector('.status')?.textContent).toContain('Choose a player');

    select.value = 'video-b';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    expect(start.disabled).toBe(false);
    start.click();
    await Promise.resolve();
    expect(sendMessage.mock.calls.some(([message]) =>
      message.type === MessageType.SET_CLIP_MARK
      && message.payload.locator.pageVideoId === 'video-b')).toBe(true);
    ambiguous.destroy();
  });

  it('stops polling playback and removes controls on destroy', () => {
    vi.useFakeTimers();
    const getCandidates = vi.fn(() => [candidate()]);
    const controller = new ClipOverlayController({
      registry: { getCandidates },
      sendMessage: vi.fn().mockResolvedValue({ success: true, draft: null }),
      openExtensionUi: vi.fn().mockResolvedValue(undefined),
      refreshIntervalMs: 250,
    });
    controller.setEnabled(true);
    expect(getCandidates).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(getCandidates).toHaveBeenCalledTimes(3);

    controller.destroy();
    vi.advanceTimersByTime(1_000);
    expect(getCandidates).toHaveBeenCalledTimes(3);
    expect(document.querySelector('[data-media-sniper-clip-overlay]')).toBeNull();
  });
});
