# ADR 0002: Generic yt-dlp native companion backend

- Status: Accepted
- Date: 2026-08-29
- Primary browser: Brave Stable (Chromium MV3)
- Compatibility browser: Chrome Stable
- Scope: Off-store companion build
- Related: [ADR 0001: Browser clipping architecture](0001-browser-clipping-architecture.md)
- Supersedes: the 2026-08-29 YouTube-only research draft as the implementation plan

## Context

Media Sniper detects and processes media URLs that the browser exposes as
direct files, HLS playlists, or DASH manifests. That browser-native path works
well when the page reveals a conventional media transport. It does not cover
many sites whose downloadable media must first be resolved from a webpage,
including YouTube and the broader set of extractors maintained by yt-dlp.

Implementing a YouTube-only extractor inside the extension would duplicate
yt-dlp's format selection, signature handling, authentication behavior,
YouTube client selection, PO-token integration, media merging, and ongoing site
maintenance. Capturing `googlevideo.com` requests can work for some browser
sessions, but it is site-specific, depends on the qualities the player has
requested, stores short-lived signed URLs, and does not address other yt-dlp
sites.

The desired user experience is broader and simpler:

1. The user opens Media Sniper in Brave.
2. Media Sniper detects conventional media as it does today.
3. When page-level extraction is needed, the user asks Media Sniper to analyze
   the active page with yt-dlp.
4. The extension presents metadata, safe quality choices, download and clip
   controls, progress, cancellation, completion, and actionable errors.
5. The user never opens a terminal or constructs a yt-dlp/FFmpeg command.

A browser extension cannot execute a native yt-dlp binary itself. A local
companion is therefore required for this backend. The companion is an
execution engine, not a second user interface. Installation may require one
normal graphical installer flow, but routine setup, health checks, media
operations, authentication retries, tool updates, and file actions must be
driven from the extension UI.

This feature also has a distribution consequence. Chrome Web Store guidance
lists facilitating YouTube downloads as a common reason for rejection or
removal. A runtime setting that defaults to off is not sufficient separation;
the Web Store artifact must not contain the provider, permissions, messages,
or user interface for the native companion.

## Decision drivers

- Support YouTube and other yt-dlp extractors without reimplementing them.
- Keep all ordinary user interaction in the extension.
- Use the active Brave session when authentication is required.
- Keep cookies, signed URLs, and authorization material out of durable state.
- Preserve the existing browser-native paths for direct, HLS, and DASH media.
- Preserve truthful Fast versus Exact clipping semantics.
- Avoid transferring media bytes through extension or native-message channels.
- Make command construction safe against shell, option, filename, and path
  injection.
- Make the implementation divisible into independently testable work packages.

## Decision

Media Sniper will add a generic **yt-dlp native companion backend** to a
separate off-store build. The existing browser-native backend remains the
default for media URLs it already supports. The extension is the sole user
interface and operation coordinator; the native companion resolves webpage
URLs, invokes managed yt-dlp/FFmpeg tools, writes output files, and reports
structured events.

The first supported and acceptance-tested browser is Brave Stable on macOS.
The protocol and extension code remain Chromium-compatible, and Chrome Stable
is the secondary acceptance target.

The v1 native host is implemented as a standalone Rust binary under the
top-level `companion/` directory. Rust provides a runtime-free end-user binary,
typed JSON handling, bounded native-message framing, and direct child-process
control without requiring Python, Node, or a shell on the user's machine. The
managed yt-dlp and FFmpeg executables remain separate signed tool payloads.

### 1. Separate source backend from media format

`VideoFormat` continues to describe browser-visible media transports such as
DIRECT, HLS, M3U8, and DASH. `YOUTUBE` must not be added to `VideoFormat`.
YouTube is a site/extractor, not a transport format.

New writes use a discriminated source descriptor:

```ts
export type MediaSource = BrowserMediaSource | YtDlpMediaSource;

export interface BrowserMediaSource {
  kind: "browser";
  mediaUrl: string;
  format: VideoFormat;
  pageUrl: string;
}

export interface YtDlpMediaSource {
  kind: "yt-dlp";
  pageUrl: string;
  extractorKey?: string;
  mediaId?: string;
}
```

`VideoMetadata` becomes a discriminated union of common metadata plus either a
browser source or a yt-dlp source. `url` and top-level `format` remain required
only on the browser member while browser call sites are migrated. A yt-dlp
member carries `source.pageUrl` and must not invent an `UNKNOWN` format or place
the webpage URL in a field that a browser handler could fetch as media.

During the migration, legacy persisted records without `source` are normalized
on read to a browser member using their existing `url`, `format`, and `pageUrl`
fields. `DownloadState.url` and `ClipRequest.url` may temporarily retain the
canonical operation identity for database compatibility; for a yt-dlp source
that identity is the webpage URL and must never be passed to a browser download
or clip handler. New routing uses `metadata.source.kind`.

