import { describe, expect, it } from 'vitest';
import {
  CLIP_DRAFT_STORAGE_PREFIX,
  CLIP_DRAFT_TTL_MS,
  cleanupExpiredClipDrafts,
  clearClipDraft,
  createClipDraftStorageKey,
  getClipDraft,
  setClipMark,
} from '@/core/playback/clip-draft-store';
import type { ClipDraftLocator } from '@/core/playback/types';

function memoryStorage() {
  const values: Record<string, unknown> = {};
  const storage = {
    async get(keys: string | string[] | null) {
      if (keys === null) return { ...values };
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested
        .filter((key) => key in values)
        .map((key) => [key, values[key]]));
    },
    async set(items: Record<string, unknown>) {
      Object.assign(values, items);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  } as unknown as chrome.storage.StorageArea;
  return { storage, values };
}

const locator: ClipDraftLocator = { tabId: 42, frameId: 3, pageVideoId: 'page/video' };

describe('clip draft storage', () => {
  it('builds deterministic keys and normalizes source fragments', () => {
    expect(createClipDraftStorageKey(locator)).toBe(
      `${CLIP_DRAFT_STORAGE_PREFIX}42:3:video%3Apage%2Fvideo`,
    );
    expect(createClipDraftStorageKey({
      tabId: 42,
      frameId: -1,
      sourceKey: 'https://cdn.example/video.mp4#t=5',
    })).toBe(createClipDraftStorageKey({
      tabId: 42,
      frameId: -1,
      sourceKey: 'https://cdn.example/video.mp4',
    }));
  });

  it('serializes concurrent start/end marks without losing either update', async () => {
    const { storage } = memoryStorage();
    await Promise.all([
      setClipMark({ locator, mark: 'start', timeMs: 1_000, mode: 'exact' }, storage, 100),
      setClipMark({ locator, mark: 'end', timeMs: 4_000 }, storage, 101),
    ]);

    expect(await getClipDraft(locator, storage, 102)).toEqual({
      locator,
      startMs: 1_000,
      endMs: 4_000,
      mode: 'exact',
      quality: undefined,
      updatedAt: 101,
    });
  });

  it('expires drafts after 24 hours and clears them on request', async () => {
    const { storage, values } = memoryStorage();
    await setClipMark({ locator, mark: 'start', timeMs: 2_000 }, storage, 10);
    expect(await getClipDraft(locator, storage, 10 + CLIP_DRAFT_TTL_MS - 1)).not.toBeNull();
    expect(await getClipDraft(locator, storage, 10 + CLIP_DRAFT_TTL_MS)).toBeNull();
    expect(values).toEqual({});

    await setClipMark({ locator, mark: 'start', timeMs: 2_000 }, storage, 20);
    await clearClipDraft(locator, storage);
    expect(await getClipDraft(locator, storage, 21)).toBeNull();
  });

  it('cleans expired and malformed draft records without touching other session data', async () => {
    const { storage, values } = memoryStorage();
    const key = createClipDraftStorageKey(locator);
    values[key] = { locator, mode: 'fast', updatedAt: 1 };
    values[`${CLIP_DRAFT_STORAGE_PREFIX}malformed`] = 'bad';
    values.unrelated = { updatedAt: 1 };

    expect(await cleanupExpiredClipDrafts(storage, 1 + CLIP_DRAFT_TTL_MS)).toBe(2);
    expect(values).toEqual({ unrelated: { updatedAt: 1 } });
  });
});
