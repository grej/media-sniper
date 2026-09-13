#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "..");
export const defaultPublicKeyPath = join(
  projectRoot,
  "packaging/managed-tools/release-public-key.pem",
);
export const releasePublicKeyRawBase64 =
  "44XFJjYK5JVQyBlZvr8IUwu7w7++++pCMOjJQqQhLik=";

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portablePath(root, path) {
  const result = relative(root, path).split(sep).join("/");
  if (!result || result.startsWith("/") || result.split("/").includes("..")) {
    throw new Error(`Unsafe managed-tool path: ${result}`);
  }
  return result;
}

async function hashFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function versionAtLeast(actual, minimum) {
  const parse = (value) => value.split(".").slice(0, 3).map((part) => Number(part));
  const left = parse(actual);
  const right = parse(minimum);
  if (left.length < 2 || left.some((part) => !Number.isSafeInteger(part) || part < 0)) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

async function collectPayloadFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareNames(left.name, right.name));
  const files = [];
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Managed-tool payload must not contain symlinks: ${absolutePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...await collectPayloadFiles(root, absolutePath));
      continue;
    }
    if (!entry.isFile()) throw new Error(`Unsupported payload entry: ${absolutePath}`);
    const metadata = await stat(absolutePath);
    files.push({
      path: portablePath(root, absolutePath),
      size: metadata.size,
      sha256: await hashFile(absolutePath),
      executable: (metadata.mode & 0o111) !== 0,
    });
  }
  return files;
}

function requireValue(value, label, maximumLength = 128) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  if (value.length > maximumLength) throw new Error(`${label} is too long`);
  return value;
}

export function canonicalManifestBytes(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function createManagedToolRelease(options) {
  const root = resolve(requireValue(options.root, "payload root", 4096));
  const files = await collectPayloadFiles(root);
  if (files.length === 0) throw new Error("Managed-tool payload is empty");
  if (files.length > 64) throw new Error("Managed-tool payload contains too many files");

  const requiredTools = ["yt-dlp", "ffmpeg", "ffprobe", options.jsRuntimeName];
  for (const name of requiredTools) {
    if (!files.some((file) => file.path === `bin/${name}` && file.executable)) {
      throw new Error(`Managed-tool payload is missing executable bin/${name}`);
    }
  }
  if (options.jsRuntimeName !== "deno" || !versionAtLeast(options.jsRuntimeVersion, "2.3.0")) {
    throw new Error("The production YouTube solver requires managed Deno 2.3.0 or newer");
  }

  const provenancePath = join(root, "provenance/yt-dlp.json");
  let provenance;
  try {
    provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  } catch {
    throw new Error(
      "Managed yt-dlp must be a pinned official executable with embedded EJS provenance",
    );
  }
  const ytDlpFile = files.find((file) => file.path === "bin/yt-dlp");
  if (
    JSON.stringify(Object.keys(provenance).sort()) !== JSON.stringify([
      "distribution",
      "ejsVersion",
      "remoteComponentsAllowed",
      "schemaVersion",
      "sha256",
      "sourceUrl",
      "ytDlpVersion",
    ]) ||
    provenance.schemaVersion !== 1 ||
    provenance.distribution !== "official-executable" ||
    provenance.ytDlpVersion !== options.ytDlpVersion ||
    typeof provenance.ejsVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(provenance.ejsVersion) ||
    provenance.remoteComponentsAllowed !== false ||
    provenance.sha256 !== ytDlpFile?.sha256 ||
    typeof provenance.sourceUrl !== "string" ||
    !provenance.sourceUrl.startsWith("https://github.com/yt-dlp/yt-dlp/releases/download/")
  ) {
    throw new Error(
      "Managed yt-dlp must be a pinned official executable with embedded EJS provenance",
    );
  }

  const releaseId = requireValue(options.releaseId, "release ID", 64);
  const manifest = {
    version: releaseId,
    files: files.map(({ path, sha256 }) => ({ path, sha256 })),
  };
  const releaseMetadata = {
    schemaVersion: 1,
    releaseId,
    target: requireValue(options.target, "target"),
    compatibility: {
      protocolVersion: 1,
      companionVersion: requireValue(options.companionVersion, "companion version"),
      ytDlpVersion: requireValue(options.ytDlpVersion, "yt-dlp version"),
      ytDlpDistribution: provenance.distribution,
      youtubeSolver: {
        provider: "yt-dlp-ejs",
        version: provenance.ejsVersion,
        embedded: true,
        remoteComponentsAllowed: false,
      },
      ffmpegVersion: requireValue(options.ffmpegVersion, "FFmpeg version"),
      ffprobeVersion: requireValue(options.ffprobeVersion, "ffprobe version"),
      jsRuntime: {
        name: requireValue(options.jsRuntimeName, "JavaScript runtime name"),
        version: requireValue(options.jsRuntimeVersion, "JavaScript runtime version"),
      },
    },
    activation: {
      strategy: "versioned-atomic-pointer",
      retainPreviousReleases: 1,
      requireHealthyHelloBeforeActivation: true,
    },
    files,
  };
  return { manifest, releaseMetadata };
}

export async function createManagedToolManifest(options) {
  return (await createManagedToolRelease(options)).manifest;
}

export function signManagedToolManifest(manifest, privateKeyPem) {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Managed-tool signing key must be Ed25519");
  }
  return signBytes(null, canonicalManifestBytes(manifest), privateKey).toString("base64");
}

