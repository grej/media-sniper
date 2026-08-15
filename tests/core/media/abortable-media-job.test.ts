import { describe, expect, it, vi } from "vitest";
import { runAbortableMediaJob } from "@/core/media/abortable-media-job";

describe("runAbortableMediaJob", () => {
  it("does not start or reset media state for a queued cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const job = vi.fn();
    const onActiveAbort = vi.fn();

    await expect(
      runAbortableMediaJob(controller.signal, onActiveAbort, job),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(job).not.toHaveBeenCalled();
    expect(onActiveAbort).not.toHaveBeenCalled();
  });

  it("runs the active abort hook and suppresses a late success", async () => {
    const controller = new AbortController();
    let finish!: (value: string) => void;
    const job = vi.fn(
      () => new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const onActiveAbort = vi.fn();
    const result = runAbortableMediaJob(
      controller.signal,
      onActiveAbort,
      job,
    );

    controller.abort();
    finish("late-success");

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(onActiveAbort).toHaveBeenCalledOnce();
  });
});

