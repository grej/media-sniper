#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseStageArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Use --dmg <path> --subdir <osx-arm64|osx-64>");
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

export async function stageCondaInstaller({ dmg, subdir }) {
  if (subdir !== "osx-arm64" && subdir !== "osx-64") throw new Error("Unsupported Conda subdir");
  const packageMetadata = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const source = resolve(dmg);
  const sourceStat = await stat(source);
  if (!sourceStat.isFile() || !source.endsWith(".dmg")) throw new Error("A built Media Sniper DMG is required");
  const filename = basename(source);
  if (!filename.includes(`-v${packageMetadata.version}.dmg`)) {
    throw new Error(`DMG filename must identify release ${packageMetadata.version}`);
  }
  const targetMarker = subdir === "osx-arm64" ? "macos-arm64" : "macos-x86_64";
  if (!filename.includes(targetMarker)) throw new Error(`DMG filename does not match ${subdir}`);
  const bytes = await readFile(source);
  if (bytes.length < 512 || bytes.toString("ascii", bytes.length - 512, bytes.length - 508) !== "koly") {
    throw new Error("Installer payload must be a real UDIF disk image, not a placeholder");
  }

  const payload = join(projectRoot, "packaging/conda/payload");
  await rm(payload, { recursive: true, force: true });
  await mkdir(payload, { recursive: true });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await copyFile(source, join(payload, "media-sniper-companion.dmg"));
  await copyFile(join(projectRoot, "LICENSE"), join(payload, "LICENSE"));
  await writeFile(join(payload, "target-subdir"), `${subdir}\n`, "utf8");
  await writeFile(join(payload, "release-version"), `${packageMetadata.version}\n`, "utf8");
  await writeFile(join(payload, "payload.json"), `${JSON.stringify({
    schemaVersion: 1,
    package: "media-sniper-installer",
    releaseVersion: packageMetadata.version,
    subdir,
    sourceFilename: filename,
    sha256,
  }, null, 2)}\n`, "utf8");
  return { payload, sha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = parseStageArguments(process.argv.slice(2));
  const result = await stageCondaInstaller(values);
  console.log(`Staged ${result.payload}`);
  console.log(`SHA-256: ${result.sha256}`);
}
