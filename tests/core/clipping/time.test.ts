import { describe, expect, it } from "vitest";
import {
  formatTimeForFilename,
  formatClockTimeMs,
  formatTimeMs,
  parseTimeInput,
  tryParseTimeInput,
} from "@/core/clipping/time";

describe("clip time parsing", () => {
  it.each([
    ["75.25", 75_250],
    ["75", 75_000],
    [".5", 500],
    ["01:15.250", 75_250],
    ["60:00", 3_600_000],
    ["1:02:03.500", 3_723_500],
    [" 00:00.000 ", 0],
    ["0.0006", 1],
  ])("parses %s as %i milliseconds", (input, expected) => {
    expect(parseTimeInput(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "-1",
    "Infinity",
    "NaN",
    "1e3",
    "1:60",
    "1:60:00",
    "1:02:60",
    "1:2:3:4",
    "1::02",
    "1:abc",
    "abc",
  ])("rejects invalid input %j", (input) => {
    expect(() => parseTimeInput(input)).toThrow();
    expect(tryParseTimeInput(input)).toMatchObject({ ok: false });
  });

  it("rejects values that cannot be represented as safe integer milliseconds", () => {
    expect(() => parseTimeInput("999999999999999999999")).toThrow("too large");
    expect(() => parseTimeInput(`${"9".repeat(400)}:00`)).toThrow("finite");
  });
});

describe("clip time formatting", () => {
  it.each([
    [0, "00:00.000"],
    [75_250, "01:15.250"],
    [3_599_999, "59:59.999"],
    [3_600_000, "01:00:00.000"],
    [3_723_500, "01:02:03.500"],
  ])("formats %i as %s", (milliseconds, expected) => {
    expect(formatTimeMs(milliseconds)).toBe(expected);
    expect(parseTimeInput(expected)).toBe(milliseconds);
  });

  it("formats colon-free filename timestamps", () => {
    expect(formatTimeForFilename(363_000)).toBe("06m03s");
    expect(formatTimeForFilename(3_723_500)).toBe("01h02m03s500ms");
  });

  it("formats a fixed-width UI clock with three millisecond digits", () => {
    expect(formatClockTimeMs(0)).toBe("00:00:00.000");
    expect(formatClockTimeMs(75_250)).toBe("00:01:15.250");
    expect(formatClockTimeMs(3_723_500)).toBe("01:02:03.500");
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects non-integer millisecond value %s",
    (milliseconds) => {
      expect(() => formatTimeMs(milliseconds)).toThrow();
    },
  );
});