The normalized yt-dlp metadata returned to the extension is deliberately
small:

```ts
export interface YtDlpMediaSummary {
  extractorKey: string;
  mediaId: string;
  webpageUrl: string;
  title: string;
  durationMs?: number;
  thumbnailUrl?: string;
  uploader?: string;
  isLive: boolean;
  selections: YtDlpSelectionOption[];
  probeToken: string;
  probedAt: number;
}
```

The companion must not return or persist yt-dlp's complete `-J` object. Raw
format URLs, request headers, cookies, descriptions, comments, and unrelated
extractor fields are excluded from the extension-facing summary.

`probeToken` is an opaque, short-lived reference to an in-memory companion
probe result. It expires after ten minutes, when the native port disconnects,
or when the page identity changes. It is never used as durable history.

### 2. Browser-native and yt-dlp backends coexist

The two backends have distinct responsibilities:

| Backend | Input | Processing | Output ownership |
|---|---|---|---|
| Browser-native | Direct media URL, HLS, M3U8, DASH | Existing fetch, IndexedDB, FFmpeg.wasm, Mediabunny | Browser download |
| yt-dlp companion | Canonical webpage URL | Native yt-dlp, FFmpeg, ffprobe | Companion-written local file |

Browser-native detection and downloading remain unchanged unless a shared type
or operation abstraction must be extended. yt-dlp is not inserted into the
existing network classifier and does not replace working direct/HLS/DASH
cards.

Native FFmpeg jobs do not enter ADR 0001's offscreen media-job queue because
they do not use FFmpeg.wasm or browser memory. The companion owns a separate
single-concurrency queue in v1. The extension's active-operation registry still
tracks both backends so progress, duplicate prevention, cancellation, and
history have one user-facing model.

### 3. Zero-terminal user experience

The following are hard user-experience requirements:

- The extension must never instruct an end user to run a yt-dlp, FFmpeg,
  installer, registration, update, diagnostic, or cleanup command.
- A missing companion is represented by a **Companion required** state with an
  **Install companion** button and concise explanation.
- Installation uses a normal graphical installer appropriate to the platform.
- After installation, **Check again** reconnects without a browser restart
  whenever Brave permits it; otherwise the UI requests only the minimum reload
  necessary.
- Missing or incompatible managed tools are represented in the extension with
  **Install tools** or **Update tools** actions.
- Analyze, retry with browser session, select quality, download, clip, cancel,
  reveal output, and open output all originate in the extension.
- Errors must be actionable and must not end with “run this command.”

The extension cannot silently install a native program. One-time affirmative
installation is acceptable; terminal operation is not.

The v1 output directory is the operating system's Downloads directory under a
`Media Sniper` subdirectory. The completion card includes **Show in folder**.
Custom output directories are deferred until the companion provides a safe
native directory picker; users are never asked to paste a filesystem path.

### 4. Page analysis UX

The Videos tab shows browser-detected media cards first. It also exposes an
**Analyze this page with yt-dlp** action when all of the following are true:

- the active tab has an `http:` or `https:` URL;
- the companion build is running;
- the active page is not a browser-internal or extension page; and
- the action is initiated from the popup or another explicit extension UI.

The extension must not probe every navigation in the background. An optional
setting may automatically analyze on popup open only when no browser-native
media was detected. The setting defaults off.

The v1 backend passes `--no-playlist`. A playlist, channel, feed, or multi-entry
result is reduced to the current single video when yt-dlp can identify one;
otherwise the card explains that playlist workflows are not yet supported.

When the same page has both browser-native assets and a yt-dlp result, both may
be shown, but the yt-dlp card is labeled **Page via companion** and duplicate
operations are keyed by backend plus canonical source identity.

Live yt-dlp media and DRM-protected media are not clip targets in v1. The card
must state the limitation and retain any existing browser-native recording
option where applicable.

### 5. Safe format selection

The popup must not accept or transmit an arbitrary yt-dlp format expression.
The companion converts a raw probe result into allowlisted selection options:

```ts
export type YtDlpSelectionOption =
  | {
      kind: "preset";
      key: "best" | "best-mp4" | "up-to-1080p" | "up-to-720p" | "audio-only";
      label: string;
      estimatedBytes?: number;
      expectedContainer?: string;
    }
  | {
      kind: "formats";
      key: string;
      label: string;
      videoFormatId?: string;
      audioFormatId?: string;
      estimatedBytes?: number;
      expectedContainer?: string;
    };
```

On start, the extension sends only a selection `key` and `probeToken`. The
companion resolves that key against its in-memory probe result. Format IDs are
never accepted unless they appeared in that result, and free-form yt-dlp
arguments are never accepted.

The backend does not promise MP4 for every source. It may produce MP4, WebM,
MKV, M4A, or another safe media container selected by yt-dlp and FFmpeg. The
operation history records the actual container and final path returned by the
companion.

### 6. Native messaging transport

