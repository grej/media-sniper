function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/**
 * Add active-only cancellation to a serialized job. A job canceled while it
 * is still queued exits without invoking either the job or the active abort
 * hook (which could otherwise terminate a different active FFmpeg instance).
 */
export async function runAbortableMediaJob<T>(
  signal: AbortSignal,
  onActiveAbort: () => void,
  job: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw abortError();

  const abortHandler = () => onActiveAbort();
  signal.addEventListener("abort", abortHandler, { once: true });
  try {
    const result = await job();
    if (signal.aborted) throw abortError();
    return result;
  } finally {
    signal.removeEventListener("abort", abortHandler);
  }
}

