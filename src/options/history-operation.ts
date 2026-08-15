import { formatClockTimeMs } from '../core/clipping/time';
import type { DownloadState } from '../core/types';

function safeTime(milliseconds: number | undefined): string | undefined {
  return Number.isSafeInteger(milliseconds) && milliseconds! >= 0
    ? formatClockTimeMs(milliseconds!)
    : undefined;
}

/** Builds the optional detail row for v4 clip operations; v3 rows return null. */
export function createHistoryOperationDetails(
  state: DownloadState,
  ownerDocument: Document = document,
): HTMLElement | null {
  const operation = state.operation;
  const clip = operation?.kind === 'clip' ? operation.clip : undefined;
  if (!operation || !clip) return null;

  const start = safeTime(clip.startMs);
  const end = safeTime(clip.endMs);
  if (!start || !end) return null;

  const details = ownerDocument.createElement('div');
  details.className = 'history-operation';
  const parts = [
    `${start}–${end}`,
    clip.mode === 'exact' ? 'Exact cut' : 'Fast cut',
  ];
  const quality = operation.manifestQuality?.label
    ?? operation.manifestQuality?.qualityKey
    ?? operation.qualityKey
    ?? state.metadata.quality
    ?? state.metadata.resolution;
  if (quality) parts.push(quality);
  if (operation.accuracy) {
    parts.push(operation.accuracy === 'keyframe-aligned' ? 'Keyframe-aligned' : 'Exact timing');
  }
  const requested = safeTime(operation.requestedDurationMs);
  const actual = safeTime(operation.actualDurationMs);
  if (requested) parts.push(`${requested} requested`);
  if (actual) parts.push(`${actual} actual`);
  details.textContent = parts.join(' · ');
  details.title = `Clip operation: ${details.textContent}`;
  return details;
}
