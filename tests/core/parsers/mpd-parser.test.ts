import { describe, expect, it } from "vitest";
import { ClippingError } from "@/core/clipping/errors";
import {
  getAudioPlaylist,
  getVideoPlaylistByBandwidth,
  parseLevelsPlaylist,
  parseManifest,
  parseTimedDashTracks,
  selectDashTrackWindows,
} from "@/core/parsers/mpd-parser";

const MPD_URL = "https://cdn.example/media/manifest.mpd";

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
      <Representation id="a-alt" bandwidth="192000">
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

function clippingError(job: () => unknown): ClippingError {
  try {
    job();
  } catch (error) {
    expect(error).toBeInstanceOf(ClippingError);
    return error as ClippingError;
  }
  throw new Error("Expected a ClippingError");
}

describe("parseTimedDashTracks", () => {
  it("selects a video bandwidth and normalizes presentation time and Period identity", () => {
    const tracks = parseTimedDashTracks(STATIC_MPD, MPD_URL, {
      videoBandwidth: 500000,
    });

    expect(tracks.durationMs).toBe(12_000);
    expect(tracks.video).toMatchObject({
      kind: "video",
      representationId: "v-low",
      bandwidth: 500000,
      width: 640,
      height: 360,
      timelineStartsMs: [0],
    });
    expect(
      tracks.video.segments.map(
        ({ sourceIndex, sequenceNumber, startMs, durationMs, endMs, periodKey }) => ({
          sourceIndex,
          sequenceNumber,
          startMs,
          durationMs,
          endMs,
          periodKey,
        }),
      ),
    ).toEqual([
      {
        sourceIndex: 0,
        sequenceNumber: 0,
        startMs: 0,
        durationMs: 4_000,
        endMs: 4_000,
        periodKey: "dash-period-0",
      },
      {
        sourceIndex: 1,
        sequenceNumber: 1,
        startMs: 4_000,
        durationMs: 4_000,
        endMs: 8_000,
        periodKey: "dash-period-0",
      },
      {
        sourceIndex: 2,
        sequenceNumber: 2,
        startMs: 8_000,
        durationMs: 4_000,
        endMs: 12_000,
        periodKey: "dash-period-0",
      },
    ]);
    expect(tracks.video.segments[0]?.init).toEqual({
      uri: "https://cdn.example/media/v-low-init.mp4",
    });
  });

  it("selects representations by ID and extracts an independent audio track", () => {
    const tracks = parseTimedDashTracks(STATIC_MPD, MPD_URL, {
      videoRepresentationId: "v-high",
      audioRepresentationId: "a-alt",
    });

    expect(tracks.video.representationId).toBe("v-high");
    expect(tracks.audio).toMatchObject({
      kind: "audio",
      representationId: "a-alt",
      bandwidth: 192000,
      language: "en",
    });
    expect(tracks.audio?.segments.map(({ startMs, endMs }) => ({ startMs, endMs }))).toEqual([
      { startMs: 0, endMs: 3_000 },
      { startMs: 3_000, endMs: 6_000 },
      { startMs: 6_000, endMs: 9_000 },
      { startMs: 9_000, endMs: 12_000 },
    ]);

    const selected = selectDashTrackWindows(tracks, 4_500, 7_500);
    expect(selected.video?.mediaSegments.map((segment) => segment.sourceIndex)).toEqual([
      1,
    ]);
    expect(selected.audio?.mediaSegments.map((segment) => segment.sourceIndex)).toEqual([
      1,
      2,
    ]);
    expect(selected.video?.relativeStartMs).toBe(500);
    expect(selected.audio?.relativeStartMs).toBe(1_500);
  });

  it("preserves media and initialization byte ranges", () => {
    const ranged = `
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     type="static" mediaPresentationDuration="PT8S">
  <Period start="PT0S">
    <AdaptationSet mimeType="video/mp4">
      <Representation id="range-video" bandwidth="1000">
        <BaseURL>video.mp4</BaseURL>
        <SegmentList timescale="1" duration="4">
          <Initialization sourceURL="video.mp4" range="0-99" />
          <SegmentURL media="video.mp4" mediaRange="100-199" />
          <SegmentURL media="video.mp4" mediaRange="200-349" />
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

    const tracks = parseTimedDashTracks(ranged, MPD_URL);

    expect(tracks.video.segments[0]).toMatchObject({
      byteRange: { offset: 100, length: 100 },
      init: {
        uri: "https://cdn.example/media/video.mp4",
        byteRange: { offset: 0, length: 100 },
      },
    });
    expect(tracks.video.segments[1]?.byteRange).toEqual({
      offset: 200,
      length: 150,
    });
  });

  it("allows a single-Period window and rejects a crossing window", () => {
    const tracks = parseTimedDashTracks(MULTI_PERIOD_MPD, MPD_URL);

    expect(tracks.video.timelineStartsMs).toEqual([0, 4_000]);
    expect(tracks.video.segments.map((segment) => segment.periodKey)).toEqual([
      "dash-period-0",
      "dash-period-0",
      "dash-period-4000",
      "dash-period-4000",
    ]);
    expect(
      selectDashTrackWindows(tracks, 0, 4_000).video?.mediaSegments.map(
        (segment) => segment.sourceIndex,
      ),
    ).toEqual([0, 1]);

    const error = clippingError(() =>
      selectDashTrackWindows(tracks, 3_000, 5_000),
    );
    expect(error.code).toBe("UNSUPPORTED_MULTI_PERIOD_DASH");
    expect(error.detail).toBe("DASH_CLIP_CROSSES_PERIODS");
  });

  it("refuses DRM before parsing tracks", () => {
    const drmMpd = STATIC_MPD.replace(
      '<AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e">',
      '<AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e"><ContentProtection schemeIdUri="urn:uuid:test" />',
    );
    const error = clippingError(() => parseTimedDashTracks(drmMpd, MPD_URL));
    expect(error.code).toBe("DRM_PROTECTED");
    expect(error.detail).toBe("DASH_DRM_PROTECTED");
  });

  it("refuses dynamic manifests with a stable timeline error", () => {
    const dynamic = STATIC_MPD.replace('type="static"', 'type="dynamic"');
    const error = clippingError(() => parseTimedDashTracks(dynamic, MPD_URL));
    expect(error.code).toBe("NO_TIMELINE");
    expect(error.detail).toBe("DASH_DYNAMIC_UNSUPPORTED");
  });

  it("refuses timing-unavailable representations", () => {
    const missingTiming = `
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <Period start="PT0S">
    <AdaptationSet mimeType="video/mp4">
      <Representation id="broken" bandwidth="1000">
        <SegmentTemplate initialization="init.mp4" media="$Number$.m4s" />
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
    const error = clippingError(() =>
      parseTimedDashTracks(missingTiming, MPD_URL),
    );
    expect(error.code).toBe("NO_TIMELINE");
    expect(error.detail).toBe("DASH_TIMING_UNAVAILABLE");
  });

  it("refuses an unresolved SIDX representation", () => {
    const sidx = `
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     type="static" mediaPresentationDuration="PT8S">
  <Period start="PT0S">
    <AdaptationSet mimeType="video/mp4">
      <Representation id="sidx-video" bandwidth="1000">
        <BaseURL>video.mp4</BaseURL>
        <SegmentBase indexRange="100-199">
          <Initialization range="0-99" />
        </SegmentBase>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
    const error = clippingError(() => parseTimedDashTracks(sidx, MPD_URL));
    expect(error.code).toBe("NO_TIMELINE");
    expect(error.detail).toBe("DASH_SIDX_UNAVAILABLE");
  });

  it("refuses an unavailable requested representation instead of changing quality", () => {
    const error = clippingError(() =>
      parseTimedDashTracks(STATIC_MPD, MPD_URL, {
        videoRepresentationId: "missing",
      }),
    );
    expect(error.code).toBe("NO_TIMELINE");
    expect(error.detail).toBe("DASH_REPRESENTATION_UNAVAILABLE");
  });
});

describe("legacy DASH adapters", () => {
  it("preserves full-download video and audio Fragment output", () => {
    const manifest = parseManifest(STATIC_MPD, MPD_URL);
    const video = getVideoPlaylistByBandwidth(manifest, 500000);
    const audio = getAudioPlaylist(manifest);

    expect(parseLevelsPlaylist(video!, 0)).toEqual([
      {
        index: 0,
        key: { iv: null, uri: null },
        uri: "https://cdn.example/media/v-low-init.mp4",
      },
      ...[1, 2, 3].map((number, index) => ({
        index: index + 1,
        key: { iv: null, uri: null },
        uri: `https://cdn.example/media/v-low-${number}.m4s`,
      })),
    ]);

    expect(parseLevelsPlaylist(audio!, 0)).toEqual([
      {
        index: 0,
        key: { iv: null, uri: null },
        uri: "https://cdn.example/media/a-main-init.mp4",
      },
      ...[1, 2, 3, 4].map((number, index) => ({
        index: index + 1,
        key: { iv: null, uri: null },
        uri: `https://cdn.example/media/a-main-${number}.m4s`,
      })),
    ]);
  });
});
