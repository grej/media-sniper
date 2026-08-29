# Use and recovery

All media operations start and finish in Media Sniper. The companion is an
execution engine, not a second interface.

## Analyze and save a page

1. Open a public HTTP or HTTPS media page in Brave.
2. Open Media Sniper. Existing browser-detected media remains first in the
   Videos tab.
3. Choose **Analyze this page with yt-dlp**. Media Sniper sends the page URL to
   the local companion only after this action.
4. Choose one of the reviewed quality choices, then choose **Download** or
   **Clip**. Free-form yt-dlp options and output paths are never accepted.
5. Follow planning, downloading, processing, and saving progress in the popup.
   **Cancel** stops the native job and removes owned temporary files.
6. On completion, choose **Show in folder** or **Open output**. Companion output
   is saved under **Downloads/Media Sniper**.

If a page requires a signed-in session, choose **Retry using this Brave
session**. Media Sniper explains and requests the optional cookie permission at
that point. Denying it leaves anonymous operation available. The advanced
Brave-profile fallback is broader, may show a macOS Keychain prompt, and is
never selected automatically.

## Recovery states

| Status | Action in Media Sniper |
| --- | --- |
| Companion required | Choose **Install companion**, complete the graphical installer, then **Check again**. |
| Companion incompatible | Choose **Update companion**, install the signed update, then **Check again**. |
| Tools missing | Choose **Install tools**. |
| Tools incompatible | Choose **Update tools**; the prior healthy release remains available. |
| Authentication required | Choose **Retry using this Brave session** or continue anonymously. |
| Format unavailable | Choose **Refresh analysis** and select a current option. |
| Full-source clip fallback | Review the estimated transfer and choose **Download source, then create clip**, or cancel. |
| Job interrupted | Reopen the page, choose **Analyze** again, and retry from the fresh card. |
| Disk full | Free space in Downloads and choose **Retry**; partial clips are not saved. |

Live and DRM-protected page results are not native clip targets in version 1.
When a compatible browser-native recording is already detected, Media Sniper
keeps that option visible.

**Copy diagnostics** produces redacted version and error information. It omits
cookies, authorization material, signed media URLs, raw extractor output,
complete process arguments, and the macOS account name.