The production bridge uses Chromium native messaging with the host name:

```text
com.grej.media_sniper
```

The companion manifest contains the exact stable extension origins for the
companion build. Wildcard origins are prohibited. The companion build must
therefore have a stable extension ID, derived from a checked-in public manifest
`key` or another deterministic release mechanism. Private signing material is
never checked in.

Brave currently supports the Chromium native-messaging API and on macOS maps
native-host discovery to Chrome-compatible locations. The installer must still
detect Brave explicitly, install the user-level manifest required by the
supported browser versions, and verify the connection before reporting
success.

The service worker opens one long-lived `chrome.runtime.connectNative()` port.
The port provides progress events and keeps the MV3 service worker alive while
a native operation is active. A disconnect fails active native operations with
a recoverable companion error. V1 does not detach yt-dlp children from the
native host, preventing orphaned jobs after Brave exits.

Every protocol message is a JSON envelope:

```ts
export interface CompanionEnvelope<T = unknown> {
  protocolVersion: 1;
  requestId: string;
  type: string;
  payload: T;
}
```

The canonical cross-language contract is a checked-in JSON Schema under
`protocol/`. TypeScript validators/types and Rust serde types must pass shared
golden-message fixtures. Neither language's internal type definitions alone
are the protocol specification.

Required extension-to-companion messages:

| Type | Purpose |
|---|---|
| `hello` | Negotiate protocol and inspect health/capabilities |
| `probe` | Resolve and normalize one webpage URL |
| `start_download` | Start a full media operation from a probe token |
| `start_clip` | Start a clip operation from a probe token |
| `cancel_job` | Cancel one companion job |
| `reveal_output` | Reveal a completed output in the OS file manager |
| `open_output` | Open a completed output with the default application |
| `install_tools` | Install managed tools through the companion UI flow |
| `update_tools` | Update managed tools through the signed tool flow |

Required companion-to-extension messages:

| Type | Purpose |
|---|---|
| `hello_result` | Versions, health issues, managed-tool status, and capabilities |
| `probe_result` | Sanitized `YtDlpMediaSummary` |
| `auth_required` | Anonymous probe/download needs session authentication |
| `job_queued` | Job accepted into the companion queue |
| `job_progress` | Structured download/post-process progress |
| `fallback_required` | Clip requires a disclosed full-source download |
| `job_completed` | Final path, size, container, duration, and accuracy |
| `job_failed` | Stable error code and safe user-facing detail |
| `job_cancelled` | Cancellation and cleanup completed |
| `tool_progress` | Managed-tool install/update progress |

Messages never contain media bytes. The host must keep every message well below
the native-message size limit; the target maximum serialized message size is
256 KiB. Large logs, full probe objects, thumbnails, cookie databases, and
media buffers are not protocol payloads.

The native host writes only framed protocol messages to stdout. Child stdout
and stderr are captured separately. Unframed logging on stdout is a protocol
violation.

### 7. Companion health and managed tools

`hello_result` contains at least:

```ts
export interface CompanionHealth {
  protocolVersion: 1;
  companionVersion: string;
  browserTarget: "brave" | "chrome" | "chromium" | "unknown";
  platform: "macos" | "windows" | "linux";
  ytDlpVersion?: string;
  ffmpegVersion?: string;
  ffprobeVersion?: string;
  jsRuntime?: { name: string; version: string };
  healthy: boolean;
  issues: CompanionHealthIssue[];
  capabilities: {
    probe: boolean;
    download: boolean;
    sectionDownload: boolean;
    exactClip: boolean;
    currentTabCookies: boolean;
    braveProfileCookies: boolean;
    revealOutput: boolean;
  };
}
```

Release installers provide the companion and a tested, managed tool set that
includes yt-dlp, FFmpeg, ffprobe, and the JavaScript/EJS support needed by the
tested YouTube extractor version. End users must not need Homebrew, Python,
Node, Deno, or a shell.

Managed tools live under the platform's per-user application-support directory,
outside the extension package. Each release or tool update is verified against
a signed manifest and cryptographic hashes before activation. An update is
installed to a new versioned directory and atomically selected only after the
health check passes. The previous known-good version is retained for rollback.

The companion must not invoke yt-dlp's self-updater in production. Development
builds may discover explicitly configured or PATH tools, but that behavior is
not the end-user contract and must be labeled **Developer tools**.

Licenses and third-party notices for every bundled tool and build configuration
must ship with the companion installer.

### 8. yt-dlp process contract

The companion constructs process arguments from typed requests and launches
the executable directly without a shell.

Every yt-dlp invocation must include these policies or their API equivalents:

- ignore all user and system yt-dlp configuration;
- operate on one explicit URL with playlist behavior disabled;
- use companion-controlled home, temporary, cache, and output locations;
- use a companion-controlled filename template and collision policy;
- emit machine-parseable probe, progress, post-process, and final-path output;
- place `--` before the webpage URL;
- disallow `--exec`, arbitrary postprocessor arguments, arbitrary downloader
  arguments, arbitrary output templates, arbitrary configuration locations,
  and arbitrary headers from extension requests; and
