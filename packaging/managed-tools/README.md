# Managed tool release format

The production companion never runs a tool self-updater and never discovers
end-user tools from `PATH`. A publisher creates one signed manifest per target
with `scripts/managed-tools.mjs`. The private Ed25519 release key is supplied
from the release secret store and is never committed. The corresponding public
key is pinned in this directory and in the native installer.

The runtime manifest is deliberately the exact Rust contract:
`{version, files: [{path, sha256}]}`. Its detached signature covers those exact
bytes, and the native host rechecks every payload hash before activation. A
second signed release-metadata document carries target, exact compatibility
versions, byte sizes, executable modes, and activation policy without widening
the native parser's allowlist.

Activation uses `tools/versions/<version>/bin`, an atomically replaced UTF-8
`active-version` marker, and a `previous-version` marker. A new payload is
staged, both signatures and all hashes are checked, and the tool version health
checks must pass before the active marker changes. The previous release is
retained so the extension's update flow can request rollback without a
terminal.

The payload must use a pinned official yt-dlp executable. Its signed provenance
records the binary hash, upstream release URL, yt-dlp version, matching embedded
yt-dlp-ejs version, and `remoteComponentsAllowed: false`. The generator rejects
an absent solver attestation or a managed Deno version older than 2.3.0. The
native runner also supplies `--no-remote-components` and the explicit managed
Deno path, so an extractor cannot fill a packaging gap by fetching executable
solver code at runtime.

The release metadata records exact yt-dlp, embedded EJS, FFmpeg, ffprobe, and
JavaScript runtime versions. The macOS bundle contains both signed documents,
detached signatures, provenance, and payload; it does not contain the publisher
private key.
