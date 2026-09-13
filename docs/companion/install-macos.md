# Install Media Sniper Companion on macOS

Media Sniper Companion is designed for Brave Stable and also supports Chrome
Stable. The GitHub disk image includes the extension and all managed tools.
You do not need Git, a repository checkout, Pixi, Node, Rust,
Python, Homebrew, or your own yt-dlp/FFmpeg installation.

## Install

1. Open the [latest GitHub release](https://github.com/grej/media-sniper/releases/latest).
   Download the `arm64` disk image for an Apple Silicon Mac or the `x86_64`
   disk image for an Intel Mac. **About This Mac** shows your chip or processor.
2. Open the disk image, then open **Install Media Sniper Companion**.
3. Complete the graphical installer. It verifies the extension identity, signed release metadata, media
   tool hashes, architecture, and tool health before replacing any active
   component.
4. On a fresh installation, Finder selects the installed extension folder.
   Open Brave's Extensions page, enable **Developer mode**, choose **Load
   unpacked**, and select that folder. This is the only routine setup step that
   uses the Extensions page.
5. Open Media Sniper and choose **Check again**. The extension verifies the
   local connection before reporting that the companion is ready.

The package contains an architecture-specific, ad-hoc-signed development disk
image. It is not yet Developer ID signed or Apple notarized. You do not need an
Apple developer account to build or use this development distribution, but
macOS may show a trust warning. The GitHub release notes must describe this
status accurately.

### Optional Pixi launcher

The release also provides `.conda` installer packages. When
`media-sniper-installer` is published on the `gjennings` Anaconda channel, Pixi
can launch the same installer:

```bash
pixi exec --force-reinstall --channel gjennings --channel conda-forge media-sniper-installer
```

If the package is unavailable, install from the GitHub disk image above.
Pixi is only an installer transport and is not required at runtime.

## Update

Download the newer disk image from GitHub and run its installer to update.
The automatic update checker currently reads the Anaconda channel, so GitHub
releases appear there only after their Conda packages have also been published.
It checks at most once per day. When it finds an update, the popup shows
**Media Sniper update available**.

1. Run the newer disk image's installer, or choose **Copy update command** and
   run the copied Pixi command when that release is available on Anaconda.
2. Complete the graphical installer. It preserves history, downloads, output
   receipts, settings, and the previous healthy tool release.
3. Return to Media Sniper and choose **Check installation**. Media Sniper
   disconnects the old native host and verifies the newly installed receipt.
4. Choose **Finish update and refresh this page**. The extension reloads itself
   and refreshes only the page named by the button. No Brave restart or manual
   extension reload is needed on the normal path.

**Remind me later** snoozes one release for seven days. Settings → About also
offers **Check for updates**. Network failures remain silent and Media Sniper
keeps the last verified update result.

## What is installed

Everything stays below `~/Library/Application Support/Media Sniper`. The native
host uses its own versioned yt-dlp, FFmpeg, ffprobe, and Deno files. It neither
reads nor replaces tools or configuration from Homebrew, Conda, Pixi, `PATH`,
or another project. Removing Pixi's temporary execution environment after
installation does not affect Media Sniper.

## Uninstall

Open **Uninstall Media Sniper Companion** from the matching GitHub release disk
image and confirm removal. It removes only Media Sniper's per-user native host,
managed tools, installed extension files, and matching browser registrations.
Files under **Downloads/Media Sniper** remain. Remove the unpacked extension
from Brave separately if it should no longer appear in the browser.