- return a nonzero result for partial or post-processing failure rather than
  reporting false success.

The companion may use yt-dlp's CLI or supported Python API internally. If it
uses the CLI, it must parse only explicitly configured structured markers such
as `--dump-single-json`, `--progress-template`, and `--print` output. Human log
text is diagnostic input, not a stable state protocol.

The raw probe output stays inside the companion process. Before constructing
`probe_result`, the companion validates type, count, and string-length limits
and selects only the normalized fields in this ADR.

### 9. Brave request context and authentication

Anonymous probe and download are always attempted first unless the user has
explicitly chosen an authenticated mode for that site. Authentication modes
are:

```ts
export type YtDlpAuthMode =
  | "anonymous"
  | "current-tab"
  | "brave-profile";
```

#### Current-tab mode

`current-tab` is the preferred authenticated mode. When yt-dlp reports that
authentication is required, the extension displays **Retry using this Brave
session** with a concise privacy explanation. Only that user action may request
cookie access.

The companion build declares `cookies` as an optional permission. On approval,
the extension:

1. identifies the active tab's cookie store using the tab-to-store mapping;
2. reads cookies applicable to the top-level page URL, including the applicable
   partition context supported by the browser API;
3. captures the active page's effective User-Agent and canonical Referer/page
   URL as typed request context;
4. sends the scoped cookie records directly over native messaging for this
   probe or job; and
5. releases its in-memory copy immediately after the companion acknowledges
   secure receipt.

The extension must not capture a raw `Cookie` request header and must not pass a
global `Cookie:` header to yt-dlp. Doing so would discard cookie scope and could
send origin cookies to unrelated extractor/CDN hosts.

The companion writes current-tab cookies to a job-specific Netscape-format jar
with user-only filesystem permissions. The jar remains only as long as yt-dlp
may read or update it, then is unlinked on completion, failure,
cancellation, timeout, or companion startup recovery. Cookie values never
appear in process arguments, progress events, diagnostics, crash reports, or
durable state.

When a partitioned cookie cannot be represented faithfully in the yt-dlp
cookie jar, the companion reports a stable capability warning rather than
silently broadening its scope.

#### Brave-profile mode

`brave-profile` is an advanced, explicit fallback for extractors that require
cookies spanning related domains and cannot work with the current-page cookie
set. The companion invokes yt-dlp's Brave-specific browser-cookie support
against the selected Brave profile.

This mode is never the default because it allows yt-dlp to read a broader
browser cookie database and may trigger an operating-system Keychain prompt.
The extension explains that distinction before enabling it. The user selects a
profile from names discovered by the companion; the user is never asked to
enter a profile path or command.

Private-window support requires the extension to be enabled in Brave private
windows. `current-tab` may use the private cookie store when the browser API
permits it. `brave-profile` must not claim to extract an ephemeral private
session.

### 10. Full-download flow

The full-download operation is:

1. Validate the active `probeToken` and selection key.
2. Create durable extension operation state without secrets.
3. Send `start_download` with canonical page identity, selection key, output
   policy, and optional ephemeral auth bundle.
4. Queue one native job.
5. Resolve formats and download/merge through yt-dlp and native FFmpeg.
6. Report normalized progress stages: planning, downloading, merging,
   processing, saving, completed.
7. Write the final file under `Downloads/Media Sniper` using a companion-owned,
   sanitized, collision-safe filename.
8. Return final path, filename, size, container, duration when known,
   extractor key, and media ID.
9. Store those non-secret completion fields in existing Media Sniper history.

The extension does not call `chrome.downloads.download()` for companion output
and does not attempt to read the native file back into browser memory. Existing
cloud upload actions are disabled for companion outputs in v1 with an explicit
explanation. A future helper-mediated upload requires a separate ADR.

### 11. Clip flow

The extension keeps ADR 0001's integer-millisecond `ClipSpec` and user-facing
Fast/Exact distinction. A new clip handler kind routes yt-dlp sources to the
native companion:

```ts
export type ClipHandlerKind =
  | "direct"
  | "hls-segmented"
  | "dash-segmented"
  | "yt-dlp-native";
```

#### Direct section attempt

The companion first attempts one logical yt-dlp section job using
`--download-sections` with decimal-second boundaries derived losslessly from
integer milliseconds.

- **Fast** uses keyframe-aligned section behavior without forcing re-encoding.
  Its result is labeled `keyframe-aligned`, and returned actual duration/start
  metadata is shown when available.
- **Exact** enables yt-dlp/FFmpeg's forced-keyframe cut behavior and permits
  re-encoding. It is labeled `exact` only after ffprobe validation confirms the
  requested duration within ±100 ms, required audio/video tracks are present,
  and the first retained audio/video timestamps are within 100 ms of each
  other.

