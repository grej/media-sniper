import { describe, expect, it, vi } from 'vitest';
import {
  bindClippingSettingsSave,
  clippingFormToSettings,
  clippingSettingsToForm,
} from '@/options/clipping-settings';

describe('clipping settings form conversions', () => {
  it('converts user-facing minutes and MiB to persisted integer units', () => {
    expect(clippingFormToSettings({
      maxClipDurationMinutes: 2.5,
      maxInMemoryMiB: 512,
      directNoRangeMiB: 250,
      mediabunnyCacheMiB: 64,
      mediabunnyParallelism: 3,
      overlayEnabled: true,
      defaultMode: 'exact',
    })).toEqual({
      maxClipDurationMs: 150_000,
      maxInMemoryClipBytes: 536_870_912,
      directNoRangeMaxBytes: 262_144_000,
      mediabunnyCacheBytes: 67_108_864,
      mediabunnyParallelism: 3,
      overlayEnabled: true,
      defaultMode: 'exact',
    });
  });

  it('round-trips resolved settings without losing values', () => {
    const settings = {
      maxClipDurationMs: 15_000,
      maxInMemoryClipBytes: 64 * 1024 * 1024,
      directNoRangeMaxBytes: 32 * 1024 * 1024,
      mediabunnyCacheBytes: 16 * 1024 * 1024,
      mediabunnyParallelism: 1,
      overlayEnabled: false,
      defaultMode: 'fast' as const,
    };
    expect(clippingFormToSettings(clippingSettingsToForm(settings))).toEqual(settings);
  });

  it('replaces duplicate save bindings and supports explicit cleanup', () => {
    const button = document.createElement('button');
    const first = vi.fn();
    const second = vi.fn();
    const cleanupFirst = bindClippingSettingsSave(button, first);
    const cleanupSecond = bindClippingSettingsSave(button, second);

    button.click();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();

    cleanupFirst();
    button.click();
    expect(second).toHaveBeenCalledTimes(2);
    cleanupSecond();
    button.click();
    expect(second).toHaveBeenCalledTimes(2);
  });
});
