import { describe, expect, it } from "vitest";
import {
  NetworkMediaRequestTracker,
  classifyNetworkMediaResponse,
  mediaSourceKey,
  redactSensitiveUrl,
} from "@/core/detection/network-media";
import { VideoFormat } from "@/core/types";

function response(overrides: Partial<Parameters<typeof classifyNetworkMediaResponse>[0]> = {}) {
  return {
    requestId: "request-1",
    url: "https://cdn.example/video.mp4?v-acctoken=secret",
    tabId: 1,
    frameId: 0,
    resourceType: "media",
    statusCode: 206,
    responseHeaders: {
      "content-type": "video/mp4",
      "content-range": "bytes 0-1023/50000",
    },
    ...overrides,
  };
}

describe("network media response classification", () => {
  it("detects tokenized progressive MP4 requests", () => {
    expect(classifyNetworkMediaResponse(response())).toBe(VideoFormat.DIRECT);
  });

  it("keeps common audio-prefixed HLS MIME types detectable", () => {
    expect(classifyNetworkMediaResponse(response({
      url: "https://cdn.example/live/controller.php",
      statusCode: 200,
      resourceType: "xmlhttprequest",
      responseHeaders: { "content-type": "audio/mpegurl" },
    }))).toBe(VideoFormat.HLS);
  });

  it("detects a PHP 206 video response through redirect ancestry", () => {
    const final = response({
      url: "https://storage.example/remote_control.php?file=opaque&rnd=123",
      responseHeaders: {
        "content-type": "video/mp4; charset=binary",
        "content-range": "bytes 0-1023/50000",
      },
    });

    expect(classifyNetworkMediaResponse(final, [
      "https://cdn.example/something_720p.mp4?v-acctoken=secret",
      final.url,
    ])).toBe(VideoFormat.DIRECT);
  });

  it("detects an encoded video file behind an arbitrary authenticated PHP proxy", () => {
    const proxyUrl =
      "https://media.example/blah.php?file=protected%2Fmovie_720p.mp4%3Fv-acctoken%3Dnested-secret&acctoken=outer-secret";
    const proxyResponse = response({
      url: proxyUrl,
      resourceType: "xmlhttprequest",
      statusCode: 206,
      responseHeaders: {
        "content-type": "video/mp4",
        "content-range": "bytes 0-1023/50000",
      },
    });

    expect(classifyNetworkMediaResponse(proxyResponse)).toBe(VideoFormat.DIRECT);
    const sourceKey = mediaSourceKey([proxyUrl], VideoFormat.DIRECT);
    expect(sourceKey).toContain("blah.php?file=%2Fprotected%2Fmovie_720p.mp4");
    expect(sourceKey).not.toContain("outer-secret");
    expect(sourceKey).not.toContain("nested-secret");
  });

  it("accepts octet-stream only when range and redirect evidence agree", () => {
    const final = response({
      url: "https://storage.example/remote_control.php?file=opaque&rnd=123",
      responseHeaders: {
        "content-type": "application/octet-stream",
        "content-range": "bytes 0-1023/50000",
      },
    });

    expect(classifyNetworkMediaResponse(final, [
      "https://cdn.example/something_720p.mp4?v-acctoken=secret",
      final.url,
    ])).toBe(VideoFormat.DIRECT);
    expect(classifyNetworkMediaResponse({
      ...final,
      resourceType: "xmlhttprequest",
    })).toBe(VideoFormat.UNKNOWN);
  });

  it("rejects preview images even when their filename contains .mp4", () => {
    expect(classifyNetworkMediaResponse(response({
      url: "https://cdn.example/preview_720p.mp4.jpg",
      resourceType: "image",
      statusCode: 200,
      responseHeaders: { "content-type": "image/jpeg" },
    }))).toBe(VideoFormat.UNKNOWN);
  });

  it("does not treat an unrelated PHP partial response as video", () => {
    expect(classifyNetworkMediaResponse(response({
      url: "https://example.test/report.php?id=1",
      resourceType: "xmlhttprequest",
      responseHeaders: {
        "content-type": "application/pdf",
        "content-range": "bytes 0-1023/50000",
      },
    }))).toBe(VideoFormat.UNKNOWN);
  });

  it("keeps m4s responses as direct candidates for structural validation", () => {
    expect(classifyNetworkMediaResponse(response({
      url: "https://cdn.example/stream/chunk-42.m4s",
      resourceType: "xmlhttprequest",
      statusCode: 206,
      responseHeaders: {
        "content-type": "video/mp4",
        "content-range": "bytes 0-999/1000",
      },
    }))).toBe(VideoFormat.DIRECT);

    expect(classifyNetworkMediaResponse(response({
      url: "https://cdn.example/stream/complete.m4s?token=secret",
      resourceType: "xmlhttprequest",
      statusCode: 200,
      responseHeaders: { "content-type": "video/iso.segment" },
    }))).toBe(VideoFormat.DIRECT);

    expect(classifyNetworkMediaResponse(response({
      url: "https://storage.example/opaque?id=42",
      resourceType: "xmlhttprequest",
      statusCode: 206,
      responseHeaders: {
        "content-type": "video/iso.segment",
        "content-range": "bytes 0-999/5000",
      },
    }), [
      "https://cdn.example/complete.m4s?token=secret",
      "https://storage.example/opaque?id=42",
    ])).toBe(VideoFormat.DIRECT);
  });

  it("continues to reject ordinary adaptive-streaming fragments", () => {

    expect(classifyNetworkMediaResponse(response({
      url: "https://cdn.example/stream/segment-42.ts?token=secret",
      resourceType: "xmlhttprequest",
      responseHeaders: { "content-type": "video/mp2t" },
    }))).toBe(VideoFormat.UNKNOWN);

    expect(classifyNetworkMediaResponse(response({
      url: "https://cdn.example/stream/segment.php?id=42",
      resourceType: "xmlhttprequest",
      statusCode: 200,
      responseHeaders: { "content-type": "video/mp4" },
    }))).toBe(VideoFormat.UNKNOWN);

    expect(classifyNetworkMediaResponse(response({
      url: "https://cdn.example/dash/video-init.mp4",
      resourceType: "xmlhttprequest",
      statusCode: 200,
      responseHeaders: { "content-type": "video/mp4" },
    }))).toBe(VideoFormat.UNKNOWN);

    expect(classifyNetworkMediaResponse(response({
      url: "https://cdn.example/dash/0042.mp4",
      resourceType: "xmlhttprequest",
      statusCode: 206,
      responseHeaders: {
        "content-type": "video/mp4",
        "content-range": "bytes 0-999/1000",
      },
    }))).toBe(VideoFormat.UNKNOWN);
  });

  it("rejects document and API error bodies behind media-looking URLs", () => {
    const entry = "https://cdn.example/video.mp4?v-acctoken=expired";
    expect(classifyNetworkMediaResponse(response({
      url: entry,
      statusCode: 200,
      responseHeaders: { "content-type": "text/html" },
    }))).toBe(VideoFormat.UNKNOWN);

    expect(classifyNetworkMediaResponse(response({
      url: entry,
      statusCode: 200,
      responseHeaders: { "content-type": "text/plain" },
    }))).toBe(VideoFormat.UNKNOWN);

    expect(classifyNetworkMediaResponse(response({
      url: "https://cdn.example/remote_control.php?file=opaque",
      statusCode: 206,
      responseHeaders: {
        "content-type": "application/json",
        "content-range": "bytes 0-99/100",
      },
    }), [entry])).toBe(VideoFormat.UNKNOWN);
  });
});

