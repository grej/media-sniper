import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  HlsFastClipHandler,
  type HlsFastClipHandlerDependencies,
} from "@/core/downloader/hls/hls-fast-clip-handler";
import { VideoFormat } from "@/core/types";
import type { ClipRequest } from "@/core/clipping/types";
import type { AppSettings } from "@/core/storage/settings";
import {
  readClipTrackChunks,
} from "@/core/database/clip-chunks";
import { deriveHlsImplicitIv } from "@/core/downloader/selected-fragment-downloader";

const settings = {
  ffmpegTimeout: 10_000,
  maxConcurrent: 3,
  clipping: {
    maxClipDurationMs: 60_000,
    maxInMemoryClipBytes: 10_000_000,
    directNoRangeMaxBytes: 1_000_000,
    mediabunnyCacheBytes: 64_000,
    mediabunnyParallelism: 2,
    overlayEnabled: false,
    defaultMode: "fast",
  },
  advanced: {
    maxRetries: 1,
    retryDelayMs: 0,
    retryBackoffFactor: 1,
  },
} as AppSettings;

function request(url: string, format = VideoFormat.HLS): ClipRequest {
  return {
    url,
    format,
    clip: {
      startMs: 2_500,
      endMs: 5_500,
      mode: "fast",
      markSource: "manual",
    },
    metadata: {
      url,
      format,
      title: "Fixture clip",
      pageUrl: "https://watch.test/title",
    },
  };
}

const media = (prefix: string, options = "") => `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:100
${options}#EXTINF:2,
${prefix}0.m4s
#EXTINF:2,
${prefix}1.m4s
#EXTINF:2,
${prefix}2.m4s
#EXTINF:2,
${prefix}3.m4s
#EXT-X-ENDLIST
`;

function baseDependencies() {
  let nextRuleId = 10;
  const addRules = vi.fn(async () => [++nextRuleId]);
  const removeRules = vi.fn().mockResolvedValue(undefined);
  const deleteOperationChunks = vi.fn().mockResolvedValue(undefined);
  const save = vi.fn().mockResolvedValue("/Downloads/fixture.mp4");
  return { addRules, removeRules, deleteOperationChunks, save };
}

