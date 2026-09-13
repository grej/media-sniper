# Third-party notices

Media Sniper is derived from Media Bridge 1.11.0 and remains licensed under the
upstream MIT License. Its dependencies and managed native tools retain their
own licenses. The release's signed managed-tool manifest records the exact
versions and hashes shipped for each platform.

## Mediabunny

Mediabunny 1.54.0 is used as an unmodified npm dependency for browser-native
media input, conversion, and output. Copyright (c) 2026-present, Vanilagy and
contributors. It is licensed under the Mozilla Public License 2.0:
<https://mozilla.org/MPL/2.0/>.

## yt-dlp

The yt-dlp source is distributed under The Unlicense. This installer bundles
the official PyInstaller macOS executable, whose combined work is GPLv3+
because it includes third-party components. The payload includes the upstream
third-party license notice and GPLv3 text. Source and license information:
<https://github.com/yt-dlp/yt-dlp>.

## yt-dlp-ejs and solver dependencies

The pinned official yt-dlp executable embeds the matching yt-dlp-ejs YouTube
challenge solver. yt-dlp-ejs is distributed under The Unlicense. Its embedded
prebuilt distribution includes Meriyah under the ISC License and Astring under
the MIT License. Source, license, and version information:
<https://github.com/yt-dlp/ejs>.

## FFmpeg and ffprobe

FFmpeg and ffprobe 8.0.3 are built together from source, with a statically linked
x264 at revision b35605ace3ddf7c1a5d67a2eb553f034aef41d55. This GPL-enabled
configuration is GPL 2.0 or later and does not enable nonfree components.
The matching FFmpeg/x264 source archives and build script accompany the GitHub
release in the media-tools source archive; license texts and build configuration
are also included in the tool payload. Pinned upstream URLs and checksums are
recorded in `provenance/sources.json`. License information:
<https://ffmpeg.org/legal.html>.

## Deno JavaScript runtime

Deno provides the managed JavaScript runtime used by the tested yt-dlp
extractor configuration. Deno is licensed under the MIT License. Source and
license information: <https://github.com/denoland/deno>.

## Chromium browser APIs

The extension uses Chromium extension APIs as implemented by Brave and Chrome.
Those browsers are not redistributed in the companion package.
