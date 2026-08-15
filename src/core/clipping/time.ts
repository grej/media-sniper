import { ClippingError } from "./errors";

const MILLISECONDS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

function invalidTime(input: string, reason: string): ClippingError {
  return new ClippingError(
    "INVALID_CLIP_RANGE",
    `Invalid time ${JSON.stringify(input)}: ${reason}`,
    { userMessage: "Enter a time as seconds, MM:SS.mmm, or HH:MM:SS.mmm." },
  );
}

function secondsToMilliseconds(seconds: number, input: string): number {
  const milliseconds = Math.round(seconds * MILLISECONDS_PER_SECOND);
  if (!Number.isSafeInteger(milliseconds)) {
    throw invalidTime(input, "value is too large");
  }
  return milliseconds;
}

/**
 * Parse seconds, MM:SS(.mmm), or HH:MM:SS(.mmm) into integer milliseconds.
 * The leftmost component may exceed 59; every other minute/second component
 * must be below 60.
 */
export function parseTimeInput(input: string): number {
  const value = input.trim();
  if (!value) throw invalidTime(input, "value is empty");
  if (value.startsWith("-")) throw invalidTime(input, "negative values are not allowed");

  const parts = value.split(":");
  if (parts.length === 1) {
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) {
      throw invalidTime(input, "seconds must be a finite decimal number");
    }
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) throw invalidTime(input, "value must be finite");
    return secondsToMilliseconds(seconds, input);
  }

  if (parts.length !== 2 && parts.length !== 3) {
    throw invalidTime(input, "too many time components");
  }

  const left = parts[0];
  const middle = parts.length === 3 ? parts[1] : undefined;
  const secondsPart = parts[parts.length - 1]!;

  if (!/^\d+$/.test(left)) throw invalidTime(input, "the leftmost component must be an integer");
  if (middle !== undefined && !/^\d+$/.test(middle)) {
    throw invalidTime(input, "minutes must be an integer");
  }
  if (!/^\d+(?:\.\d+)?$/.test(secondsPart)) {
    throw invalidTime(input, "seconds must be numeric");
  }

  const leftValue = Number(left);
  const middleValue = middle === undefined ? 0 : Number(middle);
  const seconds = Number(secondsPart);
  if (![leftValue, middleValue, seconds].every(Number.isFinite)) {
    throw invalidTime(input, "value must be finite");
  }
  if (middle !== undefined && middleValue >= SECONDS_PER_MINUTE) {
    throw invalidTime(input, "minutes must be below 60");
  }
  if (seconds >= SECONDS_PER_MINUTE) {
    throw invalidTime(input, "seconds must be below 60");
  }

  const totalSeconds =
    parts.length === 3
      ? leftValue * MINUTES_PER_HOUR * SECONDS_PER_MINUTE +
        middleValue * SECONDS_PER_MINUTE +
        seconds
      : leftValue * SECONDS_PER_MINUTE + seconds;
  return secondsToMilliseconds(totalSeconds, input);
}

export interface TimeParseResult {
  ok: boolean;
  milliseconds?: number;
  error?: ClippingError;
}

export function tryParseTimeInput(input: string): TimeParseResult {
  try {
    return { ok: true, milliseconds: parseTimeInput(input) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof ClippingError
          ? error
          : new ClippingError("INVALID_CLIP_RANGE", String(error), { cause: error }),
    };
  }
}

function assertMilliseconds(milliseconds: number): void {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new ClippingError(
      "INVALID_CLIP_RANGE",
      "Time must be a non-negative safe integer number of milliseconds",
    );
  }
}

/** Format normalized time as MM:SS.mmm or HH:MM:SS.mmm. */
export function formatTimeMs(milliseconds: number): string {
  assertMilliseconds(milliseconds);

  const totalSeconds = Math.floor(milliseconds / MILLISECONDS_PER_SECOND);
  const millis = milliseconds % MILLISECONDS_PER_SECOND;
  const hours = Math.floor(totalSeconds / (MINUTES_PER_HOUR * SECONDS_PER_MINUTE));
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  const secondText = `${seconds.toString().padStart(2, "0")}.${millis
    .toString()
    .padStart(3, "0")}`;

  if (hours > 0) {
    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${secondText}`;
  }
  return `${minutes.toString().padStart(2, "0")}:${secondText}`;
}

/** A compact, colon-free timestamp suitable for filenames. */
export function formatTimeForFilename(milliseconds: number): string {
  assertMilliseconds(milliseconds);

  const totalSeconds = Math.floor(milliseconds / MILLISECONDS_PER_SECOND);
  const millis = milliseconds % MILLISECONDS_PER_SECOND;
  const hours = Math.floor(totalSeconds / (MINUTES_PER_HOUR * SECONDS_PER_MINUTE));
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
  const seconds = totalSeconds % SECONDS_PER_MINUTE;

  const hourPart = hours > 0 ? `${hours.toString().padStart(2, "0")}h` : "";
  const millisecondPart = millis > 0 ? `${millis.toString().padStart(3, "0")}ms` : "";
  return `${hourPart}${minutes.toString().padStart(2, "0")}m${seconds
    .toString()
    .padStart(2, "0")}s${millisecondPart}`;
}

export const parseTimeToMs = parseTimeInput;
export const formatTime = formatTimeMs;