Section downloads require native FFmpeg. Network efficiency depends on the
extractor and protocol; the UI and history must not claim that only the final
clip bytes were transferred unless measured evidence supports that source.

#### Disclosed two-stage fallback

If direct section downloading is unsupported or produces an invalid result,
the companion emits `fallback_required` and stops before downloading the full
source. The event includes the estimated full-download size when yt-dlp can
provide it and a safe reason code.

The extension then offers **Download source, then create clip**. On affirmative
consent, a new or resumed native job:

1. downloads the selected complete source into a job-specific temporary
   directory;
2. trims/remuxes it locally for Fast mode or decodes/re-encodes it for Exact
   mode;
3. verifies track presence and output duration with ffprobe;
4. moves only the final clip into `Downloads/Media Sniper`; and
5. deletes the complete temporary source and all intermediate files.

Consent may be remembered as a setting only if the UI clearly states that
future clips may download complete sources. A configurable maximum estimated
fallback size applies before remembered consent. Unknown or larger estimates
require per-operation confirmation.

Cancellation must never save an arbitrary partial file as a clip. A cancelled
native clip is discarded and its temporary files are reclaimed.

### 12. Progress, cancellation, recovery, and history

Companion jobs use the existing `DownloadStage` vocabulary where possible and
add stable companion sub-stages only as detail text. Progress events include
downloaded bytes, total bytes when known, percentage when meaningful, speed,
ETA, current media role, and post-process phase. Missing totals must not be
rendered as zero-percent stalls.

Cancellation sends `cancel_job`. The companion requests graceful yt-dlp/FFmpeg
termination, waits a bounded grace period, then terminates the entire child
process group. It removes `.part`, cookie, temporary, and intermediate files
owned by that job before sending `job_cancelled`.

V1 keeps the native port and child process coupled:

- Brave exit or native-port loss terminates the child and marks the operation
  interrupted.
- Companion startup scans only its own job-temp root and removes stale files
  older than the configured recovery threshold.
- The companion never scans or deletes a broad user directory.
- A final file already atomically moved to the output directory is retained and
  reconciled into history when its operation receipt is valid.

Durable history stores backend, canonical page URL, extractor key, media ID,
title, selection label, requested/actual clip information, final local path,
container, byte size, timestamps, and safe error code. It does not store probe
tokens, cookies, signed format URLs, request headers, full yt-dlp output, or
unredacted command lines.

### 13. Security boundary

The native companion has the user's filesystem and process privileges. The
following controls are mandatory:

- Accept messages only through the registered native-messaging origin.
- Validate protocol version, message type, schema, size, and string limits.
- Accept only `http:` and `https:` page URLs tied to the active-tab request or
  another explicit extension workflow.
- Reject `file:`, `data:`, `javascript:`, browser-internal, extension, and
  command-like inputs.
- Production manual URLs targeting loopback, link-local, or private network
  addresses require a separate developer/testing mode.
- Never invoke a shell or concatenate a command string.
- Never accept raw yt-dlp/FFmpeg arguments, output templates, executable paths,
  environment variables, or filesystem paths from page/content-script data.
- Resolve executable and output locations from companion-owned configuration.
- Create per-job temporary directories with user-only permissions.
- Sanitize and bound all metadata before using it in a filename or UI.
- Prevent output path traversal and symlink escapes; verify the final parent is
  the configured output root before an atomic move.
- Redact URL query secrets, cookie names/values, authorization material, and
  filesystem usernames from user-visible diagnostics.
- Keep child process environment minimal and companion-controlled.
- Disable yt-dlp configuration loading and arbitrary plugins in the managed
  production runtime unless a plugin is shipped, pinned, and reviewed as part
  of the companion.
- Verify managed tool signatures/hashes and use atomic version activation.

Content scripts and webpage MAIN-world code never receive cookies, native
paths, probe internals, or companion capabilities beyond what is required for
page-player association. Cookie collection and native messaging live in the
service worker.

### 14. Build and distribution variants

The repository produces two separately compiled extension variants:

1. **Standard build**
   - retains current browser-native features;
   - contains no yt-dlp backend code or UI;
   - contains no `nativeMessaging` permission;
   - contains no cookie permission requested for the companion; and
   - is the only candidate for Chrome Web Store review.

2. **Companion build**
   - is distributed off-store with the native companion installer;
   - includes `nativeMessaging`;
   - includes `cookies` only as an optional permission requested from a user
     gesture;
   - has a stable extension ID matching the native-host allowlist; and
   - exposes companion health, analysis, download, clip, and tool-management UI.

Variant selection occurs before compilation and manifest generation. The
packaging script must not attempt to make one already-built bundle safe by
removing files after the fact. Release checks inspect the built manifest and
bundle for forbidden cross-variant strings, messages, and permissions.

Companion releases include:

