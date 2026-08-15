import {
  deleteChunks,
  getAllChunks,
  storeChunk,
} from "./chunks";

/** Logical track namespaces for temporary clip input data. */
export type ClipTrackKind = "combined" | "video" | "audio" | "init";

const CLIP_NAMESPACE_MARKER = "clip-track";
const TRACK_KINDS: readonly ClipTrackKind[] = [
  "combined",
  "video",
  "audio",
  "init",
];

/**
 * Encode the preferred [operationId, trackKind, storageIndex] shape into the
 * existing chunks store's downloadId component. Keeping this in one helper
 * avoids an invasive IndexedDB key-path migration and prevents new ad-hoc
 * suffix conventions.
 */
export function clipTrackNamespace(
  operationId: string,
  trackKind: ClipTrackKind,
): string {
  if (!operationId || !/^[a-zA-Z0-9_-]+$/.test(operationId)) {
    throw new Error(`Invalid clip operation ID: ${operationId}`);
  }
  return `${operationId}--${CLIP_NAMESPACE_MARKER}--${trackKind}`;
}

export async function storeClipTrackChunk(
  operationId: string,
  trackKind: ClipTrackKind,
  storageIndex: number,
  data: ArrayBuffer,
): Promise<void> {
  if (!Number.isSafeInteger(storageIndex) || storageIndex < 0) {
    throw new Error(`Invalid dense storage index: ${storageIndex}`);
  }
  await storeChunk(clipTrackNamespace(operationId, trackKind), storageIndex, data);
}

export function readClipTrackChunks(
  operationId: string,
  trackKind: ClipTrackKind,
): Promise<ArrayBuffer[]> {
  return getAllChunks(clipTrackNamespace(operationId, trackKind));
}

export function deleteClipTrackChunks(
  operationId: string,
  trackKind: ClipTrackKind,
): Promise<void> {
  return deleteChunks(clipTrackNamespace(operationId, trackKind));
}

/** Remove every temporary namespace belonging to a clip operation. */
export async function deleteClipOperationChunks(
  operationId: string,
): Promise<void> {
  await Promise.all(
    TRACK_KINDS.map((trackKind) =>
      deleteClipTrackChunks(operationId, trackKind),
    ),
  );
}

