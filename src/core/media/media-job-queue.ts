/**
 * A single-concurrency queue for memory-intensive media work.
 *
 * Both FFmpeg.wasm and WebCodecs conversions can consume substantial memory;
 * keeping their scheduling here prevents the offscreen document from running
 * heavyweight jobs concurrently.
 */
export class MediaJobQueue {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  get pendingCount(): number {
    return this.queued;
  }

  enqueue<T>(job: () => Promise<T>): Promise<T> {
    this.queued += 1;

    const result = this.tail.then(job, job);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result.finally(() => {
      this.queued -= 1;
    });
  }
}
