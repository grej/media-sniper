import { describe, expect, it } from "vitest";
import {
  parseLevelsPlaylist,
  parseMediaPlaylist,
  parseTimedMediaPlaylist,
  parseHlsMasterDescriptor,
  parseSingleFileFmp4Playlist,
  selectHlsClipVariant,
} from "@/core/parsers/m3u8-parser";

const BASE_URL = "https://cdn.example/path/playlist.m3u8";

function playlist(body: string): string {
  return `#EXTM3U\n#EXT-X-VERSION:7\n${body.trim()}\n`;
}

describe("parseTimedMediaPlaylist", () => {
  it("normalizes constant and variable durations without cumulative rounding drift", () => {
    const parsed = parseTimedMediaPlaylist(
      playlist(`
#EXT-X-MEDIA-SEQUENCE:25
#EXTINF:0.3334,
a.ts
#EXTINF:0.3334,
b.ts
#EXTINF:0.3334,
c.ts
#EXT-X-ENDLIST`),
      BASE_URL,
    );

    expect(parsed.mediaSequence).toBe(25);
    expect(parsed.durationMs).toBe(1_000);
    expect(parsed.segments.map(({ startMs, durationMs, endMs }) => ({
      startMs,
      durationMs,
      endMs,
    }))).toEqual([
      { startMs: 0, durationMs: 333, endMs: 333 },
      { startMs: 333, durationMs: 334, endMs: 667 },
      { startMs: 667, durationMs: 333, endMs: 1_000 },
    ]);
    expect(parsed.segments.map((segment) => segment.sequenceNumber)).toEqual([
      25,
      26,
      27,
    ]);
    expect(parsed.endList).toBe(true);
  });

  it("preserves fMP4 map and media byte ranges", () => {
    const parsed = parseTimedMediaPlaylist(
      playlist(`
#EXT-X-MAP:URI="main.mp4",BYTERANGE="720@0"
#EXTINF:6.006,
#EXT-X-BYTERANGE:100@720
main.mp4
#EXTINF:6.006,
#EXT-X-BYTERANGE:200
main.mp4
#EXT-X-ENDLIST`),
      BASE_URL,
    );

    expect(parsed.segments[0]).toMatchObject({
      uri: "https://cdn.example/path/main.mp4",
      byteRange: { offset: 720, length: 100 },
      init: {
        uri: "https://cdn.example/path/main.mp4",
        byteRange: { offset: 0, length: 720 },
      },
    });
    expect(parsed.segments[1]?.byteRange).toEqual({ offset: 820, length: 200 });
  });

  it("preserves an explicit AES-128 IV as 16 big-endian bytes", () => {
    const parsed = parseTimedMediaPlaylist(
      playlist(`
#EXT-X-MEDIA-SEQUENCE:50
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0000000100000002000000030000002A
#EXTINF:4,
encrypted.ts
#EXT-X-ENDLIST`),
      BASE_URL,
    );

    expect(parsed.segments[0]?.encryption).toMatchObject({
      method: "AES-128",
      keyUri: "https://cdn.example/path/key.bin",
      sequenceNumber: 50,
    });
    expect(Array.from(parsed.segments[0]!.encryption!.explicitIv!)).toEqual([
      0, 0, 0, 1,
      0, 0, 0, 2,
      0, 0, 0, 3,
      0, 0, 0, 42,
    ]);
  });

  it("retains the original sequence for an implicit AES-128 IV", () => {
    const parsed = parseTimedMediaPlaylist(
      playlist(`
#EXT-X-MEDIA-SEQUENCE:7794
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:4,
encrypted-a.ts
#EXTINF:4,
encrypted-b.ts
#EXT-X-ENDLIST`),
      BASE_URL,
    );

    expect(parsed.segments.map((segment) => segment.encryption)).toEqual([
      {
        method: "AES-128",
        keyUri: "https://cdn.example/path/key.bin",
        sequenceNumber: 7794,
      },
      {
        method: "AES-128",
        keyUri: "https://cdn.example/path/key.bin",
        sequenceNumber: 7795,
      },
    ]);
  });

  it("preserves discontinuity sequence on every segment", () => {
    const parsed = parseTimedMediaPlaylist(
      playlist(`
#EXT-X-DISCONTINUITY-SEQUENCE:7
#EXTINF:4,
before.ts
#EXT-X-DISCONTINUITY
#EXTINF:4,
after.ts
#EXT-X-ENDLIST`),
      BASE_URL,
    );

    expect(parsed.discontinuitySequence).toBe(7);
    expect(
      parsed.segments.map((segment) => segment.discontinuitySequence),
    ).toEqual([7, 8]);
  });
});

