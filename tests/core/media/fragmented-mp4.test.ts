import { describe, expect, it } from "vitest";
import {
  inspectSelfContainedFragmentedMp4,
  parseCompleteContentRange,
} from "@/core/media/fragmented-mp4";

function box(type: string, payloadBytes = 0): Uint8Array {
  const bytes = new Uint8Array(8 + payloadBytes);
  new DataView(bytes.buffer).setUint32(0, bytes.byteLength, false);
  for (let index = 0; index < 4; index += 1) {
    bytes[4 + index] = type.charCodeAt(index);
  }
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

describe("fragmented MP4 inspection", () => {
  it("accepts a self-contained ftyp+moov+moof+mdat file", () => {
    const bytes = concat(box("ftyp", 4), box("moov", 8), box("sidx"), box("moof", 12), box("mdat", 100));
    expect(inspectSelfContainedFragmentedMp4(bytes)).toMatchObject({
      complete: true,
      hasFtyp: true,
      hasMoov: true,
      hasMoof: true,
      hasMdat: true,
    });
  });

  it("rejects an ordinary media fragment without embedded initialization", () => {
    expect(inspectSelfContainedFragmentedMp4(concat(box("styp"), box("moof"), box("mdat", 8))))
      .toMatchObject({ complete: false, hasFtyp: false, hasMoov: false });
  });

  it("parses only bounded complete Content-Range headers", () => {
    expect(parseCompleteContentRange("bytes 10-19/20")).toEqual({ start: 10, end: 19, total: 20 });
    expect(parseCompleteContentRange("bytes 10-20/20")).toBeUndefined();
    expect(parseCompleteContentRange("bytes 0-9/*")).toBeUndefined();
  });
});
