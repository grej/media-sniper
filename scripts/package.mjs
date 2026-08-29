#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPANION_EXTENSION_ID,
  COMPANION_MANIFEST_KEY,
  extensionIdFromManifestKey,
} from "../build/extension-variants.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDirectory = join(projectRoot, "artifacts");
const packageMetadata = JSON.parse(
  await readFile(join(projectRoot, "package.json"), "utf8"),
);
const argumentsList = process.argv.slice(2);
let checkOnly = false;
let variant = "standard";
for (let index = 0; index < argumentsList.length; index += 1) {
  const argument = argumentsList[index];
  if (argument === "--check") {
    checkOnly = true;
  } else if (argument === "--variant") {
    variant = argumentsList[index + 1];
    index += 1;
  } else {
    throw new Error(
      "Usage: node scripts/package.mjs [--check] [--variant standard|companion]",
    );
  }
}
if (variant !== "standard" && variant !== "companion") {
  throw new Error(`Unsupported package variant: ${variant}`);
}

const distDirectory = join(projectRoot, variant === "standard" ? "dist" : "dist-companion");
const archiveBasename =
  `${packageMetadata.name}-${variant}-v${packageMetadata.version}.zip`;
const archivePath = join(artifactsDirectory, archiveBasename);
const checksumPath = `${archivePath}.sha256`;
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 33; // 1980-01-01, the earliest ZIP timestamp.
const UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;
const MAX_ZIP32_VALUE = 0xffffffff;

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function archiveName(absolutePath, root = distDirectory) {
  return relative(root, absolutePath).split(sep).join("/");
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareNames(left.name, right.name));
  const files = [];
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath)));
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".d.mts")) continue;
      files.push({
        absolutePath,
        archivePath: archiveName(absolutePath),
      });
    } else {
      throw new Error(`Unsupported package input: ${absolutePath}`);
    }
  }
  return files;
}

function makeCrc32Table() {
  return Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  });
}

const crc32Table = makeCrc32Table();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = crc32Table[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function assertZip32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_ZIP32_VALUE) {
    throw new Error(`${label} exceeds the deterministic ZIP32 limit`);
  }
}

