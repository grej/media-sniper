import { afterEach, describe, expect, it } from "vitest";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// Build scripts are intentionally plain ESM so release machines need only Node.
// @ts-expect-error JavaScript build helper has no declaration file.
import {
  COMPANION_EXTENSION_ID,
  COMPANION_EXTENSION_ORIGIN,
  COMPANION_MANIFEST_KEY,
  extensionIdFromManifestKey,
  makeVariantManifest,
} from "../../build/extension-variants.mjs";
// @ts-expect-error JavaScript build helper has no declaration file.
import {
  createManagedToolRelease,
  signManagedToolManifest,
  verifyManagedToolRelease,
  defaultPublicKeyPath,
  releasePublicKeyRawBase64,
} from "../../scripts/managed-tools.mjs";
import baseManifest from "../../manifest.json";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("extension release variants", () => {
  it("derives the reviewed stable companion identity", () => {
    expect(extensionIdFromManifestKey(COMPANION_MANIFEST_KEY)).toBe(COMPANION_EXTENSION_ID);
    expect(COMPANION_EXTENSION_ORIGIN).toBe(
      `chrome-extension://${COMPANION_EXTENSION_ID}/`,
    );
  });

  it("adds companion permissions only to the companion manifest", () => {
    const standard = makeVariantManifest(baseManifest, "standard");
    const companion = makeVariantManifest(baseManifest, "companion");
    expect(standard.key).toBeUndefined();
    expect(standard.permissions).not.toContain("nativeMessaging");
    expect(standard.optional_permissions).toBeUndefined();
    expect(companion.key).toBe(COMPANION_MANIFEST_KEY);
    expect(companion.permissions).toContain("nativeMessaging");
    expect(companion.optional_permissions).toEqual(["cookies"]);
  });

  it("pins the same tool-release key in packaging and the macOS installer", async () => {
    const publicKey = createPublicKey(await readFile(defaultPublicKeyPath, "utf8"));
    const rawKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    expect(rawKey.toString("base64")).toBe(releasePublicKeyRawBase64);
    const installerSupport = await readFile(
      join(process.cwd(), "installer/macos/InstallerSupport.swift"),
      "utf8",
    );
    expect(installerSupport).toContain(releasePublicKeyRawBase64);
  });
});

describe("signed managed-tool releases", () => {
  it("verifies every payload byte and rejects tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-sniper-tools-"));
    temporaryDirectories.push(root);
    const bin = join(root, "bin");
    await mkdir(bin);
    for (const name of ["yt-dlp", "ffmpeg", "ffprobe", "deno"]) {
      const path = join(bin, name);
      await writeFile(path, `${name}-fixture`, "utf8");
      await chmod(path, 0o700);
    }
    const releaseOptions = {
      root,
      releaseId: "fixture-macos-arm64",
      target: "macos-arm64",
      companionVersion: "1.12.0",
      ytDlpVersion: "fixture-1",
      ffmpegVersion: "fixture-2",
      ffprobeVersion: "fixture-2",
      jsRuntimeName: "deno",
      jsRuntimeVersion: "2.3.0",
    };
    await expect(createManagedToolRelease(releaseOptions)).rejects.toThrow(
      "embedded EJS provenance",
    );
    const provenanceDirectory = join(root, "provenance");
    await mkdir(provenanceDirectory);
    const ytDlpHash = createHash("sha256")
      .update("yt-dlp-fixture")
      .digest("hex");
    await writeFile(
      join(provenanceDirectory, "yt-dlp.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        distribution: "official-executable",
        ytDlpVersion: "fixture-1",
        ejsVersion: "0.8.0",
        sourceUrl:
          "https://github.com/yt-dlp/yt-dlp/releases/download/fixture/yt-dlp_macos",
        sha256: ytDlpHash,
        remoteComponentsAllowed: false,
      }, null, 2)}\n`,
      "utf8",
    );
    const { manifest, releaseMetadata } = await createManagedToolRelease(releaseOptions);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signature = signManagedToolManifest(
      manifest,
      privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    const releaseMetadataSignature = signManagedToolManifest(
      releaseMetadata,
      privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    await expect(verifyManagedToolRelease({
      root,
      manifest,
      signature,
      releaseMetadata,
      releaseMetadataSignature,
      publicKeyPem,
    })).resolves.toBe(true);

    await writeFile(join(bin, "yt-dlp"), "tampered", "utf8");
    await expect(verifyManagedToolRelease({
      root,
      manifest,
      signature,
      releaseMetadata,
      releaseMetadataSignature,
      publicKeyPem,
    })).rejects.toThrow("does not match");
  });
});
