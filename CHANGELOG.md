# Changelog

## [1.13.1] - 2026-09-13

### Audio downloads

- Default the yt-dlp Audio only choice to high-quality MP3, including audio clips and their approved full-source fallback.
- Embed supplied track title, artist, album, album artist, release year, track/disc number, and genre; preserve existing file tags where possible.
- Keep unavailable music fields unfilled instead of substituting upload dates or uploader names.
- Bundle statically linked LAME 3.100 in both Mac FFmpeg builds so MP3 encoding works without extra installations.

## [1.13.0] - 2026-09-12

### New Features

- Ship the yt-dlp companion and browser-native `.m4s` improvements together in one macOS installer.
- Bundle standalone yt-dlp 2026.08.19 with its embedded EJS 0.8.0 solver, Deno 2.6.9, and self-contained FFmpeg/ffprobe 8.0.3 builds for Apple Silicon and Intel.
- Add automatic page-analysis fallback, shared Download/Clip controls, and installation/update checks for the companion.
- Detect self-contained fragmented MP4 `.m4s` clips from network responses and same-file HLS byte-range playlists without site-specific rules.
- Associate direct quality variants with the active page player and automatically select the best known complete `.m4s` or progressive asset.
- Fetch complete `.m4s` resources with credentials, reconstruct range-only responses in byte order, validate `ftyp`/`moov`/`moof`/`mdat`, and save them as playable `.mp4` files without remuxing.

### Installer reliability

- Reject placeholder disk images and mismatched native architectures before packaging.
- Compile each graphical installer for its target Mac architecture and verify one release version across components.
- Provision the first public managed-tool signing identity; the private signing key remains outside source and release artifacts. Development disk images are ad-hoc signed and are not Apple-notarized.

## [1.12.0] - 2026-08-15

### New Features

- Introduce the Media Sniper identity while preserving Media Bridge upgrade data.
- Add durable Fast and Exact clipping for direct MP4/WebM, HLS/M3U8, and static single-period DASH sources.
- Add page-player marks, fixed `HH:MM:SS.mmm` clip controls with a seconds-display toggle, an optional Shadow DOM overlay, clipping settings, and clip-aware History labels.

### Reliability and Safety

- Detect tokenized progressive video and `206 Partial Content` media proxies across redirect chains, including sources assigned after page load.
- Limit direct media reads with bounded byte ranges and explicit consent for small sources whose servers ignore Range.
- Fetch only selected segmented-media windows, retain authentication headers through temporary DNR rules, and clean temporary rules/chunks on terminal paths.
- Refuse DRM, unsupported live/timeline layouts, unsafe memory sizes, and unsupported browser codecs with stable user-facing errors.

### Packaging

- Add deterministic release ZIP generation, SHA-256 verification, CI media verification, third-party notices, and release validation documentation.

## [1.11.0](https://github.com/jvillegasd/media-bridge/compare/v1.10.0...v1.11.0) (2026-03-07)


### 🎉 New Features