- the extension artifact;
- graphical per-user installer/uninstaller;
- native host and exact allowed-origin manifest;
- managed tool payload or signed first-run tool bundle;
- third-party notices and licenses;
- checksums/signatures; and
- a compatibility table covering Brave, companion, protocol, yt-dlp, FFmpeg,
  and JS runtime versions.

### 15. Stable errors and user-facing recovery

The companion protocol uses stable error codes. At minimum:

| Code | Extension recovery |
|---|---|
| `COMPANION_NOT_INSTALLED` | Show **Install companion** |
| `COMPANION_INCOMPATIBLE` | Show **Update companion** |
| `TOOLS_MISSING` | Show **Install tools** |
| `TOOLS_INCOMPATIBLE` | Show **Update tools** |
| `PROTOCOL_MISMATCH` | Explain which component must update |
| `URL_UNSUPPORTED` | Keep browser-native assets; explain page unsupported |
| `PLAYLIST_UNSUPPORTED` | Explain single-item v1 scope |
| `LIVE_UNSUPPORTED` | Offer existing recording path when available |
| `DRM_UNSUPPORTED` | Explain DRM limitation |
| `AUTH_REQUIRED` | Offer **Retry using this Brave session** |
| `AUTH_SCOPE_INSUFFICIENT` | Offer advanced Brave-profile mode |
| `COOKIE_PERMISSION_DENIED` | Continue anonymously or cancel |
| `FORMAT_UNAVAILABLE` | Refresh analysis and selections |
| `SECTION_UNSUPPORTED` | Offer disclosed two-stage fallback |
| `EXACT_CLIP_UNSUPPORTED` | Offer Fast mode; never silently downgrade |
| `OUTPUT_EXISTS` | Apply collision-safe filename automatically |
| `DISK_FULL` | Preserve no partial clip; show space guidance |
| `JOB_INTERRUPTED` | Offer retry from a fresh probe |
| `CANCELLED` | Show cancelled state after cleanup |

User-visible errors may include a **Copy diagnostics** action. Diagnostics are
structured, versioned, redacted, and exclude secrets and full command lines.

## Alternatives considered

### YouTube-specific googlevideo capture as the primary backend

Rejected as the primary plan. It duplicates extractor logic, works only for
qualities requested by the player, depends on expiring signed URLs, needs
site-specific pairing and container logic, and does not provide broader yt-dlp
coverage. It may return later as an optional helperless optimization under a
separate ADR.

### MAIN-world parsing of `ytInitialPlayerResponse`

Rejected for the generic backend. It depends on private YouTube globals and SPA
events while yt-dlp already owns page extraction. Normal player association for
clip marks may continue through the existing DOM playback registry.

### Localhost HTTP/WebSocket daemon

Rejected for production. A loopback server requires separate authentication,
Origin/Host validation, CSRF protection, port discovery, daemon lifecycle, and
defense against unrelated local pages/processes. Native messaging already
authenticates a fixed extension origin and couples process lifetime to the
browser. A localhost adapter may exist only for isolated development tests.

### Pure browser implementation

Rejected for the generic backend. MV3 cannot execute yt-dlp or native FFmpeg,
and maintaining extractor/signature behavior in TypeScript would recreate the
problem this decision delegates to yt-dlp.

### Helper-owned Brave profile cookies as the default

Rejected. It grants broader cookie access than most operations need, may read
cookies for unrelated sites, and can trigger Keychain access. Scoped current-tab
handoff is the preferred authenticated mode; full-profile access is explicit
and advanced.

### Capturing and forwarding the raw browser `Cookie` header

Rejected. A header loses cookie domain/path/partition semantics, and using it
as a global yt-dlp header could leak cookies to unrelated extractor or CDN
requests.

### Passing arbitrary yt-dlp options through an “advanced” text box

Rejected. It expands the native boundary into command, file, plugin, and
postprocessor execution. The companion exposes typed presets and reviewed
settings only.

### Returning native output to the browser as bytes

Rejected. Native messaging is not a media transport, browser memory limits
would return, and large outputs would violate the architecture's bounded
message contract. The companion writes locally and returns a receipt.

## Consequences

### Positive

- One backend covers YouTube and the wider maintained yt-dlp extractor set.
- yt-dlp owns fast-changing extraction, format, and merge behavior.
- Native FFmpeg removes the browser's approximately 2 GB in-memory mux ceiling
  for companion jobs.
- The extension retains a coherent no-terminal workflow and history model.
- Scoped Brave-session authentication is more private than default whole-profile
  extraction.
- Browser-native operations remain local, efficient, and helper-free where
  they already work.
- Clipping can use yt-dlp's section support with a truthful, consented local
  fallback.

### Negative

- End users must install and update a native companion.
- The project must build, sign, package, and test native software and managed
  third-party tools.
- Native output does not automatically appear in Chromium's downloads history.
- Existing browser-based cloud upload cannot consume native files in v1.
- Cookie permission and profile-cookie fallback require careful disclosure and
  testing.
