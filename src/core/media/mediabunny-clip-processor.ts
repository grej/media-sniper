import {
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
  QTFF,
  UrlSource,
  WEBM,
  type DiscardedTrack,
} from "mediabunny";

export type MediabunnyClipInput =
  | { kind: "blob"; blob: Blob }
  | {
      kind: "url";
      url: string | URL | Request;
      requestInit?: Omit<RequestInit, "signal">;
      fetchFn?: typeof fetch;
      maxCacheSize?: number;
      parallelism?: number;
      getRetryDelay?: (
        previousAttempts: number,
        error: unknown,
        url: string | URL | Request,
      ) => number | null;
    };

export interface MediabunnyClipOptions {
  input: MediabunnyClipInput;
  startMs: number;
  endMs: number;
  exact: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: number, processedTimeMs: number) => void;
}

export interface MediabunnyClipResult {
  blob: Blob;
  discardedTracks: DiscardedTrack[];
  accuracy: "keyframe-aligned" | "exact";
}

export class MediabunnyCapabilityError extends Error {
  readonly discardedTracks: DiscardedTrack[];

  constructor(discardedTracks: DiscardedTrack[]) {
    const reasons = [...new Set(discardedTracks.map(({ reason }) => reason))];
    super(
      reasons.length > 0
        ? `Mediabunny cannot process the required tracks: ${reasons.join(", ")}`
        : "Mediabunny could not create a valid MP4 conversion",
    );
    this.name = "MediabunnyCapabilityError";
    this.discardedTracks = discardedTracks;
  }
}

function abortError(): DOMException {
  return new DOMException("The media job was cancelled", "AbortError");
}

function assertRange(startMs: number, endMs: number): void {
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    startMs < 0 ||
    endMs <= startMs
  ) {
    throw new TypeError("A finite clip range with endMs > startMs is required");
  }
}

function createInput(source: MediabunnyClipInput): Input {
  if (source.kind === "blob") {
    return new Input({
      formats: [MP4, WEBM, QTFF],
      source: new BlobSource(source.blob),
    });
  }

  return new Input({
    formats: [MP4, WEBM, QTFF],
    source: new UrlSource(source.url, {
      requestInit: source.requestInit,
      fetchFn: source.fetchFn,
      maxCacheSize: source.maxCacheSize,
      parallelism: source.parallelism,
      getRetryDelay: source.getRetryDelay,
    }),
  });
}

/**
 * Trim a local or range-backed direct media input to an MP4 entirely in the
 * offscreen/browser context. Fast mode permits packet copying; Exact mode
 * forces retained audio/video tracks through the available WebCodecs codecs.
 */
export async function processMediabunnyClip(
  options: MediabunnyClipOptions,
): Promise<MediabunnyClipResult> {
  const { startMs, endMs, exact, signal, onProgress } = options;
  assertRange(startMs, endMs);
  if (signal?.aborted) throw abortError();

  const input = createInput(options.input);
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target,
  });
  let conversion: Conversion | null = null;

  const cancel = () => {
    input.dispose();
    void (conversion?.cancel() ?? output.cancel()).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });

  try {
    const [primaryVideo, primaryAudio] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);

    conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      trim: { start: startMs / 1000, end: endMs / 1000 },
      video: exact
        ? {
            codec: "avc",
            forceTranscode: true,
            hardwareAcceleration: "prefer-hardware",
          }
        : undefined,
      audio: exact ? { codec: "aac", forceTranscode: true } : undefined,
      showWarnings: false,
    });

    if (signal?.aborted) throw abortError();
    if (!conversion.isValid) {
      throw new MediabunnyCapabilityError(conversion.discardedTracks);
    }
    const missingRequiredTracks = [primaryVideo, primaryAudio]
      .filter((track) => track && !conversion!.utilizedTracks.includes(track))
      .flatMap((track) =>
        conversion!.discardedTracks.filter(
          ({ track: discardedTrack }) => discardedTrack === track,
        ),
      );
    if (missingRequiredTracks.length > 0) {
      throw new MediabunnyCapabilityError(missingRequiredTracks);
    }

    conversion.onProgress = (progress, processedTime) => {
      onProgress?.(progress, Math.round(processedTime * 1000));
    };

    await conversion.execute();
    if (signal?.aborted) throw abortError();
    if (!target.buffer) {
      throw new Error("Mediabunny completed without producing an output buffer");
    }

    return {
      blob: new Blob([target.buffer], { type: "video/mp4" }),
      discardedTracks: conversion.discardedTracks,
      accuracy: exact ? "exact" : "keyframe-aligned",
    };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    input.dispose();
  }
}