function localHeader(filename, checksum, size) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(ZIP_VERSION, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(0, 8); // Stored: no host-dependent compression output.
  header.writeUInt16LE(FIXED_DOS_TIME, 10);
  header.writeUInt16LE(FIXED_DOS_DATE, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(size, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(filename.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(filename, checksum, size, localOffset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(ZIP_VERSION, 4);
  header.writeUInt16LE(ZIP_VERSION, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(FIXED_DOS_TIME, 12);
  header.writeUInt16LE(FIXED_DOS_DATE, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(size, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(filename.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(localOffset, 42);
  return header;
}

function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
  if (entryCount > 0xffff) {
    throw new Error("Package contains too many entries for deterministic ZIP32");
  }
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(centralOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

async function writeAll(file, bytes, position) {
  let written = 0;
  while (written < bytes.length) {
    const result = await file.write(
      bytes,
      written,
      bytes.length - written,
      position + written,
    );
    if (result.bytesWritten === 0) throw new Error("Could not write ZIP archive");
    written += result.bytesWritten;
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function listStoredZipEntries(bytes) {
  const entries = [];
  let offset = 0;
  while (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    if (offset + 30 > bytes.length) throw new Error("Truncated ZIP local header");
    const method = bytes.readUInt16LE(offset + 8);
    const size = bytes.readUInt32LE(offset + 18);
    const filenameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    if (method !== 0) throw new Error("Release ZIP contains a non-deterministic compressed entry");
    const nameStart = offset + 30;
    const dataStart = nameStart + filenameLength + extraLength;
    const nextOffset = dataStart + size;
    if (nextOffset > bytes.length) throw new Error("Truncated ZIP entry");
    entries.push({
      name: bytes.subarray(nameStart, nameStart + filenameLength).toString("utf8"),
      contents: bytes.subarray(dataStart, nextOffset),
    });
    offset = nextOffset;
  }
  return entries;
}

function validateArchiveEntries(entries) {
  const names = entries.map((entry) => entry.name);
  const required = [
    "manifest.json",
    "background.js",
    "content.js",
    "popup/popup.html",
    "popup/popup.js",
    "options/options.html",
    "options/options.js",
    "offscreen/offscreen.html",
    "offscreen/offscreen.js",
    "ffmpeg/core/ffmpeg-core.js",
    "ffmpeg/core/ffmpeg-core.wasm",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ];
  for (const name of required) {
    if (!names.includes(name)) throw new Error(`Release ZIP is missing ${name}`);
  }
  const forbidden = names.find((name) =>
    name.endsWith(".map") || name.endsWith(".d.ts") || name.endsWith(".d.mts") ||
    name.startsWith("tests/") || name.startsWith("src/") || name.startsWith("node_modules/")
  );
  if (forbidden) throw new Error(`Release ZIP contains forbidden source artifact: ${forbidden}`);
  if (variant === "companion" && !names.includes("COMPATIBILITY.json")) {
    throw new Error("Companion release ZIP is missing COMPATIBILITY.json");
  }

  validateArtifactContents(entries, "release ZIP");
}

const STANDARD_FORBIDDEN_TOKENS = ["nativeMessaging", "cookies", "companion"];

function validateArtifactContents(entries, label) {
  if (variant !== "standard") return;
  for (const entry of entries) {
    // Scan every executable bundle and textual resource. Browser FFmpeg's
    // reviewed WASM includes an unrelated libcurl "cookies" diagnostic, so
    // opaque binary payloads are covered by their pinned dependency hash
    // rather than treated as extension-feature evidence.
    if (/\.(?:wasm|png|woff2)$/i.test(entry.name)) continue;
    for (const token of STANDARD_FORBIDDEN_TOKENS) {
      if (entry.contents.includes(Buffer.from(token, "utf8"))) {
        throw new Error(
          `Standard ${label} contains forbidden token ${JSON.stringify(token)} in ${entry.name}`,
        );
      }
    }
  }
}

async function validateBuild() {
  const manifestPath = join(distDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const expectedName = variant === "standard" ? "Media Sniper" : "Media Sniper Companion";
  if (manifest.name !== expectedName) {
    throw new Error(`Built manifest has unexpected name: ${manifest.name}`);
  }
  if (manifest.version !== packageMetadata.version) {
    throw new Error(
      `Version mismatch: package ${packageMetadata.version}, manifest ${manifest.version}`,
    );
  }
  const permissionSet = new Set(manifest.permissions ?? []);
  const optionalPermissionSet = new Set(manifest.optional_permissions ?? []);
  if (variant === "standard") {
    if (manifest.key) throw new Error("Standard manifest must not contain a stable companion key");
    if (permissionSet.has("nativeMessaging") || optionalPermissionSet.has("cookies")) {
      throw new Error("Standard manifest contains a companion-only permission");
    }
  } else {
    if (manifest.key !== COMPANION_MANIFEST_KEY) {
      throw new Error("Companion manifest does not contain the reviewed public key");
    }
    if (extensionIdFromManifestKey(manifest.key) !== COMPANION_EXTENSION_ID) {
      throw new Error("Companion manifest key derives an unexpected extension ID");
    }
    if (!permissionSet.has("nativeMessaging") || !optionalPermissionSet.has("cookies")) {
      throw new Error("Companion manifest is missing nativeMessaging or optional cookies");
    }
  }
}

async function createPackage() {
  await validateBuild();
  const files = await collectFiles(distDirectory);
  const notices = [
    { source: "LICENSE", archivePath: "LICENSE" },
    {
      source: variant === "standard"
        ? "THIRD_PARTY_NOTICES.md"
        : "packaging/companion/THIRD_PARTY_NOTICES.md",
      archivePath: "THIRD_PARTY_NOTICES.md",
    },
  ];
  if (variant === "companion") {
    notices.push({
      source: "packaging/compatibility.json",
      archivePath: "COMPATIBILITY.json",
    });
  }
  for (const notice of notices) {
    files.push({
      absolutePath: join(projectRoot, notice.source),
      archivePath: notice.archivePath,
    });
  }
  files.sort((left, right) => compareNames(left.archivePath, right.archivePath));
  const names = new Set();
  for (const file of files) {
    if (
      !file.archivePath ||
      file.archivePath.startsWith("/") ||
      file.archivePath.split("/").includes("..")
    ) {
      throw new Error(`Unsafe archive path: ${file.archivePath}`);
    }
    if (names.has(file.archivePath)) {
      throw new Error(`Duplicate archive path: ${file.archivePath}`);
    }
    names.add(file.archivePath);
    const metadata = await stat(file.absolutePath);
    if (!metadata.isFile()) throw new Error(`Package input is not a file: ${file.absolutePath}`);
  }

  validateArtifactContents(
    await Promise.all(files.map(async (file) => ({
      name: file.archivePath,
      contents: await readFile(file.absolutePath),
    }))),
    "build",
  );

  await mkdir(artifactsDirectory, { recursive: true });
  const temporaryPath = `${archivePath}.tmp`;
  const output = await open(temporaryPath, "w");
  const centralRecords = [];
  let offset = 0;
  try {
    for (const input of files) {
      const filename = Buffer.from(input.archivePath, "utf8");
      const contents = await readFile(input.absolutePath);
      assertZip32(contents.length, `${input.archivePath} size`);
      assertZip32(offset, `${input.archivePath} offset`);
      if (filename.length > 0xffff) throw new Error(`Archive path is too long: ${input.archivePath}`);
      const checksum = crc32(contents);
      const header = localHeader(filename, checksum, contents.length);
      await writeAll(output, header, offset);
      await writeAll(output, filename, offset + header.length);
      await writeAll(output, contents, offset + header.length + filename.length);
      centralRecords.push(
        Buffer.concat([
          centralHeader(filename, checksum, contents.length, offset),
          filename,
        ]),
      );
      offset += header.length + filename.length + contents.length;
    }

    const centralOffset = offset;
    for (const record of centralRecords) {
      await writeAll(output, record, offset);
      offset += record.length;
    }
    const centralSize = offset - centralOffset;
    assertZip32(centralOffset, "Central directory offset");
    assertZip32(centralSize, "Central directory size");
    const end = endOfCentralDirectory(files.length, centralSize, centralOffset);
    await writeAll(output, end, offset);
  } finally {
    await output.close();
  }

  await rm(archivePath, { force: true });
  await rename(temporaryPath, archivePath);
  const digest = await sha256(archivePath);
  await writeFile(checksumPath, `${digest}  ${archiveBasename}\n`, "utf8");
  const archiveStats = await stat(archivePath);
  console.log(`Packaged ${files.length} files: ${relative(projectRoot, archivePath)}`);
  console.log(`Size: ${archiveStats.size} bytes`);
  console.log(`SHA-256: ${digest}`);
}

async function checkPackage() {
  const checksum = (await readFile(checksumPath, "utf8")).trim();
  const match = checksum.match(/^([a-f0-9]{64})  (.+)$/);
  if (!match || match[2] !== archiveBasename) {
    throw new Error(`Malformed checksum file: ${relative(projectRoot, checksumPath)}`);
  }
  const actual = await sha256(archivePath);
  if (actual !== match[1]) {
    throw new Error(`SHA-256 mismatch for ${archiveBasename}`);
  }
  const entries = listStoredZipEntries(await readFile(archivePath));
  validateArchiveEntries(entries);
  console.log(`Verified ${archiveBasename} (${entries.length} entries, ${variant} variant)`);
  console.log(`SHA-256: ${actual}`);
}

if (checkOnly) await checkPackage();
else await createPackage();
