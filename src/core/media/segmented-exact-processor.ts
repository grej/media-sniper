import {
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  MP4,
  MPEG_TS,
  Mp4OutputFormat,
  Output,
  QTFF,
  type DiscardedTrack,
  type InputTrack,
} from "mediabunny";
import {
  MediabunnyCapabilityError,
  processMediabunnyClip,
} from "./mediabunny-clip-processor";

export type SegmentedExactMediaFormat = "hls-ts" | "hls-fmp4" | "dash-fmp4";

export type SegmentedExactInput =
  | {
      kind: "combined";
      blob: Blob;
      relativeStartMs: number;
    }
  | {
      kind: "separate";
      videoBlob: Blob;
      audioBlob: Blob;
      videoRelativeStartMs: number;
      audioRelativeStartMs: number;
    };

export interface SegmentedExactOptions {
  mediaFormat: SegmentedExactMediaFormat;
  input: SegmentedExactInput;
  durationMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: number, processedTimeMs: number) => void;
}

export interface SegmentedExactResult {
  blob: Blob;
  size: number;
  accuracy: "exact";
  actualDurationMs?: number;
  discardedTracks: DiscardedTrack[];
}

function abortError(): DOMException {
  return new DOMException("The segmented Exact job was cancelled", "AbortError");
}

function formatsFor(mediaFormat: SegmentedExactMediaFormat) {
  return mediaFormat === "hls-ts" ? [MPEG_TS, MP4, QTFF] : [MP4, QTFF];
}

function createBlobInput(blob: Blob, mediaFormat: SegmentedExactMediaFormat): Input {
  return new Input({
    formats: formatsFor(mediaFormat),
    source: new BlobSource(blob),
  });
}

function validateOptions(options: SegmentedExactOptions): void {
  if (!Number.isSafeInteger(options.durationMs) || options.durationMs <= 0) {
    throw new TypeError("Exact segmented duration must be a positive integer");
  }
  const starts = options.input.kind === "combined"
    ? [options.input.relativeStartMs]
    : [options.input.videoRelativeStartMs, options.input.audioRelativeStartMs];
  if (starts.some((start) => !Number.isSafeInteger(start) || start < 0)) {
    throw new TypeError("Exact segmented relative starts must be non-negative integers");
  }
}

function requiredTrackFailure(
  conversion: Conversion,
  requiredTrack: InputTrack | null,
): DiscardedTrack[] {
  if (!requiredTrack) return [];
  if (conversion.utilizedTracks.includes(requiredTrack)) return [];
  return conversion.discardedTracks.filter(({ track }) => track === requiredTrack);
}

async function measureDuration(blob: Blob): Promise<number | undefined> {
  const input = new Input({ formats: [MP4], source: new BlobSource(blob) });
  try {
    const duration = await input.getDurationFromMetadata();
    return duration !== null && Number.isFinite(duration)
      ? Math.round(duration * 1_000)
      : undefined;
  } finally {
    input.dispose();
  }
}

/** Forced-transcode a selected local segmented window into an exact MP4. */
export async function processSegmentedExactClip(
  options: SegmentedExactOptions,
): Promise<SegmentedExactResult> {
  validateOptions(options);
  if (options.signal?.aborted) throw abortError();

  if (options.input.kind === "combined") {
    const { relativeStartMs } = options.input;
    const result = await processMediabunnyClip({
      input: { kind: "blob", blob: options.input.blob },
      startMs: relativeStartMs,
      endMs: relativeStartMs + options.durationMs,
      exact: true,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    return {
      blob: result.blob,
      size: result.blob.size,
      accuracy: "exact",
      actualDurationMs: result.actualDurationMs,
      discardedTracks: result.discardedTracks,
    };
  }

  const videoInput = createBlobInput(options.input.videoBlob, options.mediaFormat);
  const audioInput = createBlobInput(options.input.audioBlob, options.mediaFormat);
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target,
  });
  let videoConversion: Conversion | null = null;
  let audioConversion: Conversion | null = null;
  const cancel = () => {
    videoInput.dispose();
    audioInput.dispose();
    void Promise.allSettled([
      videoConversion?.cancel(),
      audioConversion?.cancel(),
      output.cancel(),
    ]);
  };
  options.signal?.addEventListener("abort", cancel, { once: true });

  try {
    const [videoTrack, audioTrack] = await Promise.all([
      videoInput.getPrimaryVideoTrack(),
      audioInput.getPrimaryAudioTrack(),
    ]);
    if (!videoTrack || !audioTrack) throw new MediabunnyCapabilityError([]);

    const durationSeconds = options.durationMs / 1_000;
    [videoConversion, audioConversion] = await Promise.all([
      Conversion.init({
        input: videoInput,
        output,
        tracks: "primary",
        trim: {
          start: options.input.videoRelativeStartMs / 1_000,
          end: (options.input.videoRelativeStartMs + options.durationMs) / 1_000,
        },
        video: {
          codec: "avc",
          forceTranscode: true,
          hardwareAcceleration: "prefer-hardware",
        },
        audio: { discard: true },
        composable: true,
        showWarnings: false,
      }),
      Conversion.init({
        input: audioInput,
        output,
        tracks: "primary",
        trim: {
          start: options.input.audioRelativeStartMs / 1_000,
          end: (options.input.audioRelativeStartMs + options.durationMs) / 1_000,
        },
        video: { discard: true },
        audio: { codec: "aac", forceTranscode: true },
        composable: true,
        showWarnings: false,
      }),
    ]);
    if (options.signal?.aborted) throw abortError();

    const missing = [
      ...requiredTrackFailure(videoConversion, videoTrack),
      ...requiredTrackFailure(audioConversion, audioTrack),
    ];
    if (missing.length > 0 || !videoConversion.utilizedTracks.includes(videoTrack) ||
        !audioConversion.utilizedTracks.includes(audioTrack)) {
      throw new MediabunnyCapabilityError(missing);
    }

    let videoProgress = 0;
    let audioProgress = 0;
    const report = () => {
      const progress = Math.min(videoProgress, audioProgress);
      options.onProgress?.(progress, Math.round(progress * options.durationMs));
    };
    videoConversion.onProgress = (progress) => {
      videoProgress = progress;
      report();
    };
    audioConversion.onProgress = (progress) => {
      audioProgress = progress;
      report();
    };

    await output.start();
    // Advance independent timelines in lockstep so neither encoder can build
    // an unbounded lead and both normalized tracks retain a common zero point.
    for (let until = 0.5; until < durationSeconds; until += 0.5) {
      await Promise.all([
        videoConversion.execute({ until }),
        audioConversion.execute({ until }),
      ]);
      if (options.signal?.aborted) throw abortError();
    }
    await Promise.all([videoConversion.execute(), audioConversion.execute()]);
    if (options.signal?.aborted) throw abortError();
    await output.finalize();
    if (!target.buffer) {
      throw new Error("Mediabunny completed without producing an Exact output");
    }
    const blob = new Blob([target.buffer], { type: "video/mp4" });
    return {
      blob,
      size: blob.size,
      accuracy: "exact",
      actualDurationMs: await measureDuration(blob),
      discardedTracks: [
        ...videoConversion.discardedTracks,
        ...audioConversion.discardedTracks,
      ],
    };
  } catch (error) {
    if (options.signal?.aborted) throw abortError();
    await output.cancel().catch(() => undefined);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    videoInput.dispose();
    audioInput.dispose();
  }
}