describe("HlsFastClipHandler", () => {
  it("plans redirected fMP4 media input, fetches only overlap parts, and cleans up", async () => {
    const deps = baseDependencies();
    const downloaded: Array<{ kind: string; urls: string[] }> = [];
    const process = vi.fn().mockResolvedValue({ blobUrl: "blob:clip" });
    const progress = vi.fn();
    const handler = new HlsFastClipHandler({
      ...deps,
      fetchManifest: vi.fn().mockResolvedValue({
        finalUrl: "https://cdn.test/final/index.m3u8",
        text: media("segment-", '#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"\n'),
      }),
      downloadSelected: vi.fn(async (options) => {
        downloaded.push({
          kind: options.trackKind,
          urls: options.parts.map((part) => part.uri),
        });
        options.onProgress?.({
          completedParts: options.parts.length,
          totalParts: options.parts.length,
          downloadedBytes: 300,
          percentage: 100,
        });
        return {
          partCount: options.parts.length,
          downloadedBytes: 300,
          keyRequestCount: 0,
        };
      }),
      process,
    });

    const result = await handler.clip(
      request("https://origin.test/redirect.m3u8", VideoFormat.M3U8),
      "combined_clip",
      settings,
      new AbortController().signal,
      progress,
    );

    expect(downloaded).toEqual([{
      kind: "combined",
      urls: [
        "https://cdn.test/final/init.mp4",
        "https://cdn.test/final/segment-1.m4s",
        "https://cdn.test/final/segment-2.m4s",
      ],
    }]);
    expect(process).toHaveBeenCalledWith(expect.objectContaining({
      payload: {
        mediaFormat: "hls-fmp4",
        inputKind: "combined",
        durationMs: 3_000,
        combinedLength: 3,
        combinedRelativeStartMs: 500,
      },
    }));
    expect(result).toMatchObject({
      mediaFormat: "hls-fmp4",
      selectedVideoParts: 3,
      selectedAudioParts: 0,
      requestedDurationMs: 3_000,
    });
    expect(deps.deleteOperationChunks).toHaveBeenCalledWith("combined_clip");
    expect(deps.removeRules).toHaveBeenCalledWith([11, 12]);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "downloading", percentage: 75 }),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "saving", percentage: 98 }),
    );
  });

  it("selects highest master variant and its associated audio group independently", async () => {
    const deps = baseDependencies();
    const fetched: string[] = [];
    const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="low-audio",NAME="Low",DEFAULT=YES,URI="low/audio.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="high-audio",NAME="High",DEFAULT=YES,URI="high/audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=500000,AUDIO="low-audio"
low/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,AUDIO="high-audio"
high/video.m3u8
`;
    const fetchManifest: NonNullable<HlsFastClipHandlerDependencies["fetchManifest"]> =
      vi.fn(async (url) => {
        fetched.push(url);
        if (url.endsWith("master.m3u8")) {
          return { text: master, finalUrl: "https://cdn.test/root/master.m3u8" };
        }
        if (url.includes("high/video")) {
          return {
            text: media("v-"),
            finalUrl: "https://video-cdn.test/resolved/index.m3u8",
          };
        }
        if (url.includes("high/audio")) {
          return {
            text: media("a-"),
            finalUrl: "https://audio-cdn.test/resolved/index.m3u8",
          };
        }
        throw new Error(`Unexpected manifest ${url}`);
      });
    const downloaded: Record<string, string[]> = {};
    const process = vi.fn().mockResolvedValue({ blobUrl: "blob:clip" });
    const handler = new HlsFastClipHandler({
      ...deps,
      fetchManifest,
      downloadSelected: vi.fn(async (options) => {
        downloaded[options.trackKind] = options.parts.map((part) => part.uri);
        return {
          partCount: options.parts.length,
          downloadedBytes: options.parts.length,
          keyRequestCount: 0,
        };
      }),
      process,
    });

    const result = await handler.clip(
      request("https://origin.test/master.m3u8"),
      "separate_clip",
      settings,
      new AbortController().signal,
    );

    expect(fetched).toEqual([
      "https://origin.test/master.m3u8",
      "https://cdn.test/root/high/video.m3u8",
      "https://cdn.test/root/high/audio.m3u8",
    ]);
    expect(downloaded.video).toEqual([
      "https://video-cdn.test/resolved/v-1.m4s",
      "https://video-cdn.test/resolved/v-2.m4s",
    ]);
    expect(downloaded.audio).toEqual([
      "https://audio-cdn.test/resolved/a-1.m4s",
      "https://audio-cdn.test/resolved/a-2.m4s",
    ]);
    expect(process).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        mediaFormat: "hls-ts",
        inputKind: "separate",
        videoLength: 2,
        audioLength: 2,
        videoRelativeStartMs: 500,
        audioRelativeStartMs: 500,
      }),
    }));
    expect(result.selectedVideoPlaylistUrl).toBe(
      "https://video-cdn.test/resolved/index.m3u8",
    );
    expect(result.selectedAudioPlaylistUrl).toBe(
      "https://audio-cdn.test/resolved/index.m3u8",
    );
  });

  it("uses the exact explicit variant object to associate duplicate-bandwidth audio", async () => {
    const deps = baseDependencies();
    const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="first",NAME="First",DEFAULT=YES,URI="first.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="second",NAME="Second",DEFAULT=YES,URI="second.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="first"
first-video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="second"
second-video.m3u8
`;
    const fetched: string[] = [];
    const handler = new HlsFastClipHandler({
      ...deps,
      fetchManifest: vi.fn(async (url) => {
        fetched.push(url);
        return url.endsWith("master.m3u8")
          ? { text: master, finalUrl: "https://cdn.test/master.m3u8" }
          : { text: media("s-"), finalUrl: url };
      }),
      downloadSelected: vi.fn(async (options) => ({
        partCount: options.parts.length,
        downloadedBytes: 1,
        keyRequestCount: 0,
      })),
      process: vi.fn().mockResolvedValue({ blobUrl: "blob:clip" }),
    });
    const explicit = request("https://origin.test/master.m3u8");
    explicit.manifestQuality = {
      videoPlaylistUrl: "https://cdn.test/second-video.m3u8",
    };

    await handler.clip(
      explicit,
      "explicit_clip",
      settings,
      new AbortController().signal,
    );
    expect(fetched).toContain("https://cdn.test/second.m3u8");
    expect(fetched).not.toContain("https://cdn.test/first.m3u8");
  });

  it("refuses discontinuity crossings with a stable clipping code and still cleans", async () => {
    const deps = baseDependencies();
    const discontinuous = `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXTINF:2,
0.ts
#EXTINF:2,
1.ts
#EXT-X-DISCONTINUITY
#EXTINF:2,
2.ts
#EXTINF:2,
3.ts
#EXT-X-ENDLIST
`;
    const handler = new HlsFastClipHandler({
      ...deps,
      fetchManifest: vi.fn().mockResolvedValue({
        text: discontinuous,
        finalUrl: "https://cdn.test/index.m3u8",
      }),
      downloadSelected: vi.fn(),
      process: vi.fn(),
    });

    await expect(
      handler.clip(
        request("https://cdn.test/index.m3u8", VideoFormat.M3U8),
        "discontinuous_clip",
        settings,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "HLS_DISCONTINUITY_UNSUPPORTED" });
    expect(deps.deleteOperationChunks).toHaveBeenCalled();
    expect(deps.removeRules).toHaveBeenCalled();
  });

  it("maps DRM and live playlists to stable clipping errors", async () => {
    const deps = baseDependencies();
    const handler = new HlsFastClipHandler({
      ...deps,
      fetchManifest: vi.fn().mockResolvedValue({
        text: `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://license"
#EXTINF:2,
0.ts
#EXT-X-ENDLIST`,
        finalUrl: "https://cdn.test/index.m3u8",
      }),
    });
    await expect(
      handler.clip(
        request("https://cdn.test/index.m3u8"),
        "drm_clip",
        settings,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "DRM_PROTECTED" });

    const live = new HlsFastClipHandler({
      ...baseDependencies(),
      fetchManifest: vi.fn().mockResolvedValue({
        text: `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n0.ts\n`,
        finalUrl: "https://cdn.test/live.m3u8",
      }),
    });
    await expect(
      live.clip(
        request("https://cdn.test/live.m3u8"),
        "live_clip",
        settings,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "NO_TIMELINE" });
  });

  it("cancels active selected-track work and performs operation cleanup", async () => {
    const deps = baseDependencies();
    const controller = new AbortController();
    const process = vi.fn();
    const handler = new HlsFastClipHandler({
      ...deps,
      fetchManifest: vi.fn().mockResolvedValue({
        text: media("segment-"),
        finalUrl: "https://cdn.test/index.m3u8",
      }),
      downloadSelected: vi.fn(async (options) =>
        new Promise((_, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
          controller.abort();
        }),
      ),
      process,
    });

    await expect(
      handler.clip(
        request("https://cdn.test/index.m3u8"),
        "cancelled_clip",
        settings,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "CancellationError" });
    expect(process).not.toHaveBeenCalled();
    expect(deps.deleteOperationChunks).toHaveBeenCalledWith("cancelled_clip");
    expect(deps.removeRules).toHaveBeenCalled();
  });
});

