import { describe, expect, it } from "vitest";
import { DownloadStage, VideoFormat, type DownloadState } from "@/core/types";
import { withOperationDefaults } from "@/core/database/downloads";
import { openDatabase } from "@/core/database/connection";

function legacyState(stage: DownloadStage): DownloadState {
  return {
    id: "legacy-id",
    url: "https://example.test/video.mp4",
    metadata: {
      url: "https://example.test/video.mp4",
      pageUrl: "https://example.test/watch",
      format: VideoFormat.DIRECT,
    },
    progress: { url: "https://example.test/video.mp4", stage },
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("download v4 operation defaults", () => {
  it("upgrades a v3 database row in place", async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("media-bridge");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });

    const v3 = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("media-bridge", 3);
      request.onupgradeneeded = () => {
        const db = request.result;
        const chunks = db.createObjectStore("chunks", {
          keyPath: ["downloadId", "index"],
        });
        chunks.createIndex("downloadId", "downloadId", { unique: false });
        chunks.createIndex("index", "index", { unique: false });
        const downloads = db.createObjectStore("downloads", { keyPath: "id" });
        downloads.createIndex("url", "url", { unique: false });
        downloads.createIndex("updatedAt", "updatedAt", { unique: false });
        downloads.createIndex("createdAt", "createdAt", { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    await new Promise<void>((resolve, reject) => {
      const transaction = v3.transaction("downloads", "readwrite");
      transaction.objectStore("downloads").put(legacyState(DownloadStage.COMPLETED));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    v3.close();

    const upgraded = await openDatabase();
    expect(upgraded.version).toBe(4);
    const migrated = await new Promise<DownloadState>((resolve, reject) => {
      const transaction = upgraded.transaction("downloads", "readonly");
      const store = transaction.objectStore("downloads");
      expect(store.indexNames.contains("operationKey")).toBe(true);
      const request = store.get("legacy-id");
      request.onsuccess = () => resolve(request.result as DownloadState);
      request.onerror = () => reject(request.error);
    });
    expect(migrated.operation).toEqual({
      kind: "download",
      operationKey: "legacy:legacy-id",
    });
  });

  it("keeps legacy downloads displayable", () => {
    const migrated = withOperationDefaults(legacyState(DownloadStage.COMPLETED));
    expect(migrated.operation).toEqual({
      kind: "download",
      operationKey: "legacy:legacy-id",
      backend: "browser",
    });
    expect(migrated.metadata.source).toEqual({
      kind: "browser",
      mediaUrl: migrated.metadata.url,
      format: VideoFormat.DIRECT,
      pageUrl: migrated.metadata.pageUrl,
    });
  });

  it("recognizes an interrupted recording", () => {
    expect(
      withOperationDefaults(legacyState(DownloadStage.RECORDING)).operation?.kind,
    ).toBe("record");
  });

  it("does not overwrite existing clip metadata", () => {
    const state = legacyState(DownloadStage.COMPLETED);
    state.operation = {
      kind: "clip",
      operationKey: 'media-operation:{"version":1,"url":"legacy"}',
      requestedDurationMs: 5_000,
    };
    expect(withOperationDefaults(state).operation).toBe(state.operation);
    expect(withOperationDefaults(state).operation?.operationKey).toContain('"version":1');
  });
});
