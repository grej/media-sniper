import { describe, expect, it, vi } from "vitest";
import { SerialEventQueue } from "@/core/companion/event-queue";

describe("companion event queue", () => {
  it("persists later terminal events only after earlier progress writes", async () => {
    let releasePlanning!: () => void;
    const planningGate = new Promise<void>((resolve) => { releasePlanning = resolve; });
    const writes: string[] = [];
    const handle = vi.fn(async (event: string) => {
      if (event === "planning") await planningGate;
      writes.push(event);
    });
    const queue = new SerialEventQueue(handle);

    queue.push("planning");
    queue.push("fallback-required");
    await Promise.resolve();
    expect(writes).toEqual([]);

    releasePlanning();
    await queue.flush();
    expect(writes).toEqual(["planning", "fallback-required"]);
  });
});
