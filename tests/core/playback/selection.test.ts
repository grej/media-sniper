import { describe, expect, it } from 'vitest';
import { selectPlaybackCandidate } from '@/core/playback/selection';
import type { PlaybackCandidate } from '@/core/playback/types';

function candidate(
  pageVideoId: string,
  overrides: Partial<PlaybackCandidate> = {},
): PlaybackCandidate {
  return {
    pageVideoId,
    frameId: 0,
    frameUrl: 'https://page.example',
    currentSrc: `blob:https://page.example/${pageVideoId}`,
    currentTimeMs: 1_000,
    paused: true,
    ended: false,
    readyState: 4,
    visible: true,
    intersectionRatio: 1,
    renderedArea: 100_000,
    muted: false,
    volume: 1,
    playbackRate: 1,
    seekableRanges: [],
    ...overrides,
  };
}

describe('selectPlaybackCandidate', () => {
  it('prefers an exact page-video ID over playback heuristics', () => {
    const exact = candidate('exact', { paused: true, visible: false, renderedArea: 0 });
    const playing = candidate('playing', { paused: false });

    expect(selectPlaybackCandidate([playing, exact], { pageVideoId: 'exact' }))
      .toMatchObject({ candidate: exact, ambiguous: false, reason: 'page-video-id' });
  });

  it('prefers an exact source URL while ignoring its fragment', () => {
    const exact = candidate('exact', { currentSrc: 'https://cdn.example/v.mp4#t=5' });
    const other = candidate('other', { paused: false });

    expect(selectPlaybackCandidate([other, exact], { sourceUrl: 'https://cdn.example/v.mp4' }))
      .toMatchObject({ candidate: exact, ambiguous: false, reason: 'source-url' });
  });

  it('handles MSE blob URLs by preferring the active visible element', () => {
    const paused = candidate('paused', { renderedArea: 500_000 });
    const playing = candidate('playing', { paused: false, renderedArea: 50_000 });

    expect(selectPlaybackCandidate(
      [paused, playing],
      { sourceUrl: 'https://cdn.example/master.m3u8' },
    )).toMatchObject({ candidate: playing, ambiguous: false, reason: 'playback-state' });
  });

  it('reports similarly plausible videos as ambiguous with stable ordering', () => {
    const second = candidate('b', { intersectionRatio: 0.95, renderedArea: 95_000 });
    const first = candidate('a');
    const result = selectPlaybackCandidate([second, first]);

    expect(result.candidate?.pageVideoId).toBe('a');
    expect(result.alternatives.map(({ pageVideoId }) => pageVideoId)).toEqual(['a', 'b']);
    expect(result.ambiguous).toBe(true);
  });
});