- The companion build cannot be distributed through the Chrome Web Store for
  the intended YouTube use case.
- Brave, OS, yt-dlp, FFmpeg, JS runtime, and extractor updates create a larger
  compatibility matrix.

### Relationship to ADR 0001

ADR 0001 remains authoritative for browser-native direct/HLS/DASH clips. Its
offscreen single-concurrency queue applies to FFmpeg.wasm and Mediabunny jobs.
This ADR adds a separate native execution backend and companion queue. Both
share integer-millisecond clip specifications, operation identity, durable
history, truthful accuracy labels, cancellation expectations, and the rule
that a clip request never silently becomes a full download.

## Implementation work packages

The following packages are designed for bounded implementation handoff. An
agent must not change another package's owned protocol/types without
coordinating the contract change first.

### WP1 — Shared domain and protocol contracts

Owned scope:

- new `protocol/companion-v1.schema.json` and golden fixtures;
- `src/core/types/*`
- `src/core/clipping/types.ts`
- `src/core/clipping/routing.ts`
- new `src/core/companion/protocol.ts`
- new `src/core/companion/types.ts`
- serialization and schema-validation tests

Deliverables:

- discriminated `MediaSource` with legacy normalization;
- yt-dlp summary, selection, auth, health, job, and error types;
- protocol envelopes and runtime validators;
- operation-key backend identity;
- no UI, native process, or installer changes.

### WP2 — Native host core and safe process runner

Owned scope:

- new top-level Rust `companion/` project;
- native-message framing;
- protocol dispatch;
- safe child-process launcher;
- job queue, cancellation, cleanup, and redacted diagnostics;
- fake-yt-dlp integration harness.

Deliverables:

- `hello`, `probe`, start, progress, cancel, and completion flow;
- direct argument-array execution with no shell;
- `--ignore-config` and controlled directories/templates;
- normalized/sanitized probe output;
- unit tests for injection, traversal, framing, size limits, process groups,
  and cleanup.

WP2 consumes the checked-in protocol schema from WP1.

### WP3 — Companion client and operation integration

Owned scope:

- new `src/core/companion/client.ts`;
- service-worker native-port lifecycle;
- companion operation handlers;
- active-operation registry integration;
- IndexedDB history normalization;
- stable error mapping.

Deliverables:

- reconnectable health client;
- start/progress/cancel routing;
- durable non-secret native operation state;
- interrupted-job behavior;
- mocked native-port integration tests.

### WP4 — Brave-first install, tool management, and build variants

Owned scope:

- companion installer/uninstaller assets;
- Brave/Chrome native-host manifests;
- stable companion extension ID mechanism;
- managed-tool health/install/update support;
- Vite manifest generation and release packaging;
- cross-variant release checks.

Deliverables:

- macOS Brave user-level installation first;
- graphical install/check/update path;
- no-terminal release flow;
- standard artifact with no companion surface;
- companion artifact whose exact origin matches the host manifest;
- third-party notices and compatibility metadata.

Windows and Linux packaging may follow after the macOS Brave acceptance gate,
but the host protocol and filesystem abstractions must not become macOS-only.

### WP5 — Analyze-page and quality-selection UI

Owned scope:

- popup companion health state;
- **Analyze this page with yt-dlp** action;
- sanitized yt-dlp card rendering;
- typed selection UI;
- duplicate/source labeling;
- unsupported playlist/live/DRM states.

Deliverables:

- public-page anonymous probe flow;
- loading, success, empty, unsupported, missing-helper, and update-required UI;
- no raw JSON or format-expression UI;
- UI tests with fixture summaries.

### WP6 — Brave current-session authentication

Owned scope:

- optional cookie-permission flow;
- active-tab cookie-store resolution;
- scoped cookie serialization;
- User-Agent/Referer context;
- companion temporary cookie-jar creation/deletion;
- advanced Brave-profile discovery and consent UI.

Deliverables:

- anonymous-first retry flow;
- private/incognito-aware current-tab behavior;
- no secrets in storage/logs/history tests;
- temp-file permission and cleanup tests;
- explicit warning and selection for broad Brave-profile mode.

WP6 depends on WP2 and WP3 protocol support and must use the auth types from
WP1.

### WP7 — Native full-download UX and history

Owned scope:

- companion selection resolution and full-download command policy;
- popup start/progress/cancel/completion UI;
- final-path receipt and history rendering;
- show/open output actions;
- native-output cloud-action gating.

Deliverables:

- successful public YouTube and non-YouTube yt-dlp downloads;
- authenticated download retry;
- actual output container/path/size in history;
- cancellation and disk/error states;
- no use of `chrome.downloads.download()` for native output.

### WP8 — Native clipping and fallback

Owned scope:

