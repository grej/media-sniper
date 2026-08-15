import type { ClipMode, ManifestQualitySelection } from '../clipping/types';

export interface PlaybackRange {
  startMs: number;
  endMs: number;
}

/** A serializable snapshot of one video element in one frame. */
export interface PlaybackCandidate {
  pageVideoId: string;
  frameId?: number;
  frameUrl: string;
  currentSrc: string;
  currentTimeMs: number;
  durationMs?: number;
  paused: boolean;
  ended: boolean;
  readyState: number;
  visible: boolean;
  intersectionRatio: number;
  renderedArea: number;
  muted: boolean;
  volume: number;
  playbackRate: number;
  seekableRanges: PlaybackRange[];
}

export interface PlaybackCandidateQuery {
  pageVideoId?: string;
  sourceUrl?: string;
}

export interface PlaybackSelectionResult {
  candidate?: PlaybackCandidate;
  alternatives: PlaybackCandidate[];
  ambiguous: boolean;
  reason: 'page-video-id' | 'source-url' | 'playback-state' | 'no-candidates';
}

export interface ClipDraftLocator {
  tabId: number;
  frameId: number;
  pageVideoId?: string;
  sourceKey?: string;
}

export interface ClipDraft {
  locator: ClipDraftLocator;
  startMs?: number;
  endMs?: number;
  mode: ClipMode;
  quality?: ManifestQualitySelection;
  updatedAt: number;
}

export interface ClipMarkUpdate {
  locator: ClipDraftLocator;
  mark: 'start' | 'end';
  timeMs: number;
  mode?: ClipMode;
  quality?: ManifestQualitySelection;
}

export interface PlaybackCandidatesResponse {
  success: boolean;
  candidates: PlaybackCandidate[];
  error?: string;
}

