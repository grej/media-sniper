# Media Sniper 1.13.0 release record

Release date: 2026-09-12. This release combines the native yt-dlp companion
branch with the `.m4s` detection and download improvements on `main`.

## Distribution

The GitHub release includes standard and companion extension ZIPs, Apple
Silicon and Intel installer disk images, matching Conda installer packages,
checksums, signed tool metadata, and corresponding media-tool source archives.
The disk images contain real portable executables and are ad-hoc signed
development distributions. They are not Developer ID signed or Apple notarized.

After the initial GitHub publication, both tested Conda packages were published
to `gjennings/media-sniper-installer` with the `main` label. The
[publishing workflow](https://github.com/grej/media-sniper/actions/runs/34731901025)
verified GitHub asset digests, uploaded the unchanged packages to `candidate`,
verified Anaconda's public hashes, and promoted the exact files to `main`.
Pixi successfully resolved and retrieved both architectures from the public
channel; their launcher, disk image, version, and platform markers were checked
without launching the installer or changing the active application.
The live metadata passes the extension's update parser for both architectures:
version 1.12.0 sees the update and version 1.13.0 remains current.
See [Conda publishing](publishing-conda.md) for future releases and token rotation.

## Managed tools

| Tool | Version | Distribution |
| --- | --- | --- |
| yt-dlp | 2026.08.19 | Official universal macOS executable |
| yt-dlp-ejs | 0.8.0 | Embedded in that yt-dlp executable |
| FFmpeg / ffprobe | 8.0.3 | Built for each architecture with static x264 |
| x264 | b35605ace3ddf7c1a5d67a2eb553f034aef41d55 | Pinned stable source |
| Deno | 2.6.9 | Official architecture-specific executable |

All four executables are installed into Media Sniper's private tool directory.
FFmpeg and ffprobe link only to macOS system libraries; no Homebrew, Pixi,
Conda, or separately installed Python runtime is required.

Source URLs and checksums are in
[`sources.json`](../../packaging/managed-tools/sources.json). The source release
archive includes the matching FFmpeg, x264, and yt-dlp source tarballs, build
script, licenses, source pins, and both FFmpeg configurations.

## Rebuilding

Use macOS with Xcode command-line tools, Node, Rust, and Pixi. Download the
pinned inputs from `sources.json` and verify their SHA-256 checksums. Place
FFmpeg/x264 tarballs in `.build/portable-media/downloads`, and extract their
source trees as `.build/portable-media/sources/ffmpeg` and `sources/x264`.
Place the official yt-dlp executable, its source archive named
`yt-dlp-2026.08.19.tar.gz`, both Deno archives, and upstream notices in
`.build/tool-downloads`; extract yt-dlp source as `yt-dlp-source` there.
The assembly script names each required input and verifies archive hashes.

```sh
npm ci
npm run package
npm run package:check
pixi exec --spec nasm --spec pkg-config -- sh scripts/build-portable-ffmpeg.sh arm64 "$PWD/.build/portable-media"
pixi exec --spec nasm --spec pkg-config -- sh scripts/build-portable-ffmpeg.sh x86_64 "$PWD/.build/portable-media"
rustup target add aarch64-apple-darwin x86_64-apple-darwin
cargo build --locked --release --manifest-path companion/Cargo.toml --target aarch64-apple-darwin
cargo build --locked --release --manifest-path companion/Cargo.toml --target x86_64-apple-darwin
```

For each architecture, run `scripts/assemble-managed-tools.mjs` with `arm64`
or `x86_64` and the external release-key file. Never copy the private key into
the checkout or release assets. Pass the resulting payload, signed manifest,
signed release metadata, and matching native host to
`scripts/build-macos-companion-release.mjs --development`. See that script's
required arguments and the [release checklist](release-validation.md).

Stage and build Conda packages sequentially because the staging directory is
shared. Use `scripts/stage-conda-installer.mjs --dmg <image> --subdir
<osx-arm64|osx-64>`, then `rattler-build build --recipe recipe/recipe.yaml
--target-platform <subdir> --output-dir artifacts/release-conda`.

## Validation performed

- TypeScript checking; 332 unique unit/integration tests (three sandbox-skipped
  network tests were rerun successfully with the required local networking).
- Seven Playwright browser acceptance tests.
- Rust formatting, Clippy with warnings denied, 46 unit tests, and 10 native
  protocol integration tests.
- Both extension package checksums, variant isolation, stable extension
  identity, and native-host origin checks.
- Both Rust host architectures and both Swift installer/uninstaller builds;
  `lipo` architecture verification for each packaged executable.
- Both disk-image integrity checks, app signature verification, valid property
  lists, and the installer's own Swift checks against the mounted extension,
  signed tool manifests, and complete payload hashes.
- Both Conda package builds and their packaged launcher/payload tests.
- A production-mode native host in an isolated application directory activated
  the signed Apple Silicon bundle and completed a public-fixture probe,
  download, and Exact clip from one to three seconds. ffprobe confirmed a
  two-second clip. The sanitized report accompanies the release.

Not performed: interactive installation into a fresh macOS account, native
execution on a physical Intel Mac, real-site YouTube challenge/authentication
acceptance, and Apple notarization. The controlled public fixture used for
the native smoke test was
`https://raw.githubusercontent.com/grej/media-sniper/main/tests/fixtures/direct-faststart.mp4`.

## Fragmented MP4 scope

HLS/DASH manifests provide the initialization and ordered media fragments
needed to assemble multipart `.m4s` streams. Direct `.m4s` download is supported
when the file contains its own initialization data. A detached media fragment
does not become a complete video by changing its extension; unsupported
standalone fragments are identified accordingly.