describe("parseSingleFileFmp4Playlist", () => {
  it("recognizes one contiguous m4s containing the map and every media range", () => {
    const result = parseSingleFileFmp4Playlist(playlist(`
#EXT-X-MAP:URI="loop.m4s",BYTERANGE="24@0"
#EXTINF:1,
#EXT-X-BYTERANGE:10@24
loop.m4s
#EXTINF:1,
#EXT-X-BYTERANGE:12
loop.m4s
#EXT-X-ENDLIST`), BASE_URL);

    expect(result).toEqual({
      url: "https://cdn.example/path/loop.m4s",
      totalLength: 46,
      initRange: { offset: 0, length: 24 },
      mediaRanges: [
        { offset: 24, length: 10 },
        { offset: 34, length: 12 },
      ],
    });
  });

  it("rejects separate init files, gaps, and live playlists", () => {
    expect(parseSingleFileFmp4Playlist(playlist(`
#EXT-X-MAP:URI="init.m4s",BYTERANGE="24@0"
#EXTINF:1,
#EXT-X-BYTERANGE:10@24
media.m4s
#EXT-X-ENDLIST`), BASE_URL)).toBeNull();

    expect(parseSingleFileFmp4Playlist(playlist(`
#EXT-X-MAP:URI="loop.m4s",BYTERANGE="24@0"
#EXTINF:1,
#EXT-X-BYTERANGE:10@30
loop.m4s
#EXT-X-ENDLIST`), BASE_URL)).toBeNull();

    expect(parseSingleFileFmp4Playlist(playlist(`
#EXT-X-MAP:URI="loop.m4s",BYTERANGE="24@0"
#EXTINF:1,
#EXT-X-BYTERANGE:10@24
loop.m4s`), BASE_URL)).toBeNull();
  });
});

describe("legacy parseLevelsPlaylist adapter", () => {
  it("keeps the prior Fragment shape and init insertion behavior", () => {
    const parsed = parseMediaPlaylist(
      playlist(`
#EXT-X-MAP:URI="init.mp4",BYTERANGE="64@0"
#EXTINF:4,
one.m4s
#EXTINF:4,
two.m4s
#EXT-X-ENDLIST`),
      BASE_URL,
    );

    expect(parseLevelsPlaylist(parsed, 9)).toEqual([
      {
        index: 9,
        key: { iv: null, uri: null },
        uri: "https://cdn.example/path/init.mp4",
      },
      {
        index: 10,
        key: { iv: null, uri: null },
        uri: "https://cdn.example/path/one.m4s",
      },
      {
        index: 11,
        key: { iv: null, uri: null },
        uri: "https://cdn.example/path/two.m4s",
      },
    ]);
  });

  it("retains the historical explicit-IV serialization for full downloads", () => {
    const parsed = parseMediaPlaylist(
      playlist(`
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0000000100000002000000030000002A
#EXTINF:4,
encrypted.ts
#EXT-X-ENDLIST`),
      BASE_URL,
    );

    expect(parseLevelsPlaylist(parsed)).toEqual([
      {
        index: 0,
        key: {
          uri: "https://cdn.example/path/key.bin",
          iv: "0102032a",
        },
        uri: "https://cdn.example/path/encrypted.ts",
      },
    ]);
  });
});

describe("HLS clip master selection", () => {
  it("selects audio only from the chosen variant's group", () => {
    const text = playlist(`
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="low-audio",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="low-en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="high-audio",NAME="Commentary",URI="commentary.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="high-audio",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="high-en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,AUDIO="low-audio"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080,AUDIO="high-audio"
high.m3u8`);
    const descriptor = parseHlsMasterDescriptor(text, BASE_URL);
    expect(selectHlsClipVariant(descriptor)).toEqual({
      videoUrl: "https://cdn.example/path/high.m3u8",
      audioUrl: "https://cdn.example/path/high-en.m3u8",
    });
    expect(selectHlsClipVariant(descriptor, 500_000)).toEqual({
      videoUrl: "https://cdn.example/path/low.m3u8",
      audioUrl: "https://cdn.example/path/low-en.m3u8",
    });
  });
});
