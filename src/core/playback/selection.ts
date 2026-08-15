import type {
  PlaybackCandidate,
  PlaybackCandidateQuery,
  PlaybackSelectionResult,
} from './types';

function normalizeSource(source?: string): string {
  if (!source) return '';
  try {
    const url = new URL(source);
    url.hash = '';
    return url.href;
  } catch {
    return source.split('#', 1)[0];
  }
}

interface CandidateRank {
  identity: number;
  playing: number;
  visible: number;
  intersectionRatio: number;
  renderedArea: number;
  readyState: number;
  stableKey: string;
}

function rank(candidate: PlaybackCandidate, query: PlaybackCandidateQuery): CandidateRank {
  const pageVideoMatch = Boolean(query.pageVideoId)
    && candidate.pageVideoId === query.pageVideoId;
  const sourceMatch = Boolean(query.sourceUrl)
    && normalizeSource(candidate.currentSrc) === normalizeSource(query.sourceUrl);
  return {
    identity: pageVideoMatch ? 2 : sourceMatch ? 1 : 0,
    playing: !candidate.paused && !candidate.ended ? 1 : 0,
    visible: candidate.visible ? 1 : 0,
    intersectionRatio: candidate.intersectionRatio,
    renderedArea: candidate.renderedArea,
    readyState: candidate.readyState,
    stableKey: `${candidate.frameId ?? -1}:${candidate.pageVideoId}`,
  };
}

function compareRank(left: CandidateRank, right: CandidateRank): number {
  return right.identity - left.identity
    || right.playing - left.playing
    || right.visible - left.visible
    || right.intersectionRatio - left.intersectionRatio
    || right.renderedArea - left.renderedArea
    || right.readyState - left.readyState
    || left.stableKey.localeCompare(right.stableKey);
}

function similarlyPlausible(left: CandidateRank, right: CandidateRank): boolean {
  if (left.identity > 0 || right.identity > 0) return false;
  const largestArea = Math.max(left.renderedArea, right.renderedArea, 1);
  return left.playing === right.playing
    && left.visible === right.visible
    && Math.abs(left.intersectionRatio - right.intersectionRatio) <= 0.1
    && Math.abs(left.renderedArea - right.renderedArea) / largestArea <= 0.15
    && left.readyState === right.readyState;
}

/** Deterministically chooses a page video while preserving ambiguity for the UI. */
export function selectPlaybackCandidate(
  candidates: PlaybackCandidate[],
  query: PlaybackCandidateQuery = {},
): PlaybackSelectionResult {
  if (candidates.length === 0) {
    return { alternatives: [], ambiguous: false, reason: 'no-candidates' };
  }

  const ranked = candidates
    .map((candidate) => ({ candidate, rank: rank(candidate, query) }))
    .sort((left, right) => compareRank(left.rank, right.rank));
  const [best, second] = ranked;
  const alternatives = ranked.map(({ candidate }) => candidate);

  return {
    candidate: best.candidate,
    alternatives,
    ambiguous: Boolean(second && similarlyPlausible(best.rank, second.rank)),
    reason: best.rank.identity === 2
      ? 'page-video-id'
      : best.rank.identity === 1
        ? 'source-url'
        : 'playback-state',
  };
}

