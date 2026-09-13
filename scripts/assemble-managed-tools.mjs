#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalManifestBytes, createManagedToolRelease, signManagedToolManifest, verifyManagedToolRelease } from "./managed-tools.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [target, keyFile] = process.argv.slice(2);
if (!["arm64", "x86_64"].includes(target) || !keyFile) {
  throw new Error("Usage: assemble-managed-tools.mjs <arm64|x86_64> <private-key-file>");
}
const sources = JSON.parse(await readFile(join(root, "packaging/managed-tools/sources.json"), "utf8"));
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const downloads = join(root, ".build/tool-downloads");
const nativeBuild = join(root, ".build/portable-media");
const output = join(root, "artifacts", `managed-tools-${target}-v${version}`);
const payload = join(output, "payload");
const bin = join(payload, "bin");
await mkdir(bin, { recursive: true });
await mkdir(join(payload, "licenses"), { recursive: true });
await mkdir(join(payload, "provenance"), { recursive: true });

async function verifyHash(path, expected) {
  const actual = createHash("sha256").update(await readFile(path)).digest("hex");
  if (actual !== expected) throw new Error(`Pinned source checksum mismatch: ${path}`);
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr || result.stdout}`);
  return result.stdout;
}
await verifyHash(join(downloads, "yt-dlp_macos"), sources.ytDlp.sha256);
await verifyHash(join(downloads, `yt-dlp-${sources.ytDlp.version}.tar.gz`), sources.ytDlp.sourceSha256);
await verifyHash(join(nativeBuild, "downloads", `ffmpeg-${sources.ffmpeg.version}.tar.xz`), sources.ffmpeg.sha256);
await verifyHash(join(nativeBuild, "downloads", `lame-${sources.lame.version}.tar.gz`), sources.lame.sha256);
await verifyHash(join(nativeBuild, "downloads", `x264-${sources.x264.revision}.tar.gz`), sources.x264.sha256);
const denoArchive = join(downloads, target === "arm64" ? "deno-aarch64-apple-darwin.zip" : "deno-x86_64-apple-darwin.zip");
await verifyHash(denoArchive, sources.deno[target].sha256);
await copyFile(join(downloads, "yt-dlp_macos"), join(bin, "yt-dlp"));
run("unzip", ["-o", "-j", denoArchive, "deno", "-d", bin]);
for (const name of ["ffmpeg", "ffprobe"]) {
  await copyFile(join(nativeBuild, target, "prefix/bin", name), join(bin, name));
  const dependencies = run("otool", ["-L", join(bin, name)]).split("\n").slice(1).map((line) => line.trim().split(" ")[0]).filter(Boolean);
  if (dependencies.some((dependency) => !dependency.startsWith("/usr/lib/") && !dependency.startsWith("/System/Library/"))) {
    throw new Error(`${name} has a dependency outside macOS system libraries`);
  }
}
for (const name of ["yt-dlp", "ffmpeg", "ffprobe", "deno"]) {
  await chmod(join(bin, name), 0o755);
  run("lipo", [join(bin, name), "-verify_arch", target]);
}
for (const [source, name] of [
  [join(nativeBuild, "sources/ffmpeg/COPYING.GPLv2"), "FFmpeg-GPLv2.txt"],
  [join(nativeBuild, "sources/ffmpeg/COPYING.GPLv3"), "GPLv3.txt"],
  [join(nativeBuild, "sources/x264/COPYING"), "x264-GPLv2.txt"],
  [join(nativeBuild, "sources/lame/COPYING"), "LAME-LGPLv2.txt"],
  [join(downloads, "yt-dlp-source/LICENSE"), "yt-dlp-Unlicense.txt"],
  [join(downloads, "YT-DLP-THIRD-PARTY-LICENSES.txt"), "yt-dlp-third-party.txt"],
  [join(downloads, "DENO-LICENSE.md"), "Deno-MIT.txt"],
]) await copyFile(source, join(payload, "licenses", name));
await copyFile(join(root, "packaging/companion/THIRD_PARTY_NOTICES.md"), join(payload, "THIRD_PARTY_NOTICES.md"));
await copyFile(join(root, "packaging/managed-tools/sources.json"), join(payload, "provenance/sources.json"));
await writeFile(join(payload, "provenance/yt-dlp.json"), JSON.stringify({
  schemaVersion: 1, distribution: "official-executable", ytDlpVersion: sources.ytDlp.version,
  ejsVersion: sources.ytDlp.ejsVersion, remoteComponentsAllowed: false,
  sha256: sources.ytDlp.sha256, sourceUrl: sources.ytDlp.url,
}, null, 2) + "\n");
await copyFile(join(nativeBuild, target, "ffmpeg/config.h"), join(payload, "provenance/ffmpeg-config.h"));
const { manifest, releaseMetadata } = await createManagedToolRelease({
  root: payload, releaseId: `media-sniper-${version}-${target}`, target,
  companionVersion: version, ytDlpVersion: sources.ytDlp.version,
  ffmpegVersion: sources.ffmpeg.version, ffprobeVersion: sources.ffmpeg.version,
  jsRuntimeName: "deno", jsRuntimeVersion: sources.deno.version,
});
const privateKey = await readFile(resolve(keyFile), "utf8");
const signature = signManagedToolManifest(manifest, privateKey);
const releaseMetadataSignature = signManagedToolManifest(releaseMetadata, privateKey);
await verifyManagedToolRelease({ root: payload, manifest, signature, releaseMetadata, releaseMetadataSignature,
  publicKeyPem: await readFile(join(root, "packaging/managed-tools/release-public-key.pem"), "utf8") });
for (const [name, bytes] of [
  ["manifest.json", canonicalManifestBytes(manifest)], ["manifest.sig", `${signature}\n`],
  ["release-metadata.json", canonicalManifestBytes(releaseMetadata)], ["release-metadata.sig", `${releaseMetadataSignature}\n`],
]) await writeFile(join(output, name), bytes);
console.log(`Verified and signed ${output}`);
