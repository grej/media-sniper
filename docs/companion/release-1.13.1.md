# Media Sniper 1.13.1 release record

Release date: 2026-09-13.

## Audio downloads

The yt-dlp **Audio only (MP3)** choice now saves high-quality variable-bitrate
MP3. Pages whose formats are all known to contain only audio select this
choice automatically. Video pages retain their existing video choices.
Audio clips and the approved full-source fallback also produce MP3.

When supplied by the extractor, the file includes track title, artist,
album, album artist, release year, track/disc number, and genre. Existing
source tags are preserved where possible. Missing music fields stay
unfilled: an uploader is not substituted for an artist, and the upload
date is not substituted for a release year. No music database lookup or
guessing from the page title is performed.

Both Mac installers include FFmpeg/ffprobe 8.0.3 with statically linked
LAME 3.100 and x264. The existing yt-dlp 2026.08.19 executable includes
EJS 0.8.0; Deno remains 2.6.9. No separate encoder installation is needed.

## Distribution and rebuild inputs

The release contains both extension ZIP variants, Apple Silicon and Intel
installer disk images, their exact Conda installer packages, signed tool
metadata, source archives, and SHA-256 checksums. Conda publication uses
the [verified GitHub-to-Anaconda workflow](publishing-conda.md).
Disk images are ad-hoc signed development distributions; they are not
Developer ID signed or Apple notarized.

Follow the [1.13.0 rebuild instructions](release-1.13.0.md#rebuilding), adding
the pinned LAME archive to `.build/portable-media/downloads` and extracting
it at `.build/portable-media/sources/lame` before building FFmpeg. The current
build script builds and statically links LAME for both architectures.
The matching LAME, FFmpeg, x264, and yt-dlp source archives, licenses, build
script, both FFmpeg configurations, and [source pins](../../packaging/managed-tools/sources.json)
accompany this release. The external private signing key is never included.

## Validation performed

- TypeScript checking and all 332 extension unit/integration tests.
- Rust formatting, Clippy with warnings denied, 49 unit tests, and all
  10 native protocol integration tests.
- An additional real-tool test creates MP3s with the bundled encoder and
  inspects the resulting tags. Cases cover supplied music tags, multiple
  artists, release-year precedence, release-date fallback, missing metadata,
  existing MP3 tags, and Fast/Exact fallback clips. The test uses controlled
  local fixtures and the production download arguments.
- A production-mode host in an isolated application directory activates the
  signed bundle and completes a public-fixture probe, video download, Exact
  video clip, MP3 download, and Exact MP3 clip. ffprobe verifies the audio
  codec and requested two-second audio duration. The sanitized report
  accompanies the release.
- Both Rust architectures, extension archive checks, installer/uninstaller
  builds, disk-image integrity, app signatures, property lists, executable
  architectures, signed payload hashes, and both Conda package payload tests.

Not performed: interactive installation into a fresh macOS account,
execution on a physical Intel Mac, real-site YouTube challenge/authentication
acceptance, and Apple notarization. Metadata availability depends on the site.

To rerun the real MP3 test after assembling the Apple Silicon tool bundle:

```sh
MEDIA_SNIPER_REAL_TOOLS="$PWD/artifacts/managed-tools-arm64-v1.13.1/payload/bin" \
  cargo test --locked --manifest-path companion/Cargo.toml \
  real_mp3_download_metadata_and_fallback_clips -- --ignored
```
