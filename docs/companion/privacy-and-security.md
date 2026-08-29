# Companion privacy and security

The companion edition adds a local native program with the same file and
process privileges as the signed-in macOS account. Media Sniper constrains that
boundary to explicit extension actions and companion-owned locations.

## Data used for an operation

- An anonymous analysis sends the current public HTTP or HTTPS page URL to the
  local native host. yt-dlp contacts the media site needed to resolve it.
- Signed-in access is attempted only after **Retry using this Brave session**.
  The preferred mode reads cookies applicable to the active top-level page from
  that tab's cookie store, then passes scoped cookie records directly to the
  native host.
- The page's effective User-Agent and Referer accompany authenticated work.
  Cookie values are never placed in process arguments or global request
  headers.
- Brave-profile access is an explicitly disclosed advanced fallback. It can
  expose cookies across related domains and may cause a Keychain prompt. On
  macOS only, that mode gives yt-dlp a fixed search path containing the managed
  tool directory plus `/usr/bin` and `/bin`, because Chromium cookie decryption
  calls the system `security` Keychain client. Anonymous and current-tab work
  retain the managed-tool-only path; the caller's environment is never restored.

Job-specific cookie jars and temporary directories use current-user-only
permissions and are removed on success, failure, cancellation, timeout, and
stale-job recovery. Private-window current-tab access is used only when Brave
provides the correct private cookie store; profile mode does not claim access
to an ephemeral private session.

## Data retained

History may retain the backend, canonical page URL, extractor and media IDs,
title, selected quality label, requested and actual clip details, final local
path, container, byte size, timestamps, and a stable error code. It does not
retain probe tokens, cookies, authorization values, raw yt-dlp results, signed
format URLs, request headers, or full command lines.

Media bytes never travel through native messaging. yt-dlp and FFmpeg write to a
job directory, and only the completed file is atomically moved under
**Downloads/Media Sniper**. The extension receives a bounded completion
receipt, not the file contents.

Before every production yt-dlp launch, the host resolves the initial page name
and rejects empty, mixed, loopback, link-local, or private DNS answers. This
resolution has a five-second deadline and completes before the host creates a
job directory or materializes current-tab cookies. This closes split-horizon
and simple rebinding paths at launch time. Redirect-time
address confinement inside the managed yt-dlp transport remains a release
security consideration: acceptance must test redirect behavior, and the
managed runtime must remain patched and tightly configured.

## Installation and updates

The companion extension has a checked public manifest key and the stable ID
`dioapemglpdpmfmoekckbpenmpdgkofp`. The native-host manifest allows only the
exact origin `chrome-extension://dioapemglpdpmfmoekckbpenmpdgkofp/`; wildcard
origins are rejected by release checks.

Managed yt-dlp, embedded yt-dlp-ejs, FFmpeg, ffprobe, and Deno releases have an Ed25519-signed
manifest covering every file's path, size, executable bit, and SHA-256. A new
version is staged and health-checked before activation. One prior known-good
version remains for rollback. Production never invokes yt-dlp's self-updater or
loads user configuration, arbitrary plugins, arbitrary process arguments, or
tools found on the account's search path. The YouTube solver is embedded in the
pinned official yt-dlp executable, and production explicitly disables remote
component downloads from npm and GitHub.

The standard Web Store candidate is compiled separately. Its release check
case-insensitively rejects generic and concrete companion identifiers—including
native-messaging APIs, the host name, stable extension ID, `COMPANION_` message
names, `yt-dlp`, and cookie permission markers—in emitted JavaScript and textual
resources, in addition to inspecting manifest permissions. Opaque vendored
WASM, images, and fonts are checked as pinned binary dependencies rather than
searched for unrelated diagnostic words.