* add copy URL button to detected video cards + remove mediabunny refs ([0dad966](https://github.com/jvillegasd/media-bridge/commit/0dad9663d15ca8a0d9c5a83df9a7649912a66257))

## [1.10.0](https://github.com/jvillegasd/media-bridge/compare/v1.9.1...v1.10.0) (2026-03-05)


### 🎉 New Features

* cloud upload — Google Drive & S3 ([#36](https://github.com/jvillegasd/media-bridge/issues/36)) ([04f15f3](https://github.com/jvillegasd/media-bridge/commit/04f15f35be088e58ea2d5d1a13e1d62039995431))


### 📚 Documentation

* adjusted changelog ([46e9314](https://github.com/jvillegasd/media-bridge/commit/46e9314508548d66c3ef8385198ccb446e17e119))

## [1.9.1](https://github.com/jvillegasd/media-bridge/compare/v1.9.0...v1.9.1) (2026-03-04)


### 📚 Documentation

* update README and CLAUDE.md with accurate architecture and planned features ([94d5efb](https://github.com/jvillegasd/media-bridge/commit/94d5efb27c4a6c2f7c38d91994af7b9c57caf624))

### 🎉 New Features

* Refactored Options UI / UX, enable configurable fields for power users, download history improved

## [1.9.0](https://github.com/jvillegasd/media-bridge/compare/v1.8.0...v1.9.0) (2026-03-03)


### 🎉 New Features

* add MPEG-DASH support with type refactoring ([#32](https://github.com/jvillegasd/media-bridge/issues/32)) ([f5a24ff](https://github.com/jvillegasd/media-bridge/commit/f5a24ffd96362607530e081b63a29990ec6e5c0f))
* enhance-ffmpeg: Improve UI response and updates when extension downloads multiple files, open / close ffmpeg isntance on demand ([#30](https://github.com/jvillegasd/media-bridge/issues/30)) ([9f2a21e](https://github.com/jvillegasd/media-bridge/commit/9f2a21e9d6a11bac03a3766d90025a1c65220a46))

## [1.8.0](https://github.com/jvillegasd/media-bridge/compare/v1.7.0...v1.8.0) (2026-02-24)


### 🎉 New Features

* bumping up license ([c9cbd2a](https://github.com/jvillegasd/media-bridge/commit/c9cbd2a62fc2c1e63376ac1569aad5c43955a74f))
* change accent color from green to blue to match extension icon ([db62dee](https://github.com/jvillegasd/media-bridge/commit/db62deea66028203a76a881b1be7a8d411f18bc8))

## [1.7.0](https://github.com/jvillegasd/media-bridge/compare/v1.6.0...v1.7.0) (2026-02-24)


### 🎉 New Features

* iframe-and-UI: iframe detection and UI/UX refactor ([#27](https://github.com/jvillegasd/media-bridge/issues/27)) ([9f429c8](https://github.com/jvillegasd/media-bridge/commit/9f429c8a0b6fae4988a8d1ec031cf18beefd6f9c))

## [1.6.0](https://github.com/jvillegasd/media-bridge/compare/v1.5.0...v1.6.0) (2026-02-22)


### 🎉 New Features

* drm validation ([#23](https://github.com/jvillegasd/media-bridge/issues/23)) ([d8f5acb](https://github.com/jvillegasd/media-bridge/commit/d8f5acb2afff013d70739295dc2f0bca650c6ac2))
* hls-stream: Enable extension to download live streams in HLS protocol ([#25](https://github.com/jvillegasd/media-bridge/issues/25)) ([074cd7b](https://github.com/jvillegasd/media-bridge/commit/074cd7beb38d5e9ffd4fb5f4b9bc0e335575d66e))

## [1.5.0](https://github.com/jvillegasd/media-bridge/compare/v1.4.0...v1.5.0) (2025-12-01)


### 🎉 New Features

* **service-worker:** implement keep-alive mechanism to prevent termination during long downloads ([#20](https://github.com/jvillegasd/media-bridge/issues/20)) ([bd5d6e7](https://github.com/jvillegasd/media-bridge/commit/bd5d6e7d4373c080fb1a376452992b557c777a15))

## [1.4.0](https://github.com/jvillegasd/media-bridge/compare/v1.3.0...v1.4.0) (2025-11-29)


### 🎉 New Features

* hls-tab: Refactored UI/UX for Manifest view and better bottom bar, Cancel buttom, tweaks ([#16](https://github.com/jvillegasd/media-bridge/issues/16)) ([ea6471d](https://github.com/jvillegasd/media-bridge/commit/ea6471dec5c703df7358e8296614c50186e4ddc8))

## [1.3.0](https://github.com/jvillegasd/media-bridge/compare/v1.2.0...v1.3.0) (2025-11-22)


### 🎉 New Features

* add HLS quality selection button and functionality in video popup ([#12](https://github.com/jvillegasd/media-bridge/issues/12)) ([0b21827](https://github.com/jvillegasd/media-bridge/commit/0b218271caf833de0d6b79e063e25b0ff370caa6))
* Enable HLS and M3U8 detection, Dark theme ([#2](https://github.com/jvillegasd/media-bridge/issues/2)) ([ae8f8b1](https://github.com/jvillegasd/media-bridge/commit/ae8f8b11b92bcf8c5cb6fa13292c2f0358a9715b))
* Enhance README with offscreen document details and project structure ([7ade312](https://github.com/jvillegasd/media-bridge/commit/7ade3120634ee1f8233059053469583f3497f116))
* HLS videos ([#1](https://github.com/jvillegasd/media-bridge/issues/1)) ([dd10ae7](https://github.com/jvillegasd/media-bridge/commit/dd10ae75f4c192631dde10d0b8ea0c7b2ff63af2))
* release config ([#14](https://github.com/jvillegasd/media-bridge/issues/14)) ([d56bb03](https://github.com/jvillegasd/media-bridge/commit/d56bb036863de755dd275ed4866245647d331436))
* release-please: Added Github actions for Releases ([#3](https://github.com/jvillegasd/media-bridge/issues/3)) ([a45fb67](https://github.com/jvillegasd/media-bridge/commit/a45fb67896bcc8f93b8da9bdbea130f539b8fbd5))
* update build-release workflow for release asset handling ([#7](https://github.com/jvillegasd/media-bridge/issues/7)) ([4e5af73](https://github.com/jvillegasd/media-bridge/commit/4e5af73d9e5a56bf06be775f8dbca55d3b9a8a14))


### 🐛 Bug Fixes

* build: Build conditionally in release-please workflow ([#9](https://github.com/jvillegasd/media-bridge/issues/9)) ([390c7e0](https://github.com/jvillegasd/media-bridge/commit/390c7e092f10146b874fbeadf4bc24e589e401f2))
* fixed release please action ([#4](https://github.com/jvillegasd/media-bridge/issues/4)) ([63b9583](https://github.com/jvillegasd/media-bridge/commit/63b958320720266f401e9803eca5ade7db64b095))

## [1.2.0](https://github.com/jvillegasd/media-bridge/compare/media-bridge-extension-v1.1.1...media-bridge-extension-v1.2.0) (2025-11-22)


### 🎉 New Features

* add HLS quality selection button and functionality in video popup ([#12](https://github.com/jvillegasd/media-bridge/issues/12)) ([0b21827](https://github.com/jvillegasd/media-bridge/commit/0b218271caf833de0d6b79e063e25b0ff370caa6))
* Enable HLS and M3U8 detection, Dark theme ([#2](https://github.com/jvillegasd/media-bridge/issues/2)) ([ae8f8b1](https://github.com/jvillegasd/media-bridge/commit/ae8f8b11b92bcf8c5cb6fa13292c2f0358a9715b))
* Enhance README with offscreen document details and project structure ([7ade312](https://github.com/jvillegasd/media-bridge/commit/7ade3120634ee1f8233059053469583f3497f116))
* HLS videos ([#1](https://github.com/jvillegasd/media-bridge/issues/1)) ([dd10ae7](https://github.com/jvillegasd/media-bridge/commit/dd10ae75f4c192631dde10d0b8ea0c7b2ff63af2))
* release config ([#14](https://github.com/jvillegasd/media-bridge/issues/14)) ([d56bb03](https://github.com/jvillegasd/media-bridge/commit/d56bb036863de755dd275ed4866245647d331436))
* release-please: Added Github actions for Releases ([#3](https://github.com/jvillegasd/media-bridge/issues/3)) ([a45fb67](https://github.com/jvillegasd/media-bridge/commit/a45fb67896bcc8f93b8da9bdbea130f539b8fbd5))
* update build-release workflow for release asset handling ([#7](https://github.com/jvillegasd/media-bridge/issues/7)) ([4e5af73](https://github.com/jvillegasd/media-bridge/commit/4e5af73d9e5a56bf06be775f8dbca55d3b9a8a14))


### 🐛 Bug Fixes

* build: Build conditionally in release-please workflow ([#9](https://github.com/jvillegasd/media-bridge/issues/9)) ([390c7e0](https://github.com/jvillegasd/media-bridge/commit/390c7e092f10146b874fbeadf4bc24e589e401f2))
* fixed release please action ([#4](https://github.com/jvillegasd/media-bridge/issues/4)) ([63b9583](https://github.com/jvillegasd/media-bridge/commit/63b958320720266f401e9803eca5ade7db64b095))

## [1.1.1](https://github.com/jvillegasd/media-bridge/compare/v1.1.0...v1.1.1) (2025-11-22)


### Bug Fixes

* build: Build conditionally in release-please workflow ([#9](https://github.com/jvillegasd/media-bridge/issues/9)) ([390c7e0](https://github.com/jvillegasd/media-bridge/commit/390c7e092f10146b874fbeadf4bc24e589e401f2))

## [1.1.0](https://github.com/jvillegasd/media-bridge/compare/v1.0.1...v1.1.0) (2025-11-22)


### Features

* update build-release workflow for release asset handling ([#7](https://github.com/jvillegasd/media-bridge/issues/7)) ([4e5af73](https://github.com/jvillegasd/media-bridge/commit/4e5af73d9e5a56bf06be775f8dbca55d3b9a8a14))

## 1.0.0 (2025-11-22)


### Features

* Enable HLS and M3U8 detection, Dark theme ([#2](https://github.com/jvillegasd/media-bridge/issues/2)) ([ae8f8b1](https://github.com/jvillegasd/media-bridge/commit/ae8f8b11b92bcf8c5cb6fa13292c2f0358a9715b))
* Enhance README with offscreen document details and project structure ([7ade312](https://github.com/jvillegasd/media-bridge/commit/7ade3120634ee1f8233059053469583f3497f116))
* HLS videos ([#1](https://github.com/jvillegasd/media-bridge/issues/1)) ([dd10ae7](https://github.com/jvillegasd/media-bridge/commit/dd10ae75f4c192631dde10d0b8ea0c7b2ff63af2))
* release-please: Added Github actions for Releases ([#3](https://github.com/jvillegasd/media-bridge/issues/3)) ([a45fb67](https://github.com/jvillegasd/media-bridge/commit/a45fb67896bcc8f93b8da9bdbea130f539b8fbd5))


### Bug Fixes

* fixed release please action ([#4](https://github.com/jvillegasd/media-bridge/issues/4)) ([63b9583](https://github.com/jvillegasd/media-bridge/commit/63b958320720266f401e9803eca5ade7db64b095))