- `yt-dlp-native` clip routing;
- section argument construction;
- Fast/Exact execution and ffprobe validation;
- `fallback_required` protocol/UI;
- consented full-download-then-clip pipeline;
- intermediate cleanup and history accuracy.

Deliverables:

- Fast section clip with audio and keyframe-aligned label;
- Exact section clip validated to the ±100 ms duration and 100 ms A/V-start
  tolerance;
- disclosed fallback with estimate where available;
- full-source cleanup after success/failure/cancel;
- no silent mode downgrade or silent full download.

### WP9 — Acceptance, privacy audit, and release documentation

Owned scope:

- Brave and Chrome browser acceptance suites;
- companion end-to-end fixtures;
- release validation docs;
- privacy/security checklist;
- graphical install/update/uninstall user documentation;
- compatibility table generation.

Deliverables:

- evidence for every acceptance criterion below;
- redacted logs and fixtures;
- clean standard/companion artifact inspection;
- documented recovery paths that never require terminal use.

## Suggested landing order

1. WP1 establishes source and protocol contracts.
2. WP2 and WP4 begin against the frozen protocol; WP3 begins once framing and
   `hello` are available.
3. WP5 integrates `hello` and `probe` after WP3.
4. WP6 and WP7 integrate authentication and full operations.
5. WP8 adds native clipping after full downloads are stable.
6. WP9 closes acceptance, privacy, packaging, and documentation gaps.

No work package should begin with YouTube-specific network interception. The
first vertical slice is:

```text
Brave popup
  -> companion health
  -> analyze active public page
  -> normalized card
  -> download with managed yt-dlp/FFmpeg
  -> progress/cancel
  -> file in Downloads/Media Sniper
  -> history receipt and Show in folder
```

## Acceptance criteria

The decision is implemented only when all applicable criteria pass.

### User experience

- A fresh end user can install the companion graphically and complete a
  download without opening a terminal.
- Missing companion/tools and incompatible versions have extension buttons and
  actionable status.
- Analyze, authenticated retry, selection, download, clip, progress,
  cancellation, update, reveal, and open actions are available from the
  extension.
- The extension never displays a command for the user to copy into a shell.

### Brave

- Brave Stable on macOS connects to the installed native host.
- The extension uses a stable ID accepted by the host manifest.
- Anonymous YouTube analysis and download succeed for a permitted public test
  video.
- Current-tab cookies use the correct Brave cookie store after explicit
  permission and consent.
- Multiple Brave profiles do not cross cookie stores.
- Private-window behavior is correct when the extension is explicitly enabled
  there and fails safely otherwise.

### Generic yt-dlp behavior

- A controlled non-YouTube yt-dlp-supported fixture or permitted test page can
  be analyzed and downloaded through the same backend.
- Playlist input is constrained to the documented v1 behavior.
- Free-form format expressions and process arguments cannot reach the host.
- Output containers are reported truthfully rather than forced to MP4.

### Clipping

- A 10-second Fast clip completes with required video/audio tracks and a
  keyframe-aligned accuracy label.
- A 10-second Exact clip either passes the ±100 ms duration and 100 ms A/V-start
  ffprobe tolerances with an exact label or fails with
  `EXACT_CLIP_UNSUPPORTED`.
- A source requiring a complete download emits `fallback_required` before the
  complete transfer.
- The two-stage fallback runs only after informed consent and removes its full
  temporary source.
- Cancellation leaves no saved partial clip.

### Security and privacy

- No cookie, authorization value, signed format URL, raw yt-dlp probe, or full
  command line appears in IndexedDB, Chrome storage, logs, diagnostics, test
  evidence, or history.
- Cookie jars and job temporary directories have user-only permissions and are
  removed after every final job state.
- Malicious URLs, option-looking URLs, titles, format IDs, filenames, and path
  traversal fixtures cannot alter arguments or escape managed directories.
- The native host emits valid framing even when child processes write arbitrary
  stdout/stderr.
- Port loss and Brave exit do not leave detached yt-dlp/FFmpeg processes.

### Distribution

- The standard build contains no native-messaging permission, companion
  protocol/UI, or cookie permission for this feature.
- The companion build and native manifest agree on the exact stable extension
  origin.
- Release checks verify tool hashes, compatibility metadata, licenses, and
  artifact contents.
- Install, update, rollback, and uninstall are exercised without terminal use.

## External references

- yt-dlp project and CLI options: <https://github.com/yt-dlp/yt-dlp>
- yt-dlp cookie guidance: <https://github.com/yt-dlp/yt-dlp/wiki/FAQ>
- Chrome native messaging: <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
- Extension service-worker lifecycle: <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- Chrome cookies API: <https://developer.chrome.com/docs/extensions/reference/api/cookies>
- Chrome Web Store prohibited-products troubleshooting: <https://developer.chrome.com/docs/webstore/troubleshooting>
- Brave native-messaging path integration: <https://github.com/brave/brave-core/blob/master/app/brave_main_delegate.cc>
