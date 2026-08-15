# ADR 0001: Browser clipping architecture

- Status: Accepted
- Date: 2026-08-15
- Base: `jvillegasd/media-bridge` at `8eb58839d336ff3a0f85ea5292db2f276663e2d6`
- Runtime media dependency: Mediabunny 1.54.0

## Context

Media Bridge already processes segmented HLS and DASH media with a serialized
FFmpeg.wasm queue in an offscreen document. Direct downloads bypass processing.
Clipping must preserve those paths, avoid full-file network transfers when the
source supports ranges, and provide truthful fast and exact modes without a
native helper or server.

## Decision

1. Integer milliseconds are the domain and message representation.
2. A pure clipping domain normalizes timed segments and selects `[start, end)`
   windows independently per track.
3. HLS/M3U8/DASH fast clips download only selected segments and use the existing
   FFmpeg.wasm engine with stream-copy trimming.
4. Direct MP4/WebM clips use Mediabunny `UrlSource`; exact clips force WebCodecs
   transcoding. Segmented exact clips use local `BlobSource` inputs.
5. All FFmpeg and Mediabunny work runs through one single-concurrency offscreen
   media-job queue.
6. Durable operation state stays in IndexedDB. Existing chunk keys remain
   `[downloadId, index]`; new track namespaces are encoded centrally into the
   `downloadId` component to avoid a destructive object-store migration.
7. Dynamic DNR header rules remain narrowly URL-scoped and are removed from
   `finally` blocks.
8. Direct sources that ignore Range require explicit consent only when their
   known size is below the configured sequential-fetch threshold; large or
   unknown sources are refused as clips.

## Installed API findings

Mediabunny 1.54.0 accepts `UrlSourceOptions.fetchFn`, `requestInit`,
`getRetryDelay`, `maxCacheSize`, and `parallelism`. Its `Conversion` exposes
`isValid`, `discardedTracks`, `onProgress`, `execute()`, and `cancel()`.
`Input.dispose()` cancels URL reads. A `BufferTarget` exposes its buffer only
after output finalization. Exact conversion is therefore capability-gated using
the planned conversion rather than static browser detection.

Mediabunny 1.54.0 may transcode a nonzero-start direct Fast clip when packet
copying cannot produce a valid trim. This is the documented Fast-direct
behavior: copy when possible and transcode when required. `Conversion` has no
`dispose()` method; cancellation uses `Conversion.cancel()` plus
`Input.dispose()`. User-approved small no-Range inputs are fully fetched under
the configured limit and then passed as `BlobSource` inputs. MP4 output disables
Fast Start while using a memory target to avoid a second large in-memory media
buffer during finalization.

## Consequences

Fast segmented clips may begin on a keyframe before the requested time. Exact
mode depends on browser/OS WebCodecs support and must never fall back silently.
The existing full-download and live-recording FFmpeg paths remain intact.
