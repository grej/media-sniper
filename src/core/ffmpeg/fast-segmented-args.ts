export interface CombinedFastClipInput {
  kind: "combined";
  inputFile: string;
  relativeStartMs: number;
}

export interface SeparateFastClipInput {
  kind: "separate";
  videoFile: string;
  audioFile: string;
  videoRelativeStartMs: number;
  audioRelativeStartMs: number;
}

export type FastClipInput = CombinedFastClipInput | SeparateFastClipInput;

export interface FastSegmentedArgsOptions {
  input: FastClipInput;
  mediaFormat: "hls-ts" | "hls-fmp4" | "dash-fmp4";
  durationMs: number;
  outputFile: string;
}

function seconds(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error(`Invalid FFmpeg timestamp: ${milliseconds}`);
  }
  return (milliseconds / 1000).toFixed(3);
}

/** Build deterministic keyframe-aligned stream-copy arguments. */
export function buildFastSegmentedClipArgs(
  options: FastSegmentedArgsOptions,
): string[] {
  if (!(["hls-ts", "hls-fmp4", "dash-fmp4"] as const).includes(options.mediaFormat)) {
    throw new Error(`Unsupported segmented media format: ${options.mediaFormat}`);
  }
  if (!Number.isFinite(options.durationMs) || options.durationMs <= 0) {
    throw new Error(`Invalid clip duration: ${options.durationMs}`);
  }
  if (!options.outputFile) throw new Error("An FFmpeg output file is required");
  const duration = seconds(options.durationMs);
  const audioBitstreamFilter =
    options.mediaFormat === "hls-ts" ? ["-bsf:a", "aac_adtstoasc"] : [];

  if (options.input.kind === "combined") {
    return [
      "-y",
      "-i",
      options.input.inputFile,
      "-ss",
      seconds(options.input.relativeStartMs),
      "-t",
      duration,
      "-map",
      "0:v?",
      "-map",
      "0:a?",
      "-c",
      "copy",
      ...audioBitstreamFilter,
      "-avoid_negative_ts",
      "make_zero",
      "-movflags",
      "+faststart",
      options.outputFile,
    ];
  }

  return [
    "-y",
    "-ss",
    seconds(options.input.videoRelativeStartMs),
    "-i",
    options.input.videoFile,
    "-ss",
    seconds(options.input.audioRelativeStartMs),
    "-i",
    options.input.audioFile,
    "-t",
    duration,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c",
    "copy",
    ...audioBitstreamFilter,
    "-avoid_negative_ts",
    "make_zero",
    "-shortest",
    "-movflags",
    "+faststart",
    options.outputFile,
  ];
}
