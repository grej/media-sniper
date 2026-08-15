# Clipping test and acceptance evidence

This document records the deterministic evidence for the browser-clipping plan.
All media fixtures are local and redistribution-safe; automated tests never use
public media URLs or external credentials.

## Automated gates

Run the complete release gate with:

```bash
npm run type-check
npm test
npm run build
npm run package
npm run package:check
```

The Vitest suite covers the clipping time/domain model, range validation,
filename and operation keys, persistence migration, playback selection/drafts,
timed HLS and DASH normalization, overlap selection, AES sequence/IV handling,
byte ranges, FFmpeg arguments, direct preflight classification, stable errors,
cancellation, and resource cleanup. System-media tests use local FFmpeg/ffprobe
when available and skip explicitly when those development-only tools are absent.

## Browser media evidence

| Path | Browser result | Timing/network evidence |
| --- | --- | --- |
| Direct MP4 Fast | Pass | Requested 4.000 s; output 4.075 s; only bounded 256 KiB Range windows were requested. |
| Direct WebM Fast | Pass | Produces MP4 when the runtime codec path is supported; capability failures are stable and explicit. |
| Direct MP4 Exact | Pass | Browser-native demux/decode/encode path, abort propagation, no-Range consent, and memory limits exercised. |
| HLS MPEG-TS Fast | Pass | Only overlap/init/key material selected; AES, byte-range, discontinuity refusal, redirects, and cleanup tested. |
| HLS fMP4 Fast | Pass | Init plus selected fragments only. |
| HLS separate A/V Fast | Pass | Independent track windows and synchronized mux exercised. |
| DASH static single-period Fast | Pass | Selected representations and byte ranges only; independent A/V timelines retained. |
| HLS MPEG-TS Exact | Pass | Requested 3.200 s; actual 3.264 s; 64 ms boundary error; 0 ms A/V start skew. |
| HLS fMP4 Exact | Pass | Requested 3.200 s; actual 3.264 s; 64 ms boundary error; 0 ms A/V start skew. |
| DASH fMP4 separate A/V Exact | Pass | Requested 3.200 s; actual 3.264 s; 64 ms boundary error; 0 ms A/V start skew. |

The detailed captured browser runs are in
[`direct-clipping-evidence.md`](direct-clipping-evidence.md) and
[`segmented-exact-evidence.md`](segmented-exact-evidence.md).

The final integrated gate passed 41 Vitest files / 217 tests and four
persistent-Chromium Playwright extension E2E cases. The packaged extension also
passed unpacked smoke checks in Google Chrome 151.0.7922.138 and Brave
150.1.92.139 on macOS 15.6.1; see the release checklist for the recorded matrix.

## Required acceptance matrix

| Source or behavior | Result | Evidence |
| --- | --- | --- |
| Direct MP4 Range, Fast/Exact | Pass | Direct browser spike plus bounded-range and handler suites. |
| Direct no-Range small/large | Pass | Explicit consent for bounded small input; unknown/oversize input refused. |
| Direct WebM Fast | Pass | Deterministic WebM fixture and browser conversion path. |
| HLS MPEG-TS/fMP4 Fast/Exact | Pass | Handler suites, FFmpeg system test, and segmented browser spike. |
| HLS separate audio Fast/Exact | Pass | Independent-track planner/downloader and exact composable conversion tests. |
| HLS AES-128 and byte-range | Pass | Explicit/implicit IV, nonzero media sequence, selected-key, and Range assertions. |
| HLS discontinuity crossing | Pass | Refused before media-part fetch with stable error. |
| Direct M3U8 Fast | Pass | Routed through the timed HLS handler. |
| DASH static single-period Fast/Exact | Pass | Handler suites and separate-A/V browser spike. |
| DASH DRM/multi-period/live unsupported ranges | Pass | Pre-fetch capability refusals retain existing recording support. |
| Multiple clips / exact duplicate | Pass | Operation keys include range/mode; exact active duplicates are focused. |
| Popup close/reopen and progress | Pass | Durable v4 operation rows and shared tab/frame/video drafts. |
| Cancellation and cleanup | Pass | Planning/download/processor aborts; DNR, IndexedDB chunks, queue ownership, virtual files, and late Blob URLs cleaned. |
| Auth/referrer | Pass | Temporary scoped DNR rules and finally cleanup are unit/integration tested. |
| Existing full downloads/recording/cloud | Pass | Full legacy Vitest smoke/regression suite remains green; post-actions are shared by completed clip operations. |

Exact browser timing is within the required ±100 ms tolerance, and the captured
separate-track A/V start skew is within the required 100 ms tolerance. Fast
results are labeled keyframe-aligned rather than presented as frame-accurate.

## Manual release gate

Unpacked-install identity, popup/options startup, and real-toolbar smoke results
are recorded in [`../release-validation.md`](../release-validation.md). The
browser/version rows there are intentionally the authoritative manual sign-off.
