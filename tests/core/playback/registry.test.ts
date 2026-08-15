import { beforeEach, describe, expect, it } from 'vitest';
import { PlaybackRegistry } from '@/core/playback/registry';

function rect(width: number, height: number, left = 0, top = 0): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function createVideo(overrides: Partial<{
  currentSrc: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  readyState: number;
}> = {}): HTMLVideoElement {
  const video = document.createElement('video');
  const values = {
    currentSrc: 'https://media.example/video.mp4',
    currentTime: 12.3456,
    duration: 100.25,
    paused: false,
    ended: false,
    readyState: 4,
    ...overrides,
  };
  Object.defineProperties(video, Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, { configurable: true, value }]),
  ));
  Object.defineProperty(video, 'seekable', {
    configurable: true,
    value: {
      length: 2,
      start: (index: number) => index === 0 ? 0 : 20.5,
      end: (index: number) => index === 0 ? 10.25 : 99.9996,
    },
  });
  video.getBoundingClientRect = () => rect(640, 360);
  return video;
}

describe('PlaybackRegistry', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('serializes playback state using integer milliseconds', () => {
    const video = createVideo();
    document.body.append(video);
    const registry = new PlaybackRegistry({ createId: () => 'video-1' });

    registry.start();

    expect(registry.getCandidates('https://page.example/watch')).toEqual([expect.objectContaining({
      pageVideoId: 'video-1',
      frameUrl: 'https://page.example/watch',
      currentSrc: 'https://media.example/video.mp4',
      currentTimeMs: 12_346,
      durationMs: 100_250,
      paused: false,
      visible: true,
      renderedArea: 230_400,
      seekableRanges: [
        { startMs: 0, endMs: 10_250 },
        { startMs: 20_500, endMs: 100_000 },
      ],
    })]);
    registry.destroy();
  });

  it('prunes detached elements and reuses their stable ID after reinsertion', () => {
    const video = createVideo();
    document.body.append(video);
    let nextId = 0;
    const registry = new PlaybackRegistry({ createId: () => `video-${++nextId}` });
    registry.start();
    expect(registry.getElement('video-1')).toBe(video);
    expect(registry.getCandidates()[0].pageVideoId).toBe('video-1');

    video.remove();
    registry.prune();
    expect(registry.getElement('video-1')).toBeUndefined();
    expect(registry.getCandidates()).toEqual([]);

    document.body.append(video);
    registry.scan();
    expect(registry.getCandidates()[0].pageVideoId).toBe('video-1');
    registry.destroy();
  });

  it('associates exact sources and only uses active fallback when unambiguous', () => {
    const first = createVideo({ currentSrc: 'blob:https://page.example/first' });
    const second = createVideo({ currentSrc: 'https://cdn.example/second.mp4', paused: true });
    document.body.append(first, second);
    let nextId = 0;
    const registry = new PlaybackRegistry({ createId: () => `video-${++nextId}` });
    registry.start();

    expect(registry.findPageVideoId('https://cdn.example/second.mp4#fragment')).toBe('video-2');
    expect(registry.findPageVideoId('https://cdn.example/master.m3u8')).toBe('video-1');

    Object.defineProperty(second, 'paused', { configurable: true, value: false });
    expect(registry.findPageVideoId('https://cdn.example/master.m3u8')).toBeUndefined();
    registry.destroy();
  });
});
