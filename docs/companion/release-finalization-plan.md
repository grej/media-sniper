# Media Sniper companion release finalization plan

- **Status:** Accepted and implemented for release validation
- **Target:** `1.13.0`
- **Primary browser:** Brave Stable on macOS
- **Primary distribution:** One-line Pixi installer from `anaconda.org/gjennings`
- **Fallback distribution:** Development DMG and extension ZIPs on GitHub Releases
- **Last updated:** 2026-08-29

## 1. Outcome

Ship one Media Sniper experience that:

- uses browser-native media detection first;
- falls back to the local yt-dlp companion automatically when browser detection
  finds nothing, with an explicit manual fallback when the user wants it;
- presents one Download/Clip control surface regardless of backend;
- never asks the user to construct or run a yt-dlp or FFmpeg command;
- installs from the publisher's Anaconda.org channel without a Git checkout;
- never replaces or reads an end user's globally installed yt-dlp, FFmpeg, Deno,
  Python, or configuration;
- periodically detects new Media Sniper releases and gives the user a clear,
  non-blocking update prompt; and
- finishes a full update with one in-extension reload rather than requiring the
  user to visit `brave://extensions` or restart Brave.

This document finalizes distribution and update work that sits on top of
[ADR 0002](../adr/0002-yt-dlp-native-companion.md). ADR 0002 remains the source
of truth for the native protocol, authentication boundaries, clipping behavior,
and managed-tool security model.

## 2. Decisions fixed for this release

### 2.1 Pixi is an installer transport, not the runtime

The public installation command will be:

```bash
pixi exec --force-reinstall \
  --channel gjennings \
  --channel conda-forge \
  media-sniper-installer
```

The command creates a temporary Pixi environment, runs the explicit
`media-sniper-installer` entry point, and may leave only ordinary Pixi download
cache behind. The installed extension, native host, and managed tools must not
refer to that environment. Deleting Pixi's exec cache after installation must
not break Media Sniper.

Do not use a Conda post-link script. Installation must occur only because the
user explicitly invoked the installer entry point. The package must not require
`--run-post-link-scripts`.

### 2.2 The installed runtime remains private and versioned

The installer continues to own only the current user's Media Sniper directory:

```text
~/Library/Application Support/Media Sniper/
  Extension/
  Companion/host/media-sniper-companion
  tools/
    active-version
    previous-version
    versions/<tool-release>/bin/{yt-dlp,ffmpeg,ffprobe,deno}
  install-receipt.json
  output-receipts/
  runtime-home/
```

The native host resolves canonical executable paths below the active managed
tool directory, clears the inherited environment, and supplies a controlled
`PATH`. Installation must not create, replace, link, or modify tools in
`/usr/local/bin`, `/opt/homebrew`, `~/.local/bin`, `~/.pixi/bin`, or another
global environment. A user's `which yt-dlp` result must be unchanged before and
after installation.

### 2.3 Release 1 uses one atomic version train

For the first public companion release, extension, native-host, installer, and
managed-tool changes ship as one Media Sniper release version. Even a release
whose principal change is a newer yt-dlp increments the Media Sniper patch
version and republishes the complete installer package.

This avoids a second update channel and makes rollback unambiguous. A future
release may activate a tool-only bundle without reloading the extension, but
that optimization is not required before this release.

### 2.4 Development distribution does not require an Apple account

The Pixi package and GitHub fallback may contain the distinctly named
`--development` DMG produced by the repository. Installer apps are ad-hoc signed
and are not represented as Developer ID signed or Apple notarized.

Developer ID signing and notarization remain a later distribution enhancement,
not a release blocker for the Pixi-first path. The release notes must state the
artifact's trust status truthfully. Gatekeeper behavior must be tested on a
clean macOS account rather than assumed.

## 3. Anaconda.org installer package

### 3.1 Package identity

Publish platform packages to `anaconda.org/gjennings`:

- package: `media-sniper-installer`;
- executable: `media-sniper-installer`;
- subdirs: `osx-arm64` and `osx-64`;
- package version: exactly the Media Sniper release version; and
- build number: incremented only when repackaging the same source release.

Pixi must choose the package matching the current Mac architecture. The
installer must reject an architecture mismatch before modifying an existing
installation.

