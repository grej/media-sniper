import type { ClipDraft, ClipDraftLocator, ClipMarkUpdate } from './types';

export const CLIP_DRAFT_STORAGE_PREFIX = 'clip-draft:v1:';
export const CLIP_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

const mutationQueues = new Map<string, Promise<void>>();

function normalizeSourceKey(source: string): string {
  try {
    const url = new URL(source);
    url.hash = '';
    return url.href;
  } catch {
    return source.split('#', 1)[0];
  }
}

function validateLocator(locator: ClipDraftLocator): void {
  if (!Number.isInteger(locator.tabId) || locator.tabId < 0) {
    throw new Error('Clip draft tabId must be a non-negative integer');
  }
  if (!Number.isInteger(locator.frameId) || locator.frameId < -1) {
    throw new Error('Clip draft frameId must be an integer greater than or equal to -1');
  }
  if (!locator.pageVideoId?.trim() && !locator.sourceKey?.trim()) {
    throw new Error('Clip draft locator requires pageVideoId or sourceKey');
  }
}

export function createClipDraftStorageKey(locator: ClipDraftLocator): string {
  validateLocator(locator);
  const identity = locator.pageVideoId?.trim()
    ? `video:${locator.pageVideoId.trim()}`
    : `source:${normalizeSourceKey(locator.sourceKey!.trim())}`;
  return `${CLIP_DRAFT_STORAGE_PREFIX}${locator.tabId}:${locator.frameId}:${encodeURIComponent(identity)}`;
}

function isExpired(draft: ClipDraft, now: number): boolean {
  return !Number.isFinite(draft.updatedAt) || now - draft.updatedAt >= CLIP_DRAFT_TTL_MS;
}

async function lockDraft<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let result!: T;
  let operationError: unknown;
  const queued = previous.catch(() => undefined).then(async () => {
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }
  });
  mutationQueues.set(key, queued);
  try {
    await queued;
    if (operationError) throw operationError;
    return result;
  } finally {
    if (mutationQueues.get(key) === queued) mutationQueues.delete(key);
  }
}

export async function getClipDraft(
  locator: ClipDraftLocator,
  storage: chrome.storage.StorageArea = chrome.storage.session,
  now = Date.now(),
): Promise<ClipDraft | null> {
  const key = createClipDraftStorageKey(locator);
  const stored = (await storage.get(key))[key] as ClipDraft | undefined;
  if (!stored) return null;
  if (isExpired(stored, now)) {
    await storage.remove(key);
    return null;
  }
  return stored;
}

export async function setClipMark(
  update: ClipMarkUpdate,
  storage: chrome.storage.StorageArea = chrome.storage.session,
  now = Date.now(),
): Promise<ClipDraft> {
  if (!Number.isInteger(update.timeMs) || update.timeMs < 0) {
    throw new Error('Clip mark timeMs must be a non-negative integer');
  }
  const key = createClipDraftStorageKey(update.locator);
  return lockDraft(key, async () => {
    const stored = (await storage.get(key))[key] as ClipDraft | undefined;
    const current = stored && !isExpired(stored, now) ? stored : undefined;
    const draft: ClipDraft = {
      locator: update.locator,
      startMs: current?.startMs,
      endMs: current?.endMs,
      mode: update.mode ?? current?.mode ?? 'fast',
      quality: update.quality ?? current?.quality,
      updatedAt: now,
    };
    if (update.mark === 'start') draft.startMs = update.timeMs;
    else draft.endMs = update.timeMs;
    await storage.set({ [key]: draft });
    return draft;
  });
}

export async function clearClipDraft(
  locator: ClipDraftLocator,
  storage: chrome.storage.StorageArea = chrome.storage.session,
): Promise<void> {
  await storage.remove(createClipDraftStorageKey(locator));
}

export async function cleanupExpiredClipDrafts(
  storage: chrome.storage.StorageArea = chrome.storage.session,
  now = Date.now(),
): Promise<number> {
  const entries = await storage.get(null);
  const expiredKeys = Object.entries(entries)
    .filter(([key, value]) => key.startsWith(CLIP_DRAFT_STORAGE_PREFIX)
      && (!value || typeof value !== 'object' || isExpired(value as ClipDraft, now)))
    .map(([key]) => key);
  if (expiredKeys.length > 0) await storage.remove(expiredKeys);
  return expiredKeys.length;
}