function verifySignature(document, signature, publicKey, label) {
  const signatureBytes = Buffer.from(signature.trim(), "base64");
  if (
    signatureBytes.length !== 64 ||
    !verifyBytes(null, canonicalManifestBytes(document), publicKey, signatureBytes)
  ) {
    throw new Error(`${label} signature is invalid`);
  }
}

export async function verifyManagedToolRelease({
  root,
  manifest,
  signature,
  releaseMetadata,
  releaseMetadataSignature,
  publicKeyPem,
}) {
  if (
    !manifest ||
    JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(["files", "version"]) ||
    typeof manifest.version !== "string" ||
    !Array.isArray(manifest.files) ||
    manifest.files.some((file) =>
      JSON.stringify(Object.keys(file).sort()) !== JSON.stringify(["path", "sha256"]))
  ) {
    throw new Error("Runtime managed-tool manifest does not match the native host contract");
  }
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Managed-tool release key must be Ed25519");
  }
  verifySignature(manifest, signature, publicKey, "Managed-tool manifest");

  const expectedFiles = [...manifest.files]
    .sort((left, right) => compareNames(left.path, right.path));
  const actualFiles = (await collectPayloadFiles(resolve(root)))
    .sort((left, right) => compareNames(left.path, right.path));
  const actualRuntimeFiles = actualFiles.map(({ path, sha256 }) => ({ path, sha256 }));
  if (JSON.stringify(actualRuntimeFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("Managed-tool payload does not match its signed manifest");
  }
  if (releaseMetadata || releaseMetadataSignature) {
    if (!releaseMetadata || !releaseMetadataSignature) {
      throw new Error("Managed-tool release metadata and signature must be provided together");
    }
    verifySignature(
      releaseMetadata,
      releaseMetadataSignature,
      publicKey,
      "Managed-tool release metadata",
    );
    if (
      releaseMetadata.schemaVersion !== 1 ||
      releaseMetadata.releaseId !== manifest.version ||
      JSON.stringify(releaseMetadata.files) !== JSON.stringify(actualFiles)
    ) {
      throw new Error("Managed-tool release metadata does not match its payload or runtime manifest");
    }
  }
  return true;
}

function parseArguments(argumentsList) {
  const [command, ...rest] = argumentsList;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("Malformed argument list");
    values[key.slice(2)] = value;
  }
  return { command, values };
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (command === "create") {
    const { manifest, releaseMetadata } = await createManagedToolRelease({
      root: values.root,
      releaseId: values["release-id"],
      target: values.target,
      companionVersion: values["companion-version"],
      ytDlpVersion: values["yt-dlp-version"],
      ffmpegVersion: values["ffmpeg-version"],
      ffprobeVersion: values["ffprobe-version"],
      jsRuntimeName: values["js-runtime-name"],
      jsRuntimeVersion: values["js-runtime-version"],
    });
    const privateKeyPem = await readFile(resolve(values["private-key"]), "utf8");
    const signature = signManagedToolManifest(manifest, privateKeyPem);
    const releaseMetadataSignature = signManagedToolManifest(releaseMetadata, privateKeyPem);
    await writeFile(resolve(values.manifest), canonicalManifestBytes(manifest));
    await writeFile(resolve(values.signature), `${signature}\n`, "utf8");
    await writeFile(
      resolve(values["release-metadata"]),
      canonicalManifestBytes(releaseMetadata),
    );
    await writeFile(
      resolve(values["release-metadata-signature"]),
      `${releaseMetadataSignature}\n`,
      "utf8",
    );
    console.log(`Created signed managed-tool manifest ${values.manifest}`);
    return;
  }
  if (command === "verify") {
    const manifest = JSON.parse(await readFile(resolve(values.manifest), "utf8"));
    const signature = await readFile(resolve(values.signature), "utf8");
    const releaseMetadata = JSON.parse(
      await readFile(resolve(values["release-metadata"]), "utf8"),
    );
    const releaseMetadataSignature = await readFile(
      resolve(values["release-metadata-signature"]),
      "utf8",
    );
    const publicKeyPem = await readFile(
      resolve(values["public-key"] ?? defaultPublicKeyPath),
      "utf8",
    );
    await verifyManagedToolRelease({
      root: values.root,
      manifest,
      signature,
      releaseMetadata,
      releaseMetadataSignature,
      publicKeyPem,
    });
    console.log(`Verified managed-tool release ${manifest.version}`);
    return;
  }
  throw new Error(
    "Usage: managed-tools.mjs create|verify with explicit manifest, signature, key, and payload arguments",
  );
}

if (resolve(process.argv[1] ?? "") === scriptPath) await main();
