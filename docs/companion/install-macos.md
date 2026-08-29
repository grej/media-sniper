# Install the Media Sniper companion on macOS

The companion edition is designed for Brave Stable and also supports Chrome
Stable. Installation and everyday use do not require Terminal, Homebrew,
Python, Node, or a separately installed copy of yt-dlp or FFmpeg.

## Install

1. Download the macOS companion disk image from the Media Sniper release page.
   Choose the Apple silicon or Intel build that matches the Mac. Release files
   are signed and notarized; macOS checks the app before it opens.
2. Open the disk image in Finder, then open **Install Media Sniper Companion**.
3. Review the explanation and choose **Install**. The app installs the native
   host and signed media tools only for the current macOS account. It registers
   the exact Media Sniper extension origin for Brave and Chrome.
4. Finder selects the installed extension folder. In Brave, open the Extensions
   page, enable **Developer mode**, choose **Load unpacked**, and select that
   folder. This off-store build has a stable extension identity even after an
   update.
5. Open Media Sniper and choose **Check again**. Setup is complete only when the
   extension reports **Companion ready**. A browser restart is requested only
   if Brave cannot refresh native-host registration while it is running.

If the extension says **Tools required**, choose **Install tools**. The
extension verifies the signed tool set, shows progress, runs a health check,
and activates it. It retains the previous healthy tool set for rollback.

## Update

Media-tool updates appear inside Media Sniper as **Update tools**. The update is
downloaded into a new versioned directory and becomes active only after its
signature, hashes, and health check pass. If activation fails, Media Sniper
keeps using the previous healthy release and offers **Try again**.

For a native-host or extension update, open the newer signed disk image and run
the installer again. Existing downloads and the previous healthy tool release
are preserved. Return to the extension and choose **Check again**.

## Uninstall

1. Open **Uninstall Media Sniper Companion** from the release disk image.
2. Choose **Uninstall** in the confirmation window. It removes only Media
   Sniper's per-user native host, managed tools, and matching browser
   registrations. Files in **Downloads/Media Sniper** remain.
3. On Brave's Extensions page, choose **Remove** for Media Sniper if the
   extension should also be removed.

The uninstaller refuses to delete a native-host registration whose name and
allowed extension origin do not exactly match this release.
