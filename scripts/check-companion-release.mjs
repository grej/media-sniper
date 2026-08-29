#!/usr/bin/env node

import { createPublicKey } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPANION_EXTENSION_ID,
  COMPANION_EXTENSION_ORIGIN,
  COMPANION_HOST_NAME,
  COMPANION_MANIFEST_KEY,
  extensionIdFromManifestKey,
} from "../build/extension-variants.mjs";
import { renderCompatibilityTable } from "./generate-compatibility.mjs";
import { releasePublicKeyRawBase64 } from "./managed-tools.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function requireFile(relativePath) {
  const path = join(projectRoot, relativePath);
  if (!(await stat(path)).isFile()) throw new Error(`Required release input is missing: ${relativePath}`);
  return path;
}

async function validateBuiltManifests() {
  const standard = await readJson(join(projectRoot, "dist/manifest.json"));
  const companion = await readJson(join(projectRoot, "dist-companion/manifest.json"));
  if (standard.key || standard.permissions?.includes("nativeMessaging") ||
      standard.optional_permissions?.includes("cookies")) {
    throw new Error("Standard manifest contains companion-only identity or permissions");
  }
  if (
    companion.key !== COMPANION_MANIFEST_KEY ||
    extensionIdFromManifestKey(companion.key) !== COMPANION_EXTENSION_ID ||
    !companion.permissions?.includes("nativeMessaging") ||
    !companion.optional_permissions?.includes("cookies")
  ) {
    throw new Error("Companion manifest identity or permissions are invalid");
  }
}

async function validateHostManifest() {
  const template = await readJson(
    join(projectRoot, "packaging/native-host/com.grej.media_sniper.json.in"),
  );
  if (
    template.name !== COMPANION_HOST_NAME ||
    template.path !== "__NATIVE_HOST_PATH__" ||
    template.type !== "stdio" ||
    JSON.stringify(template.allowed_origins) !== JSON.stringify([COMPANION_EXTENSION_ORIGIN])
  ) {
    throw new Error("Native-host manifest does not contain the exact reviewed origin");
  }
  if (template.allowed_origins.some((origin) => origin.includes("*"))) {
    throw new Error("Native-host manifest must not contain wildcard origins");
  }
}

async function validateCompatibility() {
  const packageMetadata = await readJson(join(projectRoot, "package.json"));
  const compatibility = await readJson(join(projectRoot, "packaging/compatibility.json"));
  if (
    compatibility.schemaVersion !== 1 ||
    compatibility.extension.companionVersion !== packageMetadata.version ||
    compatibility.extension.companionExtensionId !== COMPANION_EXTENSION_ID ||
    compatibility.nativeHost.name !== COMPANION_HOST_NAME ||
    compatibility.nativeHost.protocolVersion !== 1
  ) {
    throw new Error("Compatibility metadata is stale or incomplete");
  }
  const required = new Set(compatibility.managedTools.required);
  for (const tool of ["yt-dlp", "yt-dlp-ejs", "ffmpeg", "ffprobe", "deno"]) {
    if (!required.has(tool)) throw new Error(`Compatibility metadata omits ${tool}`);
  }
  const checkedInTable = await readFile(
    join(projectRoot, "docs/companion/compatibility.md"),
    "utf8",
  );
  if (checkedInTable !== renderCompatibilityTable(compatibility)) {
    throw new Error("Generated companion compatibility table is stale");
  }
}

async function validateUserGuides() {
  const guides = [
    "docs/companion/install-macos.md",
    "docs/companion/use-and-recovery.md",
    "docs/companion/privacy-and-security.md",
  ];
  for (const relativePath of guides) {
    const contents = await readFile(await requireFile(relativePath), "utf8");
    if (/```(?:sh|bash|zsh|console)|\bbrew install\b|\bsudo\b|\bchmod\b/i.test(contents)) {
      throw new Error(`End-user guide contains a terminal instruction: ${relativePath}`);
    }
  }
}

async function main() {
  await Promise.all([
    requireFile("installer/macos/InstallerSupport.swift"),
    requireFile("installer/macos/InstallMediaSniperCompanion.swift"),
    requireFile("installer/macos/UninstallMediaSniperCompanion.swift"),
    requireFile("scripts/build-macos-companion-release.mjs"),
    requireFile("scripts/extension-isolation.mjs"),
    requireFile("scripts/managed-tools.mjs"),
    requireFile("packaging/companion/THIRD_PARTY_NOTICES.md"),
  ]);
  const publicKey = createPublicKey(
    await readFile(join(projectRoot, "packaging/managed-tools/release-public-key.pem"), "utf8"),
  );
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Pinned managed-tool release key is not Ed25519");
  }
  const publicKeyRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  if (publicKeyRaw.toString("base64") !== releasePublicKeyRawBase64) {
    throw new Error("Managed-tool PEM and installer release keys do not agree");
  }
  const installerSupport = await readFile(
    join(projectRoot, "installer/macos/InstallerSupport.swift"),
    "utf8",
  );
  if (!installerSupport.includes(releasePublicKeyRawBase64)) {
    throw new Error("macOS installer does not pin the managed-tool release key");
  }
  await validateBuiltManifests();
  await validateHostManifest();
  await validateCompatibility();
  await validateUserGuides();
  console.log(`Validated extension identity ${COMPANION_EXTENSION_ID}`);
  console.log(`Validated exact native origin ${COMPANION_EXTENSION_ORIGIN}`);
  console.log("Validated release metadata, notices, GUI sources, and no-terminal user guides");
}

await main();
