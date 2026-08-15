# Media Bridge Clipper implementation status

This repository is implementing the accompanying canonical contract
`media-bridge-clipper-plan.md`, based on upstream Media Bridge commit
`8eb58839d336ff3a0f85ea5292db2f276663e2d6` (release 1.11.0).

Architectural decisions and verified third-party API deviations are recorded in
`docs/adr/0001-browser-clipping-architecture.md`. Detailed command, browser, and
acceptance evidence is recorded under `docs/development/`.

## Milestones

- [x] M0 — Baseline, test harness, and architecture spike
- [x] M1 — Clipping domain model and persistence
- [x] M2 — Playback registry and popup editor
- [x] M3 — Timed HLS/M3U8 parsing and segment planner
- [x] M4 — HLS/M3U8 Fast clips
- [x] M5 — DASH Fast clips
- [ ] M6 — Direct MP4/WebM clips
- [ ] M7 — Exact segmented clips
- [ ] M8 — Overlay, polish, regression, and release

M0 browser evidence covers Vite/CSP bundling, Blob Fast and Exact conversion,
Mediabunny custom-fetch Range requests, progress, and cancellation. The final
unpacked Chrome/Brave matrix remains part of M8 because the connected in-app
browser cannot install unpacked extensions.
