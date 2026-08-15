# Release and manual validation

This checklist is the release gate for Media Sniper. Automated checks establish
that the source builds and packages deterministically; they do not replace an
unpacked-extension smoke test in each supported Chromium browser.

## Automated release gate

Use a clean checkout with Node.js 20.19 or newer:

```bash
npm ci
npm run type-check
npm test
npm run package
npm run package:check
```

`npm run package` performs a production build, then creates:

- `artifacts/media-sniper-extension-v<version>.zip`
- `artifacts/media-sniper-extension-v<version>.zip.sha256`

The ZIP builder sorts paths byte-for-byte, stores every entry without
host-dependent compression, fixes all entry timestamps to 1980-01-01, and
excludes filesystem permissions and comments. It also packages `LICENSE` and
`THIRD_PARTY_NOTICES.md` alongside the extension files. The checksum file uses
the conventional `<digest>  <filename>` form.

To prove reproducibility locally, preserve the first output outside
`artifacts/`, package again, and compare both bytes and hashes:

```bash
npm run package
cp artifacts/media-sniper-extension-v1.12.0.zip /tmp/media-sniper-first.zip
npm run package
cmp /tmp/media-sniper-first.zip artifacts/media-sniper-extension-v1.12.0.zip
npm run package:check
```

The two `npm run package` invocations must report the same SHA-256 digest and
`cmp` must exit successfully. Also inspect the archive before upload:

```bash
unzip -t artifacts/media-sniper-extension-v1.12.0.zip
unzip -l artifacts/media-sniper-extension-v1.12.0.zip
```

Confirm that `manifest.json`, `background.js`, `content.js`, popup/options and
offscreen assets, icons, FFmpeg assets, `LICENSE`, and
`THIRD_PARTY_NOTICES.md` are present. Source maps, TypeScript/declaration files,
tests, `node_modules`, and prior artifacts must not be present.

## Security and privacy review

The M8 review found no analytics, telemetry, remote-code loading, or Media
Sniper service endpoint. Processing stays in the extension's popup, service
worker, IndexedDB, and offscreen document. Network access is limited to media
origins discovered or entered by the user and cloud destinations the user
explicitly configures. Exact and Fast processors enforce duration/byte limits
before large in-memory assembly, and direct full-file fallback requires an
explicit UI opt-in plus a known size below the configured cap.

The broad host permission is inherited from the detector/download architecture
and remains necessary to find and fetch user-selected cross-origin media. The
clipping path does not widen it. Temporary Origin/Referer DNR rules use
operation-owned IDs and are removed in terminal cleanup. Cloud credentials keep
the existing local storage/encryption behavior and are neither copied into clip
metadata nor emitted by fixtures or logs. DRM checks remain refusal-only; this
fork adds no bypass behavior. Residual risk is disclosed in the README: source
CDNs see normal media requests, exact processing can consume substantial local
memory, and site/browser codec support varies.

## Browser matrix

Record the browser version, operating system, tester, date, and result. Do not
mark the release validated until both rows pass or a documented product decision
explicitly narrows browser support.

| Browser | Version | OS | Tester/date | Result |
| --- | --- | --- | --- | --- |
| Google Chrome stable | 151.0.7922.138 | macOS 15.6.1 | Codex / 2026-08-15 | Pass — extracted ZIP loaded through Developer mode; identity, service worker, popup/options, and startup console verified. |
| Brave stable | 150.1.92.139 | macOS 15.6.1 | Codex / 2026-08-15 | Pass — extracted ZIP loaded in an isolated unpacked-extension profile; identity, service worker, popup/options, and startup console verified. |

For each browser, unpack the release ZIP to a new empty directory, open the
extensions page, enable Developer mode, and load that directory. Do not reuse a
previous `dist/` directory.

## Manual acceptance matrix

### Installation and identity

- [x] The extension installs with no manifest or CSP errors.
- [x] The extensions page and toolbar identify it as **Media Sniper** with the expected version and icons.
- [x] Popup, options, and service-worker startup/reload contain no console errors; offscreen initialization is covered by browser media spikes.
- [ ] An existing profile upgrades without losing its `media-bridge` IndexedDB download/history data or saved settings.

### Download and recording regression

- [ ] A direct MP4/WebM download saves successfully.
- [ ] HLS VOD selects the expected quality/audio and saves a playable MP4.
- [ ] DASH VOD selects the expected representation/audio and saves a playable MP4.
- [ ] HLS and DASH live recordings collect new parts, Stop & Save, and produce playable MP4 output.
- [ ] Authenticated media that needs Origin/Referer succeeds, and its temporary DNR rules disappear after success, failure, and cancellation.

### Clipping

- [ ] Direct MP4 and WebM Fast clips complete and are labeled keyframe-aligned where applicable.
- [ ] Direct Exact clips either meet the requested boundary or show a stable unsupported-codec refusal.
- [ ] HLS/M3U8 Fast and Exact clips request only the selected time window and chosen quality.
- [ ] DASH Fast and Exact clips request only selected initialization/media parts and preserve independent A/V timing.
- [ ] Byte-range sources send bounded `Range` requests; large or unknown no-Range sources are refused unless the small-source confirmation path applies.
- [ ] DRM, dynamic/no-timeline, unsupported discontinuity, and cross-Period cases fail before media-part fetching with actionable text.
- [ ] Cancelling during planning, downloading, and processing stops work and removes temporary chunks, rules, and late Blob URLs.
- [ ] Completed clip History rows show the clip badge, range, Fast/Exact mode, requested duration, accuracy, and actual duration when known.

### Playback and overlay

- [ ] The page overlay is absent by default and appears only after enabling it in Clipping settings.
- [ ] On a page with one player, start/end marks use its current playback time.
- [ ] On a page with multiple eligible players, the selected player remains stable and ambiguous selection requires user choice.
- [ ] Reloading/reopening the popup restores valid draft marks for the same tab/frame/video and does not reuse stale marks for another video.
- [ ] Overlay controls remain usable by keyboard and do not block normal page playback controls.

### Persistence and failure recovery

- [ ] Closing and reopening the popup preserves active operation progress.
- [ ] Reloading the extension does not corrupt completed history or legacy download rows.
- [ ] Network retry, source-auth failure, processing timeout, output-size limit, and disk-save failure each end in the expected terminal state.
- [ ] A failed or cancelled operation can be retried without stale chunks, header rules, or queue ownership.

## Release upload

The release workflow must call `npm run package` and `npm run package:check`,
then upload both the ZIP and `.sha256` file. Publish the digest with the release
notes. Preserve the upstream Media Bridge copyright in `LICENSE`, historical
links in `CHANGELOG.md`, and the lineage statement in `README.md`.

## Sign-off

| Gate | Owner | Date | Evidence |
| --- | --- | --- | --- |
| Type-check and tests | Codex | 2026-08-15 | 41 Vitest files / 217 tests; 4 Playwright extension E2E tests; type-check/build pass. |
| Reproducible package | Codex | 2026-08-15 | Two 33,463,780-byte, 46-entry ZIPs compared byte-identical. |
| Chrome manual matrix | Codex | 2026-08-15 | Chrome 151.0.7922.138 unpacked Developer-mode smoke pass. |
| Brave manual matrix | Codex | 2026-08-15 | Brave 150.1.92.139 isolated unpacked smoke pass. |
| Release artifact/checksum | Codex | 2026-08-15 | `media-sniper-extension-v1.12.0.zip`; SHA-256 `464bc08ca83af06a3119471fb9793ca7c305eac1474eb9cee85a845c0e0698cf`; structure and `unzip -t` pass. |
