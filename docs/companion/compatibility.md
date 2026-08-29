# Companion compatibility

This table is generated from release compatibility metadata. Exact managed
tool versions are added from the signed tool manifest for each architecture;
the extension refuses an unlisted or unhealthy combination.

| Component | Supported release |
| --- | --- |
| Companion extension | 1.12.0; stable ID `dioapemglpdpmfmoekckbpenmpdgkofp` <!-- x-release-please-version --> |
| Native host | 1.12.0 on macos arm64 and x86_64 <!-- x-release-please-version --> |
| Native protocol | 1 |
| Brave Stable | Acceptance baseline 150.1.92.139 or newer compatible Stable release |
| Chrome Stable | Acceptance baseline 151.0.7922.138 or newer compatible Stable release |
| yt-dlp | Exact version in the signed managed-tool manifest |
| YouTube EJS solver | Exact embedded version recorded with the pinned official yt-dlp executable; remote fetching disabled |
| FFmpeg / ffprobe | Exact matched build versions in the signed managed-tool manifest |
| JavaScript runtime | Deno at the exact version in the signed managed-tool manifest |

A release record is incomplete if its signed manifest, compatibility metadata,
tool notices, or architecture-specific checksums are missing.
