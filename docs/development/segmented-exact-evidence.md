# Segmented Exact clipping evidence

Verified on 2026-08-15 in the connected Chromium browser using deterministic
local MPEG-TS and fragmented MP4 fixtures.

Each case requested a 3,200 ms clip beginning 2,100 ms into the selected local
window. The output inspection used Mediabunny to read MP4 duration and the
first timestamps of the primary video/audio tracks.

| Case | Actual | Error | Video start | Audio start | A/V delta |
| --- | ---: | ---: | ---: | ---: | ---: |
| HLS MPEG-TS combined | 3,264 ms | 64 ms | 0 ms | 0 ms | 0 ms |
| HLS fMP4 combined | 3,264 ms | 64 ms | 0 ms | 0 ms | 0 ms |
| DASH fMP4 separate A/V | 3,264 ms | 64 ms | 0 ms | 0 ms | 0 ms |

All cases forced AVC/AAC transcoding, reported `accuracy: exact`, remained
within the 100 ms boundary tolerance, and normalized independent tracks to a
common zero timestamp. Handler tests separately prove selected-only network
windows, decode padding, memory-limit refusal before processing, stable codec
errors, cancellation, and unchanged Fast routing.
