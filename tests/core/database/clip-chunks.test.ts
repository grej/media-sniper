import { describe, expect, it } from "vitest";
import {
  clipTrackNamespace,
  deleteClipOperationChunks,
  readClipTrackChunks,
  storeClipTrackChunk,
} from "@/core/database/clip-chunks";

describe("clip chunk namespaces", () => {
  it("round-trips dense chunks independently by operation and track", async () => {
    const operationId = `cliptest_${crypto.randomUUID().replaceAll("-", "")}`;
    await storeClipTrackChunk(operationId, "video", 0, new Uint8Array([1]).buffer);
    await storeClipTrackChunk(operationId, "video", 1, new Uint8Array([2]).buffer);
    await storeClipTrackChunk(operationId, "audio", 0, new Uint8Array([3]).buffer);

    expect(
      (await readClipTrackChunks(operationId, "video")).map((item) => [
        ...new Uint8Array(item),
      ]),
    ).toEqual([[1], [2]]);
    expect(clipTrackNamespace(operationId, "audio")).toContain("clip-track--audio");

    await deleteClipOperationChunks(operationId);
    expect(await readClipTrackChunks(operationId, "video")).toEqual([]);
    expect(await readClipTrackChunks(operationId, "audio")).toEqual([]);
  });

  it("rejects unsafe physical key components", () => {
    expect(() => clipTrackNamespace("bad/id", "video")).toThrow(
      "Invalid clip operation ID",
    );
  });
});

