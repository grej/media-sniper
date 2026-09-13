# Managed-tool release key

The first public installer release, 1.13.0, provisions a dedicated signing key
and replaces the provisional pre-release public key. The publisher retains the
private key outside the repository in its release-secret directory, with
owner-only access. Its public SPKI SHA-256 fingerprint is
`e8000a05608d641bd72b8f679caa4cffc031f91041c468b1c887dfc118f3322f`.
Future releases must use that retained key or follow the rotation procedure
below. No previously published managed-tool installer requires migration from
the provisional key.

Managed-tool manifests and their richer release metadata use Ed25519 detached
signatures. The public key is intentionally public and pinned in three release
surfaces: the repository PEM, the native host, and the graphical macOS
installer. Release validation must prove that all three resolve to the same 32
raw public-key bytes.

The matching private key is release infrastructure, not source code. It must be
created and stored by the project's approved offline signing process before the
first production tool release. It is supplied to the manifest generator as an
explicit release-secret input, is never copied into a build directory, and
must never appear in repository files, logs, CI artifacts, diagnostics, or a
developer tool bundle.

Developer ID-sign the native host and every executable in the managed payload
before the Ed25519 manifest is generated. The manifest therefore authenticates
the exact signed bytes; re-signing a payload after hashing is prohibited. The
production release builder independently verifies each Developer ID signature
before it accepts the manifest and submits the containing DMG for notarization.

The checked-in public key establishes the expected first-release identity; the
release owner must confirm custody of its matching private key before signing.
If that custody has not been established, rotate the public key in a reviewed
security change before publishing rather than shipping an unsigned or
differently signed payload.

Rotation requires a companion update that trusts the new public key, overlap
testing for the supported rollback window, corresponding installer and release
metadata updates, and explicit release notes. An extension message or managed
payload cannot choose a verification key.
