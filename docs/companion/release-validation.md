# Companion release validation

This checklist supplements the browser-native release gates in
`docs/release-validation.md`. Maintainer commands are intentionally confined to
this release document; end-user installation, updates, recovery, and uninstall
remain graphical.

This checklist remains the gate for Developer ID-signed production artifacts.
For the Pixi-first development release, periodic update prompt, and one-click
unpacked-extension reload sequence, see
[Media Sniper companion release finalization plan](release-finalization-plan.md).

## Pixi and Anaconda candidate

- Build the architecture-specific development DMG from the frozen release
  commit, then stage it with `npm run package:conda:stage -- --dmg <dmg> --subdir
  <osx-arm64|osx-64>`.
- Run `pixi run package:conda` and `pixi run package:conda:inspect`. Confirm the
  package contains the graphical DMG, fixed launcher, release/subdir markers,
  and no post-link script or runtime dependencies.
- From the local channel, run `pixi run package:conda:local-test` in a clean
  macOS account. After installation, remove the temporary Pixi exec environment
  and confirm Media Sniper still probes, downloads, and clips.
- Build and inspect both macOS subdirs before `pixi run
  package:conda:upload-candidate`. Promote the exact tested files with `pixi run
  package:conda:upload-main`; do not rebuild between candidate testing and main.
- Record that the development DMG is ad-hoc signed and not notarized. Do not use
  the production-signing checklist below to imply Developer ID trust for this
  Pixi-first artifact.

## Update and reload acceptance

- Confirm startup creates one randomized 5–30 minute alarm and subsequent
  checks remain throttled for 24 hours.
- Test offline, timeout, oversized, malformed, wrong-owner, wrong-package,
  prerelease, downgrade, missing-subdir, and non-main-label responses. None may
  change an installed component or render remote text.
- Install release N+1 while N is executing. **Check installation** must restart
  the native connection and show **Finish update** only when the receipt, host,
  tools, and extension versions agree and health is green.
- Start a browser and companion download and confirm each blocks **Finish
  update**. After completion, verify one click reloads the extension and only
  the explicitly named current HTTP(S) tab. Confirm an expired or mismatched
  marker refreshes no tab.

## Compile-time separation

- Build `standard` and `companion` Vite modes from clean output directories.
- Confirm the standard manifest has neither a public key, `nativeMessaging`,
  nor optional `cookies`.
- Case-insensitively byte-scan every standard executable bundle and textual
  package entry for the full reviewed marker set, including `companion`,
  `COMPANION_`, native-messaging spellings, `connectNative`, `sendNativeMessage`,
  `cookies`, `yt-dlp`, the native-host name, and the companion extension ID. A
  manifest-only check is insufficient. Opaque vendored WASM, image, and font
  payloads remain pinned by dependency/package hashes; the reviewed browser
  FFmpeg WASM contains an unrelated libcurl cookie diagnostic and is not parsed
  as extension source.
- Confirm the companion key derives
  `dioapemglpdpmfmoekckbpenmpdgkofp` and that its optional cookie permission is
  requested only from a user gesture.
- Confirm dead-code elimination removed companion dynamic-import chunks and
  messages from the standard artifact.

## Native and managed-tool release

- Require CI to run locked Rust formatting, Clippy with warnings denied, unit
  tests, and the fake-tool integration feature. Build the Rust host for macOS
  arm64 and x86_64 with locked dependencies. Swift/AppKit compilation remains a
  macOS release gate because the primary CI verification job runs on Ubuntu.
- Assemble reviewed yt-dlp, FFmpeg, ffprobe, and Deno payloads. Record exact
  versions, upstream source URLs, FFmpeg configuration, licenses, and source
  offer where required.
- Developer ID-sign the native host and each managed executable (`yt-dlp`,
  `ffmpeg`, `ffprobe`, and `deno`) individually before generating the signed
  tool manifest. Signing afterward changes the hashed bytes and invalidates the
  release. The production DMG builder rejects missing or ad-hoc payload
  signatures before packaging.
- Require a pinned official yt-dlp executable whose signed provenance records
  the matching embedded yt-dlp-ejs version and binary hash. Reject Deno older
  than 2.3.0, a missing solver attestation, or any release that permits remote
  component fetching. Exercise YouTube challenge solving with networking
  limited to the media site rather than npm or GitHub component downloads.
- Generate a tool manifest with the offline Ed25519 release key. Verify the
  detached signature and every size, executable bit, and SHA-256 using the
  checked-in public key before packaging.
- Confirm custody of the private key matching the pinned public key under the
  process in [Managed-tool release key](release-key-provisioning.md). Public
  metadata alone is not evidence that the release can be signed.
- Build the installer and uninstaller apps with both `--sign-identity` and
  `--notary-profile`. Production output is refused unless notarization succeeds
  and the stapled ticket validates. `--development` produces a distinctly named
  non-publishable DMG and keeps local fixture builds workable.
- Inspect the installed Brave and Chrome manifests. Each must contain the
  current user's absolute host path and the one exact allowed extension origin.
- Exercise an update to a new versioned tool directory, a failed health check,
  automatic retention of the active version, a successful activation, and a
  rollback to the prior known-good version.

## Browser acceptance

- In a fresh macOS account, install from Finder and connect from Brave without
  opening Terminal. Repeat host discovery with Chrome.
- Test public YouTube and controlled non-YouTube analysis/download, cancel,
  reveal, open, 10-second Fast clip, and either validated 10-second Exact clip
  or the stable Exact-unsupported recovery.
- Test current-tab auth in two Brave profiles and an explicitly enabled private
  window. Confirm stores do not cross. Test the disclosed profile fallback and
  safe denial paths.
- Force a section fallback and confirm the full transfer starts only after
  consent, then verify complete-source cleanup in every terminal state.
- Inspect extension storage, IndexedDB, native logs, diagnostics, receipts, job
  roots, and history for secrets and raw extractor data.

## Release record

Attach both extension ZIPs and checksums, both notarized architecture disk
images and checksums, signed tool manifests and detached signatures,
compatibility metadata, third-party notices, automated test output, browser
versions, and the completed acceptance evidence table. Do not publish a
companion disk image assembled with development tools or ad-hoc signing.
