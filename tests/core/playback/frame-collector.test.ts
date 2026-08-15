import { describe, expect, it, vi } from 'vitest';
import { collectPlaybackCandidates } from '@/core/playback/frame-collector';
import { MessageType } from '@/shared/messages';

describe('collectPlaybackCandidates', () => {
  it('targets every discovered frame and decorates successful candidates', async () => {
    const sendMessage = vi.fn(async (_tabId: number, frameId: number) => {
      if (frameId === 2) throw new Error('No receiving end');
      return {
        candidates: [{
          pageVideoId: 'main-video',
          frameUrl: 'stale',
          currentSrc: 'blob:https://page.example/id',
          currentTimeMs: 123,
          paused: false,
        }],
      };
    });

    const result = await collectPlaybackCandidates(42, {
      getAllFrames: vi.fn().mockResolvedValue([
        { frameId: 0, url: 'https://page.example' },
        { frameId: 2, url: 'https://embed.example' },
      ]),
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(42, 0, {
      type: MessageType.GET_PLAYBACK_CANDIDATES,
    });
    expect(result).toEqual([expect.objectContaining({
      pageVideoId: 'main-video',
      frameId: 0,
      frameUrl: 'https://page.example',
    })]);
  });

  it('falls back to the top frame when frame enumeration is empty', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ candidates: [] });
    await collectPlaybackCandidates(7, {
      getAllFrames: vi.fn().mockResolvedValue(null),
      sendMessage,
    });
    expect(sendMessage).toHaveBeenCalledWith(7, 0, expect.anything());
  });
});

