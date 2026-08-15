import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HlsFastClipHandler } from "@/core/downloader/hls/hls-fast-clip-handler";
import { buildFastSegmentedClipArgs } from "@/core/ffmpeg/fast-segmented-args";
import { readClipTrackChunks } from "@/core/database/clip-chunks";
import { VideoFormat } from "@/core/types";
import type { AppSettings } from "@/core/storage/settings";

const hasMediaTools =
  spawnSync("ffmpeg", ["-version"]).status === 0 &&
  spawnSync("ffprobe", ["-version"]).status === 0;

const settings = {
  ffmpegTimeout: 30_000,
  maxConcurrent: 3,
  clipping: { maxClipDurationMs: 60_000 },
  advanced: { maxRetries: 1, retryDelayMs: 0, retryBackoffFactor: 1 },
} as AppSettings;

describe.runIf(hasMediaTools)("HLS Fast system FFmpeg fixture", () => {
  let server: Server | undefined;
  let fixtureDir: string | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    server = undefined;
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  });

  it("stream-copies only the selected deterministic HLS segments to MP4", async ({ skip }) => {
    const requested: string[] = [];
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://fixture").pathname;
      requested.push(pathname);
      try {
        res.end(readFileSync(join(fixtureDir!, pathname.replace(/^\//, ""))));
      } catch {
        res.statusCode = 404;
        res.end("missing");
      }
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

    fixtureDir = mkdtempSync(join(tmpdir(), "media-bridge-hls-fast-"));
    const generated = spawnSync(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
        "-t", "8",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-g", "20", "-keyint_min", "20", "-sc_threshold", "0",
        "-c:a", "aac",
        "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod",
        "-hls_segment_filename", join(fixtureDir, "segment-%02d.ts"),
        join(fixtureDir, "index.m3u8"),
      ],
      { encoding: "utf8" },
    );
    expect(generated.status, generated.stderr).toBe(0);

    const address = server.address() as AddressInfo;
    const manifestUrl = `http://127.0.0.1:${address.port}/index.m3u8`;
    let probe: { format: { duration: string }; streams: Array<{ codec_type: string }> } | undefined;
    const handler = new HlsFastClipHandler({
      fetchManifest: async (url, options) => {
        const response = await fetch(url, { signal: options.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return { text: await response.text(), finalUrl: response.url };
      },
      addRules: vi.fn().mockResolvedValue([]),
      removeRules: vi.fn().mockResolvedValue(undefined),
      process: async (job) => {
        if (job.payload.inputKind !== "combined") {
          throw new Error("Expected combined system fixture input");
        }
        const chunks = await readClipTrackChunks(job.operationId, "combined");
        const inputFile = join(fixtureDir!, "selected.ts");
        const outputFile = join(fixtureDir!, "clip.mp4");
        writeFileSync(inputFile, Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
        const args = buildFastSegmentedClipArgs({
          input: {
            kind: "combined",
            inputFile,
            relativeStartMs: job.payload.combinedRelativeStartMs ?? 0,
          },
          mediaFormat: job.payload.mediaFormat,
          durationMs: job.payload.durationMs,
          outputFile,
        });
        const converted = spawnSync(
          "ffmpeg",
          ["-hide_banner", "-loglevel", "error", ...args],
          { encoding: "utf8" },
        );
        expect(converted.status, converted.stderr).toBe(0);
        const inspected = spawnSync(
          "ffprobe",
          [
            "-v", "error", "-show_entries", "format=duration:stream=codec_type",
            "-of", "json", outputFile,
          ],
          { encoding: "utf8" },
        );
        expect(inspected.status, inspected.stderr).toBe(0);
        probe = JSON.parse(inspected.stdout) as typeof probe;
        return { blobUrl: "blob:system-fixture" };
      },
      save: vi.fn().mockResolvedValue("/Downloads/system-fixture.mp4"),
    });

    await handler.clip(
      {
        url: manifestUrl,
        format: VideoFormat.M3U8,
        clip: {
          startMs: 2_500,
          endMs: 5_500,
          mode: "fast",
          markSource: "manual",
        },
        metadata: {
          url: manifestUrl,
          format: VideoFormat.M3U8,
          title: "System fixture",
          pageUrl: "https://watch.test/system",
        },
      },
      "system_fixture_clip",
      settings,
      new AbortController().signal,
    );

    const segmentRequests = requested.filter((path) => path.endsWith(".ts"));
    expect(segmentRequests).toEqual(["/segment-01.ts", "/segment-02.ts"]);
    expect(probe?.streams.map((stream) => stream.codec_type).sort()).toEqual([
      "audio",
      "video",
    ]);
    expect(Number(probe?.format.duration)).toBeGreaterThan(2);
    expect(Number(probe?.format.duration)).toBeLessThanOrEqual(4);
  }, 30_000);
});