### 3.2 Package contents

The Conda package contains a small launcher and the already-built release
payload. It must not build Rust, TypeScript, Swift, yt-dlp, or FFmpeg on the
user's Mac. Users need only Pixi and Brave or Chrome; they do not need Git,
Node, Rust, Python, Homebrew, Xcode, or a separate yt-dlp.

The package must contain or retrieve from a fixed release asset:

- the companion extension with its stable manifest key and extension ID;
- the native host for the package architecture;
- the managed yt-dlp, FFmpeg, ffprobe, and Deno payload;
- tool and release metadata plus detached signatures;
- compatibility metadata and third-party notices; and
- the graphical installer and uninstaller.

Prefer embedding the release payload in the Conda package for the first
release. This lets Pixi and Anaconda package hashes cover the transport and
avoids a second network download implementation. The graphical installer must
still perform its existing manifest, signature, hash, path, and health checks
before activation.

### 3.3 Installer entry point

`media-sniper-installer` must:

1. locate its package-owned payload without depending on the current directory;
2. verify that it is running on a supported macOS architecture;
3. launch the graphical installer and wait for it to finish;
4. propagate cancellation or failure as a nonzero exit code;
5. print only concise recovery guidance, never commands for yt-dlp/FFmpeg;
6. preserve downloads, history, output receipts, and a previous healthy tool
   version during an upgrade; and
7. exit successfully only after the per-user host registration, extension
   files, managed tools, activation marker, and install receipt are present.

The installer should reveal the installed extension folder only on a fresh
installation. During an upgrade it should tell the user to return to the Media
Sniper update prompt and choose **Finish update**.

### 3.4 Local package test

Before upload, the release workflow must build a local Conda channel and prove
that the exact public command works when `gjennings` is replaced by that local
channel. Tests must not rely on a developer checkout after package creation.

## 4. Release metadata and periodic checks

### 4.1 Advisory metadata source

The companion extension checks the fixed Anaconda API record for
`gjennings/media-sniper-installer`. The remote response is advisory only: it can
cause an update badge or prompt, but it cannot supply an executable path,
command, channel, shell text, arbitrary link, or native-host request.

The extension hardcodes:

- the Anaconda API origin and package identity;
- the Pixi update command shown above;
- the human-readable update help URL; and
- the accepted metadata schema and size limit.

For v1, the extension needs only the latest stable SemVer and evidence that a
package exists for the current macOS architecture. Reject malformed versions,
responses larger than 64 KiB, non-HTTPS redirects, unexpected content types,
and responses that do not describe the expected package owner/name. Use a
short timeout. Never evaluate or render remote HTML.

### 4.2 Schedule

Add `chrome.alarms` to the companion variant only and implement an
`update-check` background alarm:

- first automatic check: randomized 5-30 minutes after Brave starts;
- subsequent checks: no more than once every 24 hours;
- manual **Check for updates**: bypasses the cached result;
- network failure: retain the last successful result and remain silent;
- retry: wait for the next normal alarm rather than creating a tight loop; and
- active downloads/clips: checking is allowed, but no update action interrupts
  a job.

Persist only:

- `lastSuccessfulCheckAt`;
- `latestVersion`;
- `latestVersionPublishedAt` when available;
- `dismissedVersion`;
- `snoozeUntil`; and
- a coarse last failure time for diagnostics.

Do not send page URLs, media URLs, cookies, download history, identifiers, or
analytics with the update request.

### 4.3 Version comparison

Compare the latest package version with:

- `chrome.runtime.getManifest().version`;
- the native companion version returned by `hello_result`; and
- the installed release/tool identifiers returned by the companion.

Extend `hello_result` and `install-receipt.json` so the extension can distinguish
the installed release from the currently executing extension:

```ts
interface InstalledReleaseInfo {
  releaseVersion: string;
  extensionVersion: string;
  companionVersion: string;
  toolReleaseId: string;
  installedAt: string;
}
```

The native host reads this fixed receipt itself. The extension never receives
an arbitrary filesystem path.

## 5. Update user experience

### 5.1 Available update

Use a badge and an in-popup banner, not an interrupting modal or automatic
desktop notification:

> **Media Sniper update available**
>
> Includes newer site support and media tools.
>
> **Copy update command** · **Check installation** · **Remind me later**

Rules:

- show one prompt per newer version;
- **Remind me later** snoozes that version for seven days;
- Settings includes **Check for updates** and the last successful check time;
- an explicit stale-tool health failure surfaces the banner immediately even
  if the periodic check is not due; and
- never show raw yt-dlp warnings or Anaconda response data.

**Copy update command** copies the hardcoded Pixi command and opens a concise
instruction view. The extension must not launch a terminal, execute Pixi,
download an executable, or grant itself new native authority.

### 5.2 Detecting completed installation

After the user runs the Pixi command and graphical installer, **Check
installation** must:

1. refuse to disturb an active companion job;
2. disconnect the current native messaging port;
3. establish a new port so Brave launches the newly installed host;
4. request `hello_result` and installed release information; and
5. show **Finish update** only when the on-disk release is newer than the
   executing extension and all health checks pass.

If installation did not complete, keep the current version active and show a
specific recovery action. Do not clear the update prompt merely because the
user copied the command.

### 5.3 One-click extension reload

For the unpacked extension path, replacing files on disk does not update the
already-running extension process. **Finish update** performs the required
reload without sending the user to `brave://extensions`:

1. disable the button while any browser or companion download is active;
2. record a `pendingPostUpdate` marker containing the expected version, active
   tab ID, and the active tab's normalized HTTP(S) URL;
3. label the action **Finish update and refresh this page** so the page refresh
   is explicit;
4. call `chrome.runtime.reload()`;
5. on the new extension's `runtime.onInstalled` update event, validate the
   marker and installed version;
6. reload only the recorded tab, and only if it is still on the recorded URL;
7. reconnect to the native host and clear the badge after health succeeds; and
8. clear the marker on success or after a bounded expiry.

Do not reload every open tab. Other already-open tabs may continue normally;
if their old content-script context is invalid, Media Sniper should offer its
existing **Refresh page** action when the user next opens the popup there.

A Brave restart is fallback recovery only, not the happy path.

## 6. Implementation work

### Workstream A: consolidate the feature branch

- Complete review of `feat/yt-dlp-native-companion`.
- Merge the branch without modifying the known-working standard build.
- Preserve separate standard and companion artifacts and the standard artifact
  isolation check.
- Bump the selected release version consistently in the extension manifest,
  package metadata, compatibility metadata, native host, and package recipe.

### Workstream B: Pixi/Conda installer distribution

- Add a `recipe/recipe.yaml` for `media-sniper-installer`.
- Add the package-owned launcher with no post-link behavior.
- Build `osx-arm64` and `osx-64` packages from reviewed release payloads.
- Add reproducible package build, content inspection, local-channel install,
  and Anaconda upload tasks.
- Add channel labels so a candidate can be tested before promotion to `main`.
- Document the one-line install/update command as the primary path.

### Workstream C: update state and scheduler

- Add companion-only alarm permission and background update service.
- Add strict Anaconda response parsing, SemVer comparison, caching, snooze, and
  manual checking.
- Add update badge, popup banner, settings status, and copy-command behavior.
- Keep all update UI out of the standard extension artifact.

### Workstream D: installed-release handshake and reload

- Extend the installer receipt and native health response.
- Make **Check installation** restart the native connection and validate the new
  release.
- Add active-job gating and the `pendingPostUpdate` state machine.
- Implement `chrome.runtime.reload()` plus the bounded active-page refresh.
- Preserve history, settings, drafts, and downloads across the reload.

### Workstream E: documentation and recovery

- Update install, update, privacy, compatibility, release-validation, and
  use-and-recovery documents.
- Clearly distinguish Pixi transport, app-private runtime, development DMG,
  and future Developer ID distribution.
- Document offline checks, snoozing, failed installs, Brave reload fallback,
  uninstall, and rollback.
- Include third-party notices and exact managed-tool versions in every package.

## 7. Automated release gates

The candidate must pass all existing checks plus the new installer/updater
tests:

```text
npm run type-check
npm test
cargo fmt -- --check
cargo test
npm run build:variants
npm run package:extensions
npm run package:check
```

