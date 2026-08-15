import type { AppSettings } from '../core/storage/settings';

const MIB = 1024 * 1024;

export const CLIPPING_FORM_LIMITS = {
  maxClipDurationMinutes: { min: 0.25, max: 1_440 },
  maxInMemoryMiB: { min: 32, max: 4_096 },
  directNoRangeMiB: { min: 16, max: 2_048 },
  mediabunnyCacheMiB: { min: 8, max: 1_024 },
  mediabunnyParallelism: { min: 1, max: 8 },
} as const;

export interface ClippingFormValues {
  maxClipDurationMinutes: number;
  maxInMemoryMiB: number;
  directNoRangeMiB: number;
  mediabunnyCacheMiB: number;
  mediabunnyParallelism: number;
  overlayEnabled: boolean;
  defaultMode: 'fast' | 'exact';
}

export function clippingSettingsToForm(
  settings: AppSettings['clipping'],
): ClippingFormValues {
  return {
    maxClipDurationMinutes: settings.maxClipDurationMs / 60_000,
    maxInMemoryMiB: settings.maxInMemoryClipBytes / MIB,
    directNoRangeMiB: settings.directNoRangeMaxBytes / MIB,
    mediabunnyCacheMiB: settings.mediabunnyCacheBytes / MIB,
    mediabunnyParallelism: settings.mediabunnyParallelism,
    overlayEnabled: settings.overlayEnabled,
    defaultMode: settings.defaultMode,
  };
}

export function clippingFormToSettings(
  values: ClippingFormValues,
): AppSettings['clipping'] {
  return {
    maxClipDurationMs: Math.round(values.maxClipDurationMinutes * 60_000),
    maxInMemoryClipBytes: Math.round(values.maxInMemoryMiB * MIB),
    directNoRangeMaxBytes: Math.round(values.directNoRangeMiB * MIB),
    mediabunnyCacheBytes: Math.round(values.mediabunnyCacheMiB * MIB),
    mediabunnyParallelism: values.mediabunnyParallelism,
    overlayEnabled: values.overlayEnabled,
    defaultMode: values.defaultMode,
  };
}

/** Replaces any prior click binding on the dedicated clipping save button. */
export function bindClippingSettingsSave(
  button: HTMLButtonElement,
  save: () => void | Promise<void>,
): () => void {
  const listener = () => { void save(); };
  button.onclick = listener;
  return () => {
    if (button.onclick === listener) button.onclick = null;
  };
}
