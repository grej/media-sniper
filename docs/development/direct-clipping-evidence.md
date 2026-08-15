# Direct clipping evidence

Verified on 2026-08-15 in the connected Chromium browser against the local
Vite fixture server.

## Browser media checks

The deterministic clip range was `00:00:02.000` through `00:00:06.000`.

| Source | Mode | Result |
| --- | --- | --- |
| MP4 (H.264/AAC) | Fast | MP4, keyframe-aligned, 4,075 ms |
| MP4 (H.264/AAC) | Exact | MP4, exact, 4,075 ms |
| WebM (VP9/Opus) | Fast | MP4, keyframe-aligned, 4,075 ms |
| WebM (VP9/Opus) | Exact | MP4, exact, 4,075 ms |

Exact output is within 75 ms of the requested four-second duration. Both
formats produced playable MP4 Blob URLs, emitted progress, and cancellation
returned an `AbortError`.

## Range economy

The Range-capable MP4 endpoint logged bounded requests including:

- `bytes=0-262143`
- `bytes=262144-524287`
- `bytes=65536-327679`
- `bytes=327680-589823`

No open-ended `bytes=N-` request reached the fixture server. The unit suite
also verifies credential preservation, DNR Origin/Referer scope, invalid
Content-Range refusal, no-Range size classification, explicit small-source
full-fetch consent, large/unknown sequential refusal, output limits, late Blob
URL cleanup, and correlated offscreen cancellation.
