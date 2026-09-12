import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectDetectionHandler } from "@/core/detection/direct/direct-detection-handler";
import type { NetworkMediaObservation } from "@/core/detection/network-media";
import { VideoFormat, type VideoMetadata } from "@/core/types";

const DOM_SCAN_DEBOUNCE_MS = 1_000;

function directObservation(
  overrides: Partial<NetworkMediaObservation> = {},
): NetworkMediaObservation {
  const entryUrl = "https://cdn.example/video_720p.mp4?v-acctoken=secret";
  const url = "https://media.example/remote_control.php?file=opaque&rnd=123";
  return {
    url,
    entryUrl,
    redirectChain: [entryUrl, url],
    sourceKey: "direct:https://cdn.example/video_720p.mp4",
    format: VideoFormat.DIRECT,
    statusCode: 206,
    resourceType: "media",
    contentType: "video/mp4",
    contentRange: "bytes 0-1023/50000",
    observedAt: Date.now(),
    ...overrides,
  };
}

async function flushMutationScan(): Promise<void> {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(DOM_SCAN_DEBOUNCE_MS);
  await Promise.resolve();
}

describe("DirectDetectionHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("detects an existing video whose src is assigned after observer setup", async () => {
    const detected: VideoMetadata[] = [];
    const video = document.createElement("video");
    document.body.append(video);
    const handler = new DirectDetectionHandler({
      onVideoDetected: (metadata) => detected.push(metadata),
    });

    handler.setupDOMObserver();
    await handler.scanDOMForVideos();
    expect(detected).toHaveLength(0);

    video.src = "https://cdn.example/late-video.mp4?v-acctoken=secret";
    await flushMutationScan();

    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({
      url: "https://cdn.example/late-video.mp4?v-acctoken=secret",
      format: VideoFormat.DIRECT,
    });
    handler.destroy();
  });

  it("detects a source element whose src is assigned after observer setup", async () => {
    const detected: VideoMetadata[] = [];
    const video = document.createElement("video");
    const source = document.createElement("source");
    video.append(source);
    document.body.append(video);
    const handler = new DirectDetectionHandler({
      onVideoDetected: (metadata) => detected.push(metadata),
    });

    handler.setupDOMObserver();
    await handler.scanDOMForVideos();
    expect(detected).toHaveLength(0);

    source.src = "https://cdn.example/late-source.webm?token=secret";
    await flushMutationScan();

    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({
      url: "https://cdn.example/late-source.webm?token=secret",
      format: VideoFormat.DIRECT,
    });
    handler.destroy();
  });

  it("uses a recent network candidate when an existing video receives srcObject", async () => {
    const detected: VideoMetadata[] = [];
    const observation = directObservation();
    const video = document.createElement("video");
    document.body.append(video);
    const handler = new DirectDetectionHandler({
      onVideoDetected: (metadata) => detected.push(metadata),
    });

    handler.handleNetworkRequest(observation);
    await Promise.resolve();
    expect(detected).toHaveLength(1);

    handler.setupDOMObserver();
    Object.defineProperty(video, "srcObject", {
      configurable: true,
      value: { id: "media-stream" },
    });
    video.dispatchEvent(new Event("loadstart"));
    await flushMutationScan();

    expect(detected).toHaveLength(2);
    expect(detected[1]).toMatchObject({
      url: observation.url,
      sourceUrl: observation.entryUrl,
      sourceKey: observation.sourceKey,
      redirectChain: observation.redirectChain,
      format: VideoFormat.DIRECT,
    });
    handler.destroy();
  });

  it("emits one network-only detection for an evidence-backed PHP 206 response", async () => {
    const onVideoDetected = vi.fn<(metadata: VideoMetadata) => void>();
    const observation = directObservation();
    const handler = new DirectDetectionHandler({ onVideoDetected });

    handler.handleNetworkRequest(observation);
    await Promise.resolve();

    expect(document.querySelector("video")).toBeNull();
    expect(onVideoDetected).toHaveBeenCalledTimes(1);
    expect(onVideoDetected).toHaveBeenCalledWith(expect.objectContaining({
      url: observation.url,
      sourceUrl: observation.entryUrl,
      sourceKey: observation.sourceKey,
      contentType: "video/mp4",
      format: VideoFormat.DIRECT,
    }));
    handler.destroy();
  });

  it("binds an m4s candidate to the page video and marks it as a complete-fMP4 download", async () => {
    const detected: VideoMetadata[] = [];
    const video = document.createElement("video");
    document.body.append(video);
    const observation = directObservation({
      url: "https://cdn.example/loop-high.m4s?token=secret",
      entryUrl: "https://cdn.example/loop-high.m4s?token=secret",
      redirectChain: ["https://cdn.example/loop-high.m4s?token=secret"],
      sourceKey: "direct:https://cdn.example/loop-high.m4s",
      resourceType: "xmlhttprequest",
      contentType: "video/iso.segment",
      contentLength: 50_000,
    });
    const handler = new DirectDetectionHandler({
      onVideoDetected: (metadata) => detected.push(metadata),
      getPageVideoId: () => "page-video-1",
    });

    handler.handleNetworkRequest(observation);
    await Promise.resolve();

    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({
      url: observation.url,
      format: VideoFormat.DIRECT,
      fileExtension: "mp4",
      isSelfContainedFmp4: true,
      pageVideoId: "page-video-1",
      contentLength: 50_000,
    });
    expect(detected[0]?.mediaAssets).toEqual([
      expect.objectContaining({
        url: observation.url,
        kind: "self-contained-fmp4",
      }),
    ]);
    handler.destroy();
  });

  it("does not surface an unbound m4s segment as a standalone video", async () => {
    const onVideoDetected = vi.fn<(metadata: VideoMetadata) => void>();
    const handler = new DirectDetectionHandler({ onVideoDetected });
    handler.handleNetworkRequest(directObservation({
      url: "https://cdn.example/orphan.m4s",
      entryUrl: "https://cdn.example/orphan.m4s",
      redirectChain: ["https://cdn.example/orphan.m4s"],
      sourceKey: "direct:https://cdn.example/orphan.m4s",
      resourceType: "xmlhttprequest",
      contentType: "video/iso.segment",
    }));
    await Promise.resolve();
    expect(onVideoDetected).not.toHaveBeenCalled();
    handler.destroy();
  });
});
