# Use and recovery

All media operations start and finish in Media Sniper. The companion is an
execution engine, not a second interface.

## Analyze and save a page

1. Open a public HTTP or HTTPS media page in Brave.
2. Open Media Sniper. Existing browser-detected media remains first in the
   Videos tab.
3. If browser detection finds no usable media, Media Sniper automatically asks
   the local companion to analyze the current page. When browser media is
   already available, choose **Try yt-dlp for this page** for alternate formats.
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

## Music and audio downloads

Choose **Audio only (MP3)** to save high-quality MP3 audio. Pages with only
known audio formats select this automatically. When supplied by
the source, Media Sniper embeds the track title, artist, album, album artist,
release year, track/disc number, and genre. Existing audio-file tags are
preserved where possible. Missing fields stay unfilled; upload dates and
channel names are not substituted for release years and artists.
Audio clips also use MP3, including the approved full-source fallback.

## Recovery states

| Status | Action in Media Sniper |
| --- | --- |
| Companion required | Choose **Install companion**, use the one-line Pixi installer, then **Check again**. |
| Companion incompatible | Choose **Copy update command**, complete the graphical installer, then **Check installation**. |
| Media tools required | Install the current complete Media Sniper release; tools are not updated separately in v1. |
| Update available | Choose **Copy update command**, run the graphical installer, **Check installation**, then **Finish update and refresh this page**. |
| Authentication required | Choose **Retry using this Brave session** or continue anonymously. |
| Format unavailable | Choose **Refresh analysis** and select a current option. |
| Full-source clip fallback | Review the estimated transfer and choose **Download source, then create clip**, or cancel. |
| Job interrupted | Reopen the page, choose **Analyze** again, and retry from the fresh card. |
| Disk full | Free space in Downloads and choose **Retry**; partial clips are not saved. |
| Update check offline | Continue normally. The last successful result remains cached and the next daily check retries. |
| Finish update disabled | Let the active download or clip finish, then check the installation again. |

Live and DRM-protected page results are not native clip targets in version 1.
When a compatible browser-native recording is already detected, Media Sniper
keeps that option visible.

**Copy diagnostics** produces redacted version and error information. It omits
cookies, authorization material, signed media URLs, raw extractor output,
complete process arguments, and the macOS account name.
