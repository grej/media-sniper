import { createHash } from "node:crypto";

export const COMPANION_HOST_NAME = "com.grej.media_sniper";
export const COMPANION_EXTENSION_ID = "dioapemglpdpmfmoekckbpenmpdgkofp";
export const COMPANION_MANIFEST_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1yGmk04SQnB4rUN88Xy45EXZv7f5TVlTXd3/9Lfx8YkpizyAV6vg8HGHr0vcejfkGiohfB4i34N3CXBos7daoHG30UgueA9jQL7ED1mRvzmcMXlunxqBfbDlkIuacOYB3Ceg7WL7Auh017wyxIqY7EqEuUt2r+dzL3cnXqUAu4oLA3NA8mMD6PR0jaU0HqfLausZHa34aPlHeIAZrng8+CY2gfDFzHo1g1xKkdxFHvDPibRm1gHugNYN0TlhLXnjYlcNLJhvPlMusICYobtYk3Ty8RFSbAn/8fMpE6bmNTu98ujEfLxl6slIuTxxU0R3fsN5rvMH/XVDoJru9lfS+wIDAQAB";
export const COMPANION_EXTENSION_ORIGIN =
  `chrome-extension://${COMPANION_EXTENSION_ID}/`;
export const DEFAULT_COMPANION_INSTALL_URL =
  "https://github.com/grej/media-sniper/releases/latest";

export function extensionIdFromManifestKey(manifestKey) {
  const der = Buffer.from(manifestKey, "base64");
  const digest = createHash("sha256").update(der).digest().subarray(0, 16);
  return Array.from(digest, (byte) =>
    String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f)),
  ).join("");
}

export function variantForMode(mode) {
  if (mode === "companion") return "companion";
  if (mode === "standard" || mode === "production" || mode === "development") {
    return "standard";
  }
  throw new Error(
    `Unsupported extension build mode ${JSON.stringify(mode)}; use standard or companion`,
  );
}

export function assertCompanionIdentity() {
  const actual = extensionIdFromManifestKey(COMPANION_MANIFEST_KEY);
  if (actual !== COMPANION_EXTENSION_ID) {
    throw new Error(
      `Companion manifest key derives ${actual}, expected ${COMPANION_EXTENSION_ID}`,
    );
  }
}

export function makeVariantManifest(baseManifest, variant) {
  assertCompanionIdentity();
  const manifest = structuredClone(baseManifest);
  delete manifest.key;
  delete manifest.optional_permissions;

  manifest.permissions = manifest.permissions.filter(
    (permission) => permission !== "nativeMessaging" && permission !== "cookies",
  );

  if (variant === "companion") {
    manifest.name = "Media Sniper Companion";
    manifest.description =
      "Detect, download, record, and clip web video with browser-native and local yt-dlp backends.";
    manifest.key = COMPANION_MANIFEST_KEY;
    manifest.permissions.push("nativeMessaging");
    manifest.optional_permissions = ["cookies"];
  }

  return manifest;
}
