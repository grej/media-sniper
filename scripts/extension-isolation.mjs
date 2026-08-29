export const STANDARD_FORBIDDEN_TOKENS = [
  "companion",
  "companion_",
  "nativemessaging",
  "native messaging",
  "native_messaging",
  "connectnative",
  "sendnativemessage",
  "native_message",
  "native-message",
  "cookies",
  "yt-dlp",
  "com.grej.media_sniper",
  "dioapemglpdpmfmoekckbpenmpdgkofp",
];

const TEXTUAL_ENTRY = /(?:^|\/)(?:license|third_party_notices\.md)$|\.(?:css|html|js|json|md|mjs|mts|txt|ts)$/i;

export function validateStandardArtifactContents(entries, label) {
  for (const entry of entries) {
    // Scan executable bundles and known textual resources case-insensitively.
    // Opaque pinned binaries are verified by package hashes, not decoded as text.
    if (!TEXTUAL_ENTRY.test(entry.name)) continue;
    const text = entry.contents.toString("utf8").toLowerCase();
    for (const token of STANDARD_FORBIDDEN_TOKENS) {
      if (text.includes(token)) {
        throw new Error(
          `Standard ${label} contains forbidden token ${JSON.stringify(token)} in ${entry.name}`,
        );
      }
    }
  }
}

/** Chromium MV3 module service workers allow static imports but not import(). */
export function validateMv3ServiceWorker(contents, label) {
  const text = contents.toString("utf8");
  if (/\bimport\s*\(/.test(text)) {
    throw new Error(`${label} contains a dynamic import unsupported by Chromium MV3 service workers`);
  }
}
