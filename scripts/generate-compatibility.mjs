#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "..");

function safeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderCompatibilityTable(metadata, toolManifest) {
  const tools = toolManifest?.compatibility;
  const ytDlp = tools?.ytDlpVersion
    ? `${tools.ytDlpVersion} (${toolManifest.target})`
    : "Exact version in the signed managed-tool manifest";
  const ffmpeg = tools?.ffmpegVersion
    ? `${tools.ffmpegVersion}; ffprobe ${tools.ffprobeVersion} (${toolManifest.target})`
    : "Exact matched build versions in the signed managed-tool manifest";
  const jsRuntime = tools?.jsRuntime
    ? `${tools.jsRuntime.name} ${tools.jsRuntime.version} (${toolManifest.target})`
    : "Deno at the exact version in the signed managed-tool manifest";
  const ejs = tools?.youtubeSolver
    ? `${tools.youtubeSolver.provider} ${tools.youtubeSolver.version}, embedded in the pinned official yt-dlp executable; remote fetching disabled`
    : "Exact embedded version recorded with the pinned official yt-dlp executable; remote fetching disabled";
  const rows = [
    ["Companion extension", `${metadata.extension.companionVersion}; stable ID \`${metadata.extension.companionExtensionId}\` <!-- x-release-please-version -->`],
    ["Native host", `${metadata.nativeHost.companionVersion} on ${metadata.nativeHost.platform} ${metadata.nativeHost.architectures.join(" and ")} <!-- x-release-please-version -->`],
    ["Native protocol", metadata.nativeHost.protocolVersion],
    [metadata.browsers.primary.name, `Acceptance baseline ${metadata.browsers.primary.minimumTestedVersion} or newer compatible Stable release`],
    [metadata.browsers.secondary.name, `Acceptance baseline ${metadata.browsers.secondary.minimumTestedVersion} or newer compatible Stable release`],
    ["yt-dlp", ytDlp],
    ["YouTube EJS solver", ejs],
    ["FFmpeg / ffprobe", ffmpeg],
    ["JavaScript runtime", jsRuntime],
  ];
  return `# Companion compatibility

This table is generated from release compatibility metadata. Exact managed
tool versions are added from the signed tool manifest for each architecture;
the extension refuses an unlisted or unhealthy combination.

| Component | Supported release |
| --- | --- |
${rows.map(([component, release]) => `| ${safeCell(component)} | ${safeCell(release)} |`).join("\n")}

A release record is incomplete if its signed manifest, compatibility metadata,
tool notices, or architecture-specific checksums are missing.
`;
}

async function main() {
  const argumentsList = process.argv.slice(2);
  let toolManifestPath;
  if (argumentsList.length === 2 && argumentsList[0] === "--managed-tool-manifest") {
    toolManifestPath = resolve(argumentsList[1]);
  } else if (argumentsList.length !== 0) {
    throw new Error("Usage: generate-compatibility.mjs [--managed-tool-manifest path]");
  }
  const metadata = JSON.parse(
    await readFile(join(projectRoot, "packaging/compatibility.json"), "utf8"),
  );
  const toolManifest = toolManifestPath
    ? JSON.parse(await readFile(toolManifestPath, "utf8"))
    : undefined;
  const output = renderCompatibilityTable(metadata, toolManifest);
  await writeFile(join(projectRoot, "docs/companion/compatibility.md"), output, "utf8");
  console.log("Generated docs/companion/compatibility.md");
}

if (resolve(process.argv[1] ?? "") === scriptPath) await main();