describe("NetworkMediaRequestTracker", () => {
  it("correlates a 302 entry URL with the final 206 transport URL", () => {
    const tracker = new NetworkMediaRequestTracker();
    tracker.recordRedirect({
      requestId: "redirected",
      url: "https://cdn.example/something_720p.mp4?v-acctoken=secret",
      redirectUrl: "https://storage.example/remote_control.php?file=opaque&rnd=123",
      tabId: 1,
      frameId: 0,
      resourceType: "media",
      statusCode: 302,
      observedAt: 1_000,
    });

    const observation = tracker.observeResponse({
      requestId: "redirected",
      url: "https://storage.example/remote_control.php?file=opaque&rnd=123",
      tabId: 1,
      frameId: 0,
      resourceType: "media",
      statusCode: 206,
      responseHeaders: {
        "content-type": "video/mp4",
        "content-range": "bytes 0-1023/50000",
      },
      observedAt: 1_001,
    });

    expect(observation).toEqual(expect.objectContaining({
      entryUrl: "https://cdn.example/something_720p.mp4?v-acctoken=secret",
      url: "https://storage.example/remote_control.php?file=opaque&rnd=123",
      format: VideoFormat.DIRECT,
      sourceKey: "direct:https://cdn.example/something_720p.mp4",
    }));
    expect(observation?.redirectChain).toEqual([
      "https://cdn.example/something_720p.mp4?v-acctoken=secret",
      "https://storage.example/remote_control.php?file=opaque&rnd=123",
    ]);
  });

  it("cleans completed and expired redirect records", () => {
    const tracker = new NetworkMediaRequestTracker(50, 2);
    tracker.recordRequest({
      requestId: "old",
      url: "https://cdn.example/old.mp4",
      tabId: 1,
      frameId: 0,
      resourceType: "media",
      observedAt: 1_000,
    });
    tracker.recordRequest({
      requestId: "new",
      url: "https://cdn.example/new.mp4",
      tabId: 1,
      frameId: 0,
      resourceType: "media",
      observedAt: 1_100,
    });
    expect(tracker.size).toBe(1);
    tracker.complete("new");
    expect(tracker.size).toBe(0);
  });
});

describe("redactSensitiveUrl", () => {
  it("preserves the media path while hiding capability parameters", () => {
    const redacted = redactSensitiveUrl(
      "https://cdn.example/video.mp4?v-acctoken=secret&rnd=123&quality=720p",
    );
    expect(redacted).toContain("/video.mp4");
    expect(redacted).toContain("quality=720p");
    expect(redacted).not.toContain("secret");
    expect(redacted).not.toContain("rnd=123");
  });

  it("keeps stable identity parameters while excluding rotating tokens", () => {
    expect(mediaSourceKey([
      "https://cdn.example/video.mp4?id=42&quality=720p&v-acctoken=secret&rnd=123",
    ], VideoFormat.DIRECT)).toBe(
      "direct:https://cdn.example/video.mp4?id=42&quality=720p",
    );
  });
});
