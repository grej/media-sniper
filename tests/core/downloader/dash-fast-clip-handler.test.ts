import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DashFastClipHandler,
  type DashFastClipHandlerDependencies,
} from "@/core/downloader/dash/dash-fast-clip-handler";
import { parseTimedDashTracks } from "@/core/parsers/mpd-parser";
import { VideoFormat } from "@/core/types";
import type { ClipRequest } from "@/core/clipping/types";
import type { AppSettings } from "@/core/storage/settings";
import {
  readClipTrackChunks,
  type ClipTrackKind,
} from "@/core/database/clip-chunks";

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

const STATIC_MPD = `
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     type="static" mediaPresentationDuration="PT12S">
  <Period id="main" start="PT0S">
    <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e">
      <SegmentTemplate timescale="1000"
          initialization="$RepresentationID$-init.mp4"
          media="$RepresentationID$-$Number$.m4s" startNumber="1">
        <SegmentTimeline><S t="9000" d="4000" r="2" /></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="v-low" bandwidth="500000" width="640" height="360">
        <SegmentTemplate presentationTimeOffset="9000" />
      </Representation>
      <Representation id="v-high" bandwidth="1500000" width="1280" height="720">
        <SegmentTemplate presentationTimeOffset="9000" />
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2" lang="en">
      <SegmentTemplate timescale="1000"
          initialization="$RepresentationID$-init.mp4"
          media="$RepresentationID$-$Number$.m4s" startNumber="1">
        <SegmentTimeline><S t="6000" d="3000" r="3" /></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="a-main" bandwidth="128000">
        <SegmentTemplate presentationTimeOffset="6000" />
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const MULTI_PERIOD_MPD = `
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     type="static" mediaPresentationDuration="PT8S">
  <Period id="first" start="PT0S" duration="PT4S">
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v1" bandwidth="1000">
        <SegmentTemplate timescale="1" duration="2"
            initialization="first-init.mp4" media="first-$Number$.m4s" />
      </Representation>
    </AdaptationSet>
  </Period>
  <Period id="second" start="PT4S" duration="PT4S">
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v1" bandwidth="1000">
        <SegmentTemplate timescale="1" duration="2"
            initialization="second-init.mp4" media="second-$Number$.m4s" />
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const MISSING_TIMING_MPD = `
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <Period start="PT0S">
    <AdaptationSet mimeType="video/mp4">
      <Representation id="broken" bandwidth="1000">
        <SegmentTemplate initialization="init.mp4" media="$Number$.m4s" />
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const RANGED_MPD = `
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     type="static" mediaPresentationDuration="PT8S">
  <Period start="PT0S">
    <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e,mp4a.40.2">
      <Representation id="range-combined" bandwidth="1000">
        <BaseURL>combined.mp4</BaseURL>
        <SegmentList timescale="1" duration="4">
          <Initialization sourceURL="combined.mp4" range="0-3" />
          <SegmentURL media="combined.mp4" mediaRange="4-7" />
          <SegmentURL media="combined.mp4" mediaRange="8-13" />
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

function request(url: string): ClipRequest {
  return {
    url,
    format: VideoFormat.DASH,
    clip: {
      startMs: 4_500,
      endMs: 7_500,
      mode: "fast",
      markSource: "manual",
    },
    metadata: {
      url,
      format: VideoFormat.DASH,
      title: "DASH fixture clip",
      pageUrl: "https://watch.test/title",
    },
  };
}

function baseDependencies() {
  let nextRuleId = 20;
  const addRules = vi.fn(async () => [++nextRuleId]);
  const removeRules = vi.fn().mockResolvedValue(undefined);
  const deleteOperationChunks = vi.fn().mockResolvedValue(undefined);
  const save = vi.fn().mockResolvedValue("/Downloads/dash-fixture.mp4");
  return { addRules, removeRules, deleteOperationChunks, save };
}

