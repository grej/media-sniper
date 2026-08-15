import { MessageType } from '../../shared/messages';
import type { PlaybackCandidate } from './types';

export interface FrameDescriptor {
  frameId: number;
  url: string;
}

export interface PlaybackFrameApi {
  getAllFrames(tabId: number): Promise<FrameDescriptor[] | null>;
  sendMessage(tabId: number, frameId: number, message: unknown): Promise<unknown>;
}

function isPlaybackCandidate(value: unknown): value is PlaybackCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PlaybackCandidate>;
  return typeof candidate.pageVideoId === 'string'
    && typeof candidate.frameUrl === 'string'
    && typeof candidate.currentTimeMs === 'number'
    && typeof candidate.paused === 'boolean';
}

/** Fan out to every frame, tolerating frames without a content script. */
export async function collectPlaybackCandidates(
  tabId: number,
  api: PlaybackFrameApi,
): Promise<PlaybackCandidate[]> {
  const discoveredFrames = await api.getAllFrames(tabId);
  const frames = discoveredFrames?.length
    ? discoveredFrames
    : [{ frameId: 0, url: '' }];
  const frameResults = await Promise.allSettled(frames.map(async (frame) => {
    const response = await api.sendMessage(tabId, frame.frameId, {
      type: MessageType.GET_PLAYBACK_CANDIDATES,
    });
    const candidates = (response as { candidates?: unknown } | undefined)?.candidates;
    if (!Array.isArray(candidates)) return [];
    return candidates.filter(isPlaybackCandidate).map((candidate) => ({
      ...candidate,
      frameId: frame.frameId,
      frameUrl: frame.url || candidate.frameUrl,
    }));
  }));

  return frameResults.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
}

