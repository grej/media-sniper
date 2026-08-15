import { describe, expect, it } from "vitest";
import { MediaJobQueue } from "@/core/media/media-job-queue";

describe("MediaJobQueue", () => {
  it("runs jobs one at a time in insertion order", async () => {
    const queue = new MediaJobQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
      return 1;
    });
    const second = queue.enqueue(async () => {
      events.push("second:start");
      events.push("second:end");
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    expect(queue.pendingCount).toBe(2);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
    expect(queue.pendingCount).toBe(0);
  });

  it("continues after a rejected job", async () => {
    const queue = new MediaJobQueue();
    const failure = queue.enqueue(async () => {
      throw new Error("expected");
    });
    const success = queue.enqueue(async () => "ok");

    await expect(failure).rejects.toThrow("expected");
    await expect(success).resolves.toBe("ok");
  });
});