describe("DashFastClipHandler", () => {
  it("forwards quality selection and builds independent init/media plans with sync offsets", async () => {
    const deps = baseDependencies();
    const parseTracks = vi.fn(parseTimedDashTracks);
    const downloaded: Record<string, string[]> = {};
    const process = vi.fn().mockResolvedValue({ blobUrl: "blob:dash" });
    const handler = new DashFastClipHandler({
      ...deps,
      fetchManifest: vi.fn().mockResolvedValue({
        text: STATIC_MPD,
        finalUrl: "https://edge.test/final/manifest.mpd",
      }),
      parseTracks,
      downloadSelected: vi.fn(async (options) => {
        downloaded[options.trackKind] = options.parts.map((part) => part.uri);
        options.onProgress?.({
          completedParts: options.parts.length,
          totalParts: options.parts.length,
          downloadedBytes: options.parts.length,
          percentage: 100,
        });
        return {
          partCount: options.parts.length,
          downloadedBytes: options.parts.length,
          keyRequestCount: 0,
        };
      }),
      process,
    });
    const clipRequest = request("https://origin.test/redirect.mpd");
    clipRequest.manifestQuality = {
      representationId: "v-low",
      selectedBandwidth: 1_500_000,
    };

    const result = await handler.clip(
      clipRequest,
      "dash_separate",
      settings,
      new AbortController().signal,
    );

    expect(parseTracks).toHaveBeenCalledWith(
      STATIC_MPD,
      "https://edge.test/final/manifest.mpd",
      {
        videoBandwidth: 1_500_000,
        videoRepresentationId: "v-low",
      },
    );
    expect(downloaded).toEqual({
      video: [
        "https://edge.test/final/v-low-init.mp4",
        "https://edge.test/final/v-low-2.m4s",
      ],
      audio: [
        "https://edge.test/final/a-main-init.mp4",
        "https://edge.test/final/a-main-2.m4s",
        "https://edge.test/final/a-main-3.m4s",
      ],
    });
    expect(process).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          mediaFormat: "dash-fmp4",
          inputKind: "separate",
          durationMs: 3_000,
          videoLength: 2,
          audioLength: 3,
          videoRelativeStartMs: 500,
          audioRelativeStartMs: 1_500,
        },
      }),
    );
    expect(result).toMatchObject({
      accuracy: "keyframe-aligned",
      inputKind: "separate",
      videoRepresentationId: "v-low",
      audioRepresentationId: "a-main",
      selectedVideoParts: 2,
      selectedAudioParts: 3,
      requestedDurationMs: 3_000,
      downloadedBytes: 5,
    });
    expect(deps.deleteOperationChunks).toHaveBeenCalledWith("dash_separate");
    expect(deps.removeRules).toHaveBeenCalledWith([21, 22]);
    const resourceScope = deps.addRules.mock.calls[1]?.[0] as {
      urls: string[];
    };
    expect(resourceScope.urls).not.toContain(
      "https://edge.test/final/v-high-2.m4s",
    );
    expect(resourceScope.urls).not.toContain(
      "https://edge.test/final/v-low-1.m4s",
    );
  });

  it("routes Exact DASH with independent padded windows and measured duration", async () => {
    const deps = baseDependencies();
    const process = vi.fn();
    const processExact = vi.fn().mockResolvedValue({
      blobUrl: "blob:dash-exact",
      size: 8_000,
      accuracy: "exact",
      actualDurationMs: 3_018,
    });
    const downloaded: Record<string, string[]> = {};
    const handler = new DashFastClipHandler({
      ...deps,
      fetchManifest: vi.fn().mockResolvedValue({
        text: STATIC_MPD,
        finalUrl: "https://edge.test/final/manifest.mpd",
      }),
      downloadSelected: vi.fn(async (options) => {
        downloaded[options.trackKind] = options.parts.map((part) => part.uri);
        return {
          partCount: options.parts.length,
          downloadedBytes: options.parts.length,
          keyRequestCount: 0,
        };
      }),
      process,
      processExact,
    });
    const exact = request("https://origin.test/manifest.mpd");
    exact.clip.mode = "exact";
    exact.manifestQuality = { representationId: "v-low" };

    const result = await handler.clip(
      exact,
      "dash_exact",
      settings,
      new AbortController().signal,
    );

    expect(downloaded.video).toEqual([
      "https://edge.test/final/v-low-init.mp4",
      "https://edge.test/final/v-low-1.m4s",
      "https://edge.test/final/v-low-2.m4s",
    ]);
    expect(downloaded.audio).toEqual([
      "https://edge.test/final/a-main-init.mp4",
      "https://edge.test/final/a-main-1.m4s",
      "https://edge.test/final/a-main-2.m4s",
      "https://edge.test/final/a-main-3.m4s",
    ]);
    expect(process).not.toHaveBeenCalled();
    expect(processExact).toHaveBeenCalledWith(expect.objectContaining({
      payload: {
        mediaFormat: "dash-fmp4",
        inputKind: "separate",
        durationMs: 3_000,
        videoLength: 3,
        audioLength: 4,
        videoRelativeStartMs: 4_500,
        audioRelativeStartMs: 4_500,
        maxOutputBytes: 10_000_000,
      },
    }));
    expect(result).toMatchObject({
      accuracy: "exact",
      actualDurationMs: 3_018,
      requestedDurationMs: 3_000,
    });
  });

  it("uses the real selected downloader without requesting unselected segments", async () => {
    const requested: string[] = [];
    let observedPayload: unknown;
    const fetchMedia = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      return new Response(new TextEncoder().encode(new URL(url).pathname));
    }) as typeof fetch;
    const addRules = vi.fn().mockResolvedValue([31]);
    const removeRules = vi.fn().mockResolvedValue(undefined);
    const handler = new DashFastClipHandler({
      fetchManifest: vi.fn().mockResolvedValue({
        text: STATIC_MPD,
        finalUrl: "https://media.test/final/manifest.mpd",
      }),
      fetchMedia,
      addRules,
      removeRules,
      process: async (job) => {
        observedPayload = job.payload;
        const video = await readClipTrackChunks(job.operationId, "video");
        const audio = await readClipTrackChunks(job.operationId, "audio");
        expect(video.map((part) => new TextDecoder().decode(part))).toEqual([
          "/final/v-low-init.mp4",
          "/final/v-low-2.m4s",
        ]);
        expect(audio.map((part) => new TextDecoder().decode(part))).toEqual([
          "/final/a-main-init.mp4",
          "/final/a-main-2.m4s",
          "/final/a-main-3.m4s",
        ]);
        return { blobUrl: "blob:real-selected" };
      },
      save: vi.fn().mockResolvedValue("/Downloads/selected.mp4"),
    });
    const clipRequest = request("https://origin.test/manifest.mpd");
    clipRequest.manifestQuality = { selectedBandwidth: 500_000 };

    await handler.clip(
      clipRequest,
      "dash_real_selected",
      settings,
      new AbortController().signal,
    );

    expect(requested.sort()).toEqual([
      "https://media.test/final/a-main-2.m4s",
      "https://media.test/final/a-main-3.m4s",
      "https://media.test/final/a-main-init.mp4",
      "https://media.test/final/v-low-2.m4s",
      "https://media.test/final/v-low-init.mp4",
    ]);
    expect(requested.some((url) => url.includes("v-high"))).toBe(false);
    expect(requested.some((url) => url.endsWith("v-low-1.m4s"))).toBe(false);
    expect(requested.some((url) => url.endsWith("v-low-3.m4s"))).toBe(false);
    expect(observedPayload).toMatchObject({
      inputKind: "separate",
      videoRelativeStartMs: 500,
      audioRelativeStartMs: 1_500,
    });
    expect(await readClipTrackChunks("dash_real_selected", "video")).toEqual(
      [],
    );
    expect(await readClipTrackChunks("dash_real_selected", "audio")).toEqual(
      [],
    );
    expect(removeRules).toHaveBeenCalledWith([31]);
  });

  it("preserves selected initialization and media byte ranges end to end", async () => {
    const requested: Array<{ url: string; range: string | null }> = [];
    const source = new Uint8Array([
      10, 11, 12, 13,
      20, 21, 22, 23,
      30, 31, 32, 33, 34, 35,
    ]);
    const fetchMedia = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const range = new Headers(init?.headers).get("Range");
        requested.push({ url, range });
        const match = range?.match(/^bytes=(\d+)-(\d+)$/);
        if (!match) return new Response(source);
        const start = Number(match[1]);
        const end = Number(match[2]);
        return new Response(source.slice(start, end + 1), {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${end}/${source.length}`,
          },
        });
      },
    ) as typeof fetch;
    let observedPayload: unknown;
    const handler = new DashFastClipHandler({
      fetchManifest: vi.fn().mockResolvedValue({
        text: RANGED_MPD,
        finalUrl: "https://range.test/final/manifest.mpd",
      }),
      fetchMedia,
      addRules: vi.fn().mockResolvedValue([51]),
      removeRules: vi.fn().mockResolvedValue(undefined),
      process: async (job) => {
        observedPayload = job.payload;
        const combined = await readClipTrackChunks(
          job.operationId,
          "combined",
        );
        expect(combined.map((part) => [...new Uint8Array(part)])).toEqual([
          [10, 11, 12, 13],
          [30, 31, 32, 33, 34, 35],
        ]);
        return { blobUrl: "blob:ranged" };
      },
      save: vi.fn().mockResolvedValue("/Downloads/ranged.mp4"),
    });

    const result = await handler.clip(
      request("https://range.test/manifest.mpd"),
      "dash_ranged",
      settings,
      new AbortController().signal,
    );

    expect(requested).toEqual([
      {
        url: "https://range.test/final/combined.mp4",
        range: "bytes=0-3",
      },
      {
        url: "https://range.test/final/combined.mp4",
        range: "bytes=8-13",
      },
    ]);
    expect(observedPayload).toEqual({
      mediaFormat: "dash-fmp4",
      inputKind: "combined",
      durationMs: 3_000,
      combinedLength: 2,
      combinedRelativeStartMs: 500,
    });
    expect(result).toMatchObject({
      inputKind: "combined",
      selectedVideoParts: 2,
      selectedAudioParts: 0,
      downloadedBytes: 10,
    });
    expect(requested.some(({ range }) => range === "bytes=4-7")).toBe(false);
    for (const kind of [
      "combined",
      "video",
      "audio",
      "init",
    ] as ClipTrackKind[]) {
      expect(await readClipTrackChunks("dash_ranged", kind)).toEqual([]);
    }
  });

  it.each([
    {
      name: "DRM",
      text: STATIC_MPD.replace(
        '<AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e">',
        '<AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e"><ContentProtection schemeIdUri="urn:uuid:test" />',
      ),
      code: "DRM_PROTECTED",
      detail: "DASH_DRM_PROTECTED",
    },
    {
      name: "dynamic manifests",
      text: STATIC_MPD.replace('type="static"', 'type="dynamic"'),
      code: "NO_TIMELINE",
      detail: "DASH_DYNAMIC_UNSUPPORTED",
    },
    {
      name: "missing timing",
      text: MISSING_TIMING_MPD,
      code: "NO_TIMELINE",
      detail: "DASH_TIMING_UNAVAILABLE",
    },
    {
      name: "multi-Period crossings",
      text: MULTI_PERIOD_MPD,
      code: "UNSUPPORTED_MULTI_PERIOD_DASH",
      detail: "DASH_CLIP_CROSSES_PERIODS",
    },
  ])(
    "refuses $name before media fetch and still performs all cleanup",
    async ({ text, code, detail }) => {
      const deps = baseDependencies();
      const fetchMedia = vi.fn() as typeof fetch;
      const process = vi.fn();
      const handler = new DashFastClipHandler({
        ...deps,
        fetchManifest: vi.fn().mockResolvedValue({
          text,
          finalUrl: "https://cdn.test/final/manifest.mpd",
        }),
        fetchMedia,
        process,
      });
      const clipRequest = request("https://cdn.test/manifest.mpd");
      if (code === "UNSUPPORTED_MULTI_PERIOD_DASH") {
        clipRequest.clip = {
          ...clipRequest.clip,
          startMs: 3_000,
          endMs: 5_000,
        };
      }

      await expect(
        handler.clip(
          clipRequest,
          `dash_refusal_${code}`,
          settings,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code, detail });
      expect(fetchMedia).not.toHaveBeenCalled();
      expect(process).not.toHaveBeenCalled();
      expect(deps.deleteOperationChunks).toHaveBeenCalledOnce();
      expect(deps.removeRules).toHaveBeenCalledWith([21]);
    },
  );

  it("cancels active selected requests and cleans operation state", async () => {
    const deps = baseDependencies();
    let mediaStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      mediaStarted = resolve;
    });
    const fetchMedia = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        mediaStarted();
        return new Promise<Response>((_resolve, reject) => {
          const rejectAborted = () =>
            reject(new DOMException("Aborted", "AbortError"));
          init?.signal?.addEventListener("abort", rejectAborted, {
            once: true,
          });
          if (init?.signal?.aborted) rejectAborted();
        });
      },
    ) as typeof fetch;
    const process = vi.fn();
    const handler = new DashFastClipHandler({
      ...deps,
      fetchManifest: vi.fn().mockResolvedValue({
        text: STATIC_MPD,
        finalUrl: "https://cdn.test/final/manifest.mpd",
      }),
      fetchMedia,
      process,
    });
    const controller = new AbortController();
    const clipping = handler.clip(
      request("https://cdn.test/manifest.mpd"),
      "dash_cancelled",
      settings,
      controller.signal,
    );
    await started;
    controller.abort();

    await expect(clipping).rejects.toMatchObject({
      name: "CancellationError",
      code: "CANCELLATION_ERROR",
    });
    expect(process).not.toHaveBeenCalled();
    expect(deps.deleteOperationChunks).toHaveBeenCalledWith("dash_cancelled");
    expect(deps.removeRules).toHaveBeenCalledWith([21, 22]);
  });
});

describe("DASH Fast local fixture server", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    server = undefined;
  });

  it("requests only the selected representation/window and preserves byte-range tracks", async ({
    skip,
  }) => {
    const requests: Array<{ path: string; range?: string }> = [];
    const audioBytes = Buffer.from("INITAAAABBBBCCCC");
    const manifest = `
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     type="static" mediaPresentationDuration="PT9S">
  <Period start="PT0S">
    <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e">
      <SegmentTemplate timescale="1" duration="2" startNumber="1"
          initialization="$RepresentationID$-init.mp4"
          media="$RepresentationID$-$Number$.m4s" />
      <Representation id="v-low" bandwidth="500000" />
      <Representation id="v-high" bandwidth="1500000" />
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2" lang="en">
      <Representation id="a-main" bandwidth="128000">
        <BaseURL>audio.bin</BaseURL>
        <SegmentList timescale="1" duration="3">
          <Initialization sourceURL="audio.bin" range="0-3" />
          <SegmentURL media="audio.bin" mediaRange="4-7" />
          <SegmentURL media="audio.bin" mediaRange="8-11" />
          <SegmentURL media="audio.bin" mediaRange="12-15" />
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

    server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture").pathname;
      requests.push({ path, range: req.headers.range });
      if (path === "/entry.mpd") {
        res.statusCode = 302;
        res.setHeader("Location", "/final/manifest.mpd");
        return void res.end();
      }
      if (path === "/final/manifest.mpd") return void res.end(manifest);
      if (path === "/final/v-low-init.mp4") return void res.end("VINIT");
      if (path === "/final/v-low-2.m4s") return void res.end("V2");
      if (path === "/final/v-low-3.m4s") return void res.end("V3");
      if (path === "/final/audio.bin") {
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
        if (!range) return void res.end(audioBytes);
        const start = Number(range[1]);
        const end = Number(range[2]);
        res.statusCode = 206;
        res.setHeader(
          "Content-Range",
          `bytes ${start}-${end}/${audioBytes.length}`,
        );
        return void res.end(audioBytes.subarray(start, end + 1));
      }
      res.statusCode = 404;
      return void res.end("unselected or missing");
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
    const addRules = vi.fn().mockResolvedValue([41]);
    const removeRules = vi.fn().mockResolvedValue(undefined);
    let observedPayload: unknown;
    const handler = new DashFastClipHandler({
      fetchManifest: async (url, options) => {
        const response = await fetch(url, { signal: options.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return { text: await response.text(), finalUrl: response.url };
      },
      addRules,
      removeRules,
      process: async (job) => {
        observedPayload = job.payload;
        const videoChunks = await readClipTrackChunks(
          job.operationId,
          "video",
        );
        const audioChunks = await readClipTrackChunks(
          job.operationId,
          "audio",
        );
        expect(
          videoChunks.map((chunk) => new TextDecoder().decode(chunk)),
        ).toEqual(["VINIT", "V2", "V3"]);
        expect(
          audioChunks.map((chunk) => new TextDecoder().decode(chunk)),
        ).toEqual(["INIT", "AAAA", "BBBB"]);
        return { blobUrl: "blob:dash-fixture" };
      },
      save: vi.fn().mockResolvedValue("/Downloads/dash-fixture.mp4"),
    });
    const clipRequest = request(`${origin}/entry.mpd`);
    clipRequest.clip = {
      ...clipRequest.clip,
      startMs: 2_500,
      endMs: 5_500,
    };
    clipRequest.manifestQuality = { selectedBandwidth: 500_000 };

    const result = await handler.clip(
      clipRequest,
      "dash_fixture_server",
      settings,
      new AbortController().signal,
    );

    expect(observedPayload).toEqual({
      mediaFormat: "dash-fmp4",
      inputKind: "separate",
      durationMs: 3_000,
      videoLength: 3,
      audioLength: 3,
      videoRelativeStartMs: 500,
      audioRelativeStartMs: 2_500,
    });
    expect(result).toMatchObject({
      videoRepresentationId: "v-low",
      selectedVideoParts: 3,
      selectedAudioParts: 3,
    });
    const mediaRequests = requests.filter(
      ({ path }) => path.endsWith(".mp4") || path.endsWith(".m4s") || path.endsWith("audio.bin"),
    );
    expect(
      mediaRequests
        .map(({ path, range }) => `${path}|${range ?? ""}`)
        .sort(),
    ).toEqual([
      "/final/audio.bin|bytes=0-3",
      "/final/audio.bin|bytes=4-7",
      "/final/audio.bin|bytes=8-11",
      "/final/v-low-2.m4s|",
      "/final/v-low-3.m4s|",
      "/final/v-low-init.mp4|",
    ]);
    expect(requests.some(({ path }) => path.includes("v-high"))).toBe(false);
    expect(requests.some(({ path }) => path.endsWith("v-low-1.m4s"))).toBe(
      false,
    );
    expect(requests.some(({ path }) => path.endsWith("v-low-4.m4s"))).toBe(
      false,
    );
    for (const kind of [
      "combined",
      "video",
      "audio",
      "init",
    ] as ClipTrackKind[]) {
      expect(await readClipTrackChunks("dash_fixture_server", kind)).toEqual(
        [],
      );
    }
    expect(removeRules).toHaveBeenCalledWith([41]);
    const resourceScope = addRules.mock.calls.at(-1)?.[0] as {
      urls: string[];
    };
    expect(resourceScope.urls.some((url) => url.includes("v-high"))).toBe(
      false,
    );
    expect(
      resourceScope.urls.some((url) => url.endsWith("v-low-1.m4s")),
    ).toBe(false);
  });
});
