import { describe, expect, it } from "vitest";
import {
  generateClipFilename,
  sanitizeClipFilenamePart,
} from "@/core/clipping/filename";

describe("clip filename", () => {
  it("includes a deterministic range and quality", () => {
    expect(
      generateClipFilename({
        title: "Lecture",
        startMs: 363_000,
        endMs: 382_000,
        quality: "1080p",
      }),
    ).toBe("Lecture_06m03s-06m22s_1080p.mp4");
  });

  it("removes filesystem-unsafe and invisible content", () => {
    const filename = generateClipFilename({
      title: "  A:/\\*?  lesson\u202E  ",
      startMs: 1_250,
      endMs: 2_500,
      quality: "1920 x 1080",
    });
    expect(filename).toBe(
      "A_lesson_00m01s250ms-00m02s500ms_1920_x_1080.mp4",
    );
    expect(filename).not.toMatch(/[<>:"/\\|?*]/);
  });

  it("preserves a supplied base name but enforces the output extension", () => {
    expect(
      generateClipFilename({
        suppliedFilename: "folder/My clip.webm",
        startMs: 0,
        endMs: 1_000,
      }),
    ).toBe("My_clip.mp4");
  });

  it("caps the base name while retaining the range suffix", () => {
    const filename = generateClipFilename({
      title: "x".repeat(300),
      startMs: 0,
      endMs: 1_000,
      maxBaseLength: 40,
    });
    const base = filename.slice(0, -4);
    expect(base).toHaveLength(40);
    expect(base.endsWith("_00m00s-00m01s")).toBe(true);
  });

  it("guards reserved Windows device names", () => {
    expect(sanitizeClipFilenamePart("CON")).toBe("_CON");
  });

  it("uses deterministic fallbacks for empty title and supplied base", () => {
    expect(
      generateClipFilename({ title: "", startMs: 0, endMs: 1_000 }),
    ).toBe("clip_00m00s-00m01s.mp4");
    expect(
      generateClipFilename({
        suppliedFilename: "...",
        startMs: 0,
        endMs: 1_000,
      }),
    ).toBe("clip.mp4");
  });

  it("rejects invalid ranges and output extensions", () => {
    expect(() =>
      generateClipFilename({ title: "x", startMs: 1, endMs: 1 }),
    ).toThrow();
    expect(() =>
      generateClipFilename({
        title: "x",
        startMs: 0,
        endMs: 1_000,
        outputContainer: "../mp4",
      }),
    ).toThrow(TypeError);
    expect(() =>
      generateClipFilename({
        title: "x",
        startMs: 0,
        endMs: 1_000,
        maxBaseLength: 15,
      }),
    ).toThrow(TypeError);
  });
});