describe("HLS Fast local fixture server", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    server = undefined;
  });

  it("requests only selected AES video and byte-range audio parts", async ({ skip }) => {
    const keyBytes = new Uint8Array(16).fill(9);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      "AES-CBC",
      false,
      ["encrypt"],
    );
    const plaintext = [0, 1, 2, 3].map((index) =>
      new TextEncoder().encode(`video-${index}`),
    );
    const encrypted = await Promise.all(
      plaintext.map((bytes, index) =>
        crypto.subtle.encrypt(
          { name: "AES-CBC", iv: deriveHlsImplicitIv(100 + index) },
          cryptoKey,
          bytes,
        ),
      ),
    );
    const audioBytes = new TextEncoder().encode("aaaabbbbccccdddd");
    const requests: Array<{ path: string; range?: string }> = [];
    const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="low",NAME="Low",DEFAULT=YES,URI="/low/audio.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="high",NAME="High",DEFAULT=YES,URI="/audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=500000,AUDIO="low"
/low/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="high"
/video.m3u8
`;
    const videoPlaylist = `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:2,
v0.ts
#EXTINF:2,
v1.ts
#EXTINF:2,
v2.ts
#EXTINF:2,
v3.ts
#EXT-X-ENDLIST
`;
    const audioPlaylist = `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-BYTERANGE:4@0
#EXTINF:2,
audio.bin
#EXT-X-BYTERANGE:4@4
#EXTINF:2,
audio.bin
#EXT-X-BYTERANGE:4@8
#EXTINF:2,
audio.bin
#EXT-X-BYTERANGE:4@12
#EXTINF:2,
audio.bin
#EXT-X-ENDLIST
`;

    server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture").pathname;
      requests.push({ path, range: req.headers.range });
      if (path === "/master.m3u8") return void res.end(master);
      if (path === "/video.m3u8") {
        res.statusCode = 302;
        res.setHeader("Location", "/final/video/index.m3u8");
        return void res.end();
      }
      if (path === "/audio.m3u8") {
        res.statusCode = 302;
        res.setHeader("Location", "/final/audio/index.m3u8");
        return void res.end();
      }
      if (path === "/final/video/index.m3u8") return void res.end(videoPlaylist);
      if (path === "/final/audio/index.m3u8") return void res.end(audioPlaylist);
      if (path === "/final/video/key.bin") return void res.end(Buffer.from(keyBytes));
      const videoMatch = path.match(/^\/final\/video\/v(\d)\.ts$/);
      if (videoMatch) return void res.end(Buffer.from(encrypted[Number(videoMatch[1])]!));
      if (path === "/final/audio/audio.bin") {
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
        if (!range) return void res.end(Buffer.from(audioBytes));
        const start = Number(range[1]);
        const end = Number(range[2]);
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${audioBytes.length}`);
        return void res.end(Buffer.from(audioBytes.slice(start, end + 1)));
      }
      res.statusCode = 404;
      return void res.end("missing");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server!.once("error", onError);
        server!.listen(0, "127.0.0.1", () => {
          server!.removeListener("error", onError);
          resolve();
        });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        skip("Loopback fixture servers are not permitted in this sandbox");
        return;
      }
      throw error;
    }
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    let observedPayload: unknown;
    const addRules = vi.fn().mockResolvedValue([31]);
    const removeRules = vi.fn().mockResolvedValue(undefined);
    const handler = new HlsFastClipHandler({
      fetchManifest: async (url, options) => {
        const response = await fetch(url, { signal: options.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return { text: await response.text(), finalUrl: response.url };
      },
      addRules,
      removeRules,
      process: async (job) => {
        observedPayload = job.payload;
        const videoChunks = await readClipTrackChunks(job.operationId, "video");
        const audioChunks = await readClipTrackChunks(job.operationId, "audio");
        expect(videoChunks.map((chunk) => new TextDecoder().decode(chunk))).toEqual([
          "video-1",
          "video-2",
        ]);
        expect(audioChunks.map((chunk) => new TextDecoder().decode(chunk))).toEqual([
          "bbbb",
          "cccc",
        ]);
        return { blobUrl: "blob:fixture" };
      },
      save: vi.fn().mockResolvedValue("/Downloads/fixture.mp4"),
    });

    const result = await handler.clip(
      request(`${origin}/master.m3u8`),
      "fixture_server_clip",
      settings,
      new AbortController().signal,
    );

    expect(observedPayload).toMatchObject({
      mediaFormat: "hls-ts",
      inputKind: "separate",
      durationMs: 3_000,
      videoLength: 2,
      audioLength: 2,
      videoRelativeStartMs: 500,
      audioRelativeStartMs: 500,
    });
    expect(result.downloadedBytes).toBeGreaterThan(0);
    const mediaRequests = requests.filter(({ path }) =>
      path.endsWith(".ts") || path.endsWith("audio.bin"),
    );
    expect(
      mediaRequests
        .map(({ path, range }) => `${path}|${range ?? ""}`)
        .sort(),
    ).toEqual([
      "/final/audio/audio.bin|bytes=4-7",
      "/final/audio/audio.bin|bytes=8-11",
      "/final/video/v1.ts|",
      "/final/video/v2.ts|",
    ]);
    expect(requests.some(({ path }) => path.includes("/low/"))).toBe(false);
    expect(await readClipTrackChunks("fixture_server_clip", "video")).toEqual([]);
    expect(await readClipTrackChunks("fixture_server_clip", "audio")).toEqual([]);
    expect(removeRules).toHaveBeenCalledWith([31]);
    const resourceScope = addRules.mock.calls.at(-1)?.[0] as { urls: string[] };
    expect(resourceScope.urls.some((url) => url.endsWith("v0.ts"))).toBe(false);
    expect(resourceScope.urls.some((url) => url.endsWith("v3.ts"))).toBe(false);
  });
});
