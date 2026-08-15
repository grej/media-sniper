import { describe, expect, it } from 'vitest';
import { createHistoryOperationDetails } from '@/options/history-operation';
import { DownloadStage, VideoFormat, type DownloadState } from '@/core/types';

function state(operation?: DownloadState['operation']): DownloadState {
  return {
    id: 'history-1',
    url: 'https://cdn.example/video.mp4',
    metadata: {
      url: 'https://cdn.example/video.mp4',
      pageUrl: 'https://page.example',
      format: VideoFormat.DIRECT,
    },
    progress: {
      url: 'https://cdn.example/video.mp4',
      stage: DownloadStage.COMPLETED,
    },
    operation,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('history clip operation details', () => {
  it('renders range, mode, accuracy, and requested/actual durations', () => {
    const details = createHistoryOperationDetails(state({
      kind: 'clip',
      operationKey: 'clip-key',
      clip: { startMs: 5_000, endMs: 12_250, mode: 'fast', markSource: 'manual' },
      requestedDurationMs: 7_250,
      actualDurationMs: 7_500,
      accuracy: 'keyframe-aligned',
      manifestQuality: { qualityKey: '1080p', label: '1080p + English' },
    }));

    expect(details?.className).toBe('history-operation');
    expect(details?.textContent).toBe(
      '00:00:05.000–00:00:12.250 · Fast cut · 1080p + English · Keyframe-aligned · 00:00:07.250 requested · 00:00:07.500 actual',
    );
  });

  it('returns no detail row for legacy v3 records without operation metadata', () => {
    expect(createHistoryOperationDetails(state())).toBeNull();
  });
});
