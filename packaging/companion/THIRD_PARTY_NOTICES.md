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

yt-dlp is distributed under The Unlicense, with third-party components under
their respective terms. Source and license information:
<https://github.com/yt-dlp/yt-dlp>.

## yt-dlp-ejs and solver dependencies

The pinned official yt-dlp executable embeds the matching yt-dlp-ejs YouTube
challenge solver. yt-dlp-ejs is distributed under The Unlicense. Its embedded
prebuilt distribution includes Meriyah under the ISC License and Astring under
the MIT License. Source, license, and version information:
<https://github.com/yt-dlp/ejs>.

## FFmpeg and ffprobe

FFmpeg and ffprobe are shipped from one reviewed build configuration. FFmpeg is
licensed under LGPL 2.1 or later by default; configurations that enable GPL
components are GPL 2.0 or later. The release record must identify the exact
configuration and corresponding source offer:
<https://ffmpeg.org/legal.html>.

## Deno JavaScript runtime

Deno provides the managed JavaScript runtime used by the tested yt-dlp
extractor configuration. Deno is licensed under the MIT License. Source and
license information: <https://github.com/denoland/deno>.

## Chromium browser APIs

The extension uses Chromium extension APIs as implemented by Brave and Chrome.
Those browsers are not redistributed in the companion package.