Add tests for:

- update alarm creation and 24-hour throttling;
- startup jitter without duplicate alarms;
- strict metadata size/schema/owner/package/platform validation;
- SemVer comparison, downgrade rejection, and same-version behavior;
- offline and timeout behavior;
- badge/banner, copy command, manual check, and seven-day snooze;
- stale-tool health forcing the update banner;
- standard artifact containing no companion updater code, Anaconda origin, or
  Pixi command;
- package file list and absence of post-link scripts;
- installer independence from its Pixi environment after completion;
- install receipt and `hello_result` version agreement;
- **Check installation** restarting the native connection;
- active jobs blocking **Finish update**;
- `pendingPostUpdate` validation and expiry;
- extension reload followed by only the approved active-tab refresh; and
- failed/tampered updates preserving the previous healthy installation.

## 8. Clean-machine acceptance matrix

At minimum, record evidence for Apple silicon with Brave Stable. Intel artifacts
must be built and package-inspected; an Intel smoke test is required before
claiming tested Intel support.

### Fresh install

- Start with Pixi and Brave but no Git checkout, Node, Rust, Python, Homebrew
  yt-dlp, or Media Sniper files.
- Run the published one-line command.
- Complete the graphical installer.
- Load the stable extension folder once in Brave.
- Confirm the stable extension ID and native connection.
- Confirm browser-first detection on X or another browser-detectable site.
- Confirm automatic yt-dlp fallback on YouTube.
- Confirm manual yt-dlp fallback and **Back to detected media**.
- Confirm MP4 download, current-position clip, and explicit audio-only download.
- Confirm all outputs appear under `Downloads/Media Sniper`.

### Isolation

- Record `which yt-dlp` and any existing yt-dlp version before installation.
- Confirm they are unchanged afterward.
- Delete the temporary Pixi exec environment/cache and confirm Media Sniper
  still downloads and clips.
- Confirm no user yt-dlp configuration or plugin affects companion behavior.

### Update

- Install release N, publish candidate N+1 to a test label, and point only the
  test build at that label.
- Confirm the scheduled check is cached and non-blocking.
- Confirm badge/banner and snooze behavior.
- Run the one-line update command.
- Confirm the old extension reports **Finish update** only after a new healthy
  host is observed.
- Confirm one click reloads the extension and approved active page without a
  Brave restart or manual Extensions-page action.
- Confirm history, settings, clip drafts, outputs, and previous tools remain.
- Confirm a download active during update prevents reload until it finishes.

### Failure and rollback

- Test offline Anaconda API, malformed metadata, unavailable architecture,
  cancelled installer, tampered payload, failed tool health, insufficient disk,
  and interrupted native connection.
- Confirm none of these cases replaces the active healthy version.
- Confirm the previous managed-tool version can be reactivated.
- Confirm the user gets a concise recovery action without raw paths, commands,
  cookies, or tool diagnostics.

## 9. Publishing sequence

1. Freeze the release commit and select the final SemVer.
2. Run all automated gates on the exact commit.
3. Build both extension variants and architecture-specific native payloads.
4. Build development DMGs, checksums, compatibility tables, notices, and Conda
   packages.
5. Inspect package contents and run the local-channel acceptance test.
6. Upload packages to a non-`main` Anaconda label.
7. Run fresh-install and N-to-N+1 update acceptance against that label.
8. Create the Git tag and GitHub release with source, extension ZIPs,
   development DMGs, checksums, and clear trust-status notes.
9. Promote the tested Anaconda packages to the `main` label.
10. Verify the public one-line command on a clean account.
11. Verify that an older installed extension discovers the new version and can
    complete the one-click reload flow.
12. Record versions, hashes, browser/macOS versions, and acceptance evidence in
    the release notes.

## 10. Definition of done

The release is ready when a Brave user with Pixi can install from the Anaconda
channel using one command, load the extension once, and thereafter download,
clip, select audio-only, receive update prompts, run the same one-line update,
and finish the update with one in-extension action. They must never need to
clone the repository, manage yt-dlp/FFmpeg, edit `PATH`, visit the extension
developer page for routine updates, or restart Brave on the normal path.
