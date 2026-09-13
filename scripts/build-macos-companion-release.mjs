#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPANION_EXTENSION_ID,
  COMPANION_MANIFEST_KEY,
  extensionIdFromManifestKey,
} from "../build/extension-variants.mjs";
import {
  defaultPublicKeyPath,
  verifyManagedToolRelease,
} from "./managed-tools.mjs";
import { renderCompatibilityTable } from "./generate-compatibility.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));

export function parseArguments(argumentsList) {
  const values = { development: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const key = argumentsList[index];
    if (key === "--development") {
      values.development = true;
      continue;
    }
    const value = argumentsList[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("Malformed argument list");
    values[key.slice(2)] = value;
    index += 1;
  }
  return values;
}

export function validateReleaseArgumentPolicy(values) {
  if (values.development) return;
  if (typeof values["sign-identity"] !== "string" || !values["sign-identity"].trim()) {
    throw new Error("Production release creation requires --sign-identity");
  }
  if (typeof values["notary-profile"] !== "string" || !values["notary-profile"].trim()) {
    throw new Error("Production release creation requires --notary-profile");
  }
}

function required(values, name) {
  const value = values[name];
  if (typeof value !== "string" || !value) throw new Error(`--${name} is required`);
  return resolve(value);
}

function run(executable, argumentsList) {
  const result = spawnSync(executable, argumentsList, { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(
      `${executable} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

function verifyDeveloperIdSignature(path, label) {
  run("codesign", ["--verify", "--strict", "--verbose=2", path]);
  const details = spawnSync("codesign", ["-dv", "--verbose=4", path], {
    encoding: "utf8",
    stdio: "pipe",
  });
  const output = `${details.stdout ?? ""}\n${details.stderr ?? ""}`;
  if (details.status !== 0 || !/Authority=Developer ID Application:/i.test(output)) {
    throw new Error(`${label} must be individually signed with Developer ID before manifest hashing`);
  }
}

async function makeApp({ name, identifier, source, destination, resources, target }) {
  const contents = join(destination, "Contents");
  const executableDirectory = join(contents, "MacOS");
  const resourceDirectory = join(contents, "Resources");
  await mkdir(executableDirectory, { recursive: true });
  await mkdir(resourceDirectory, { recursive: true });

  const executableName = name.replaceAll(" ", "");
  const executablePath = join(executableDirectory, executableName);
  run("xcrun", [
    "swiftc",
    "-target",
    `${target}-apple-macosx13.0`,
    "-module-cache-path",
    join(projectRoot, ".build", "swift-module-cache"),
    "-O",
    "-parse-as-library",
    "-framework",
    "AppKit",
    join(projectRoot, "installer/macos/InstallerSupport.swift"),
    join(projectRoot, source),
    "-o",
    executablePath,
  ]);
  await chmod(executablePath, 0o755);

  const info = {
    CFBundleDevelopmentRegion: "en",
    CFBundleDisplayName: name,
    CFBundleExecutable: executableName,
    CFBundleIdentifier: identifier,
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: name,
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: packageMetadata.version,
    CFBundleVersion: packageMetadata.version,
    LSMinimumSystemVersion: "13.0",
    NSHighResolutionCapable: true,
  };
  await writeFile(join(contents, "Info.plist"), JSON.stringify(info, null, 2), "utf8");
  run("plutil", ["-convert", "xml1", join(contents, "Info.plist")]);
  await writeFile(join(contents, "PkgInfo"), "APPL????", "utf8");
  if (resources) await resources(resourceDirectory);
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("The graphical macOS release must be built on macOS");
  }
  const values = parseArguments(process.argv.slice(2));
  const host = required(values, "host");
  const tools = required(values, "tools");
  const toolManifestPath = required(values, "tool-manifest");
  const toolSignaturePath = required(values, "tool-signature");
  const toolReleaseMetadataPath = required(values, "tool-release-metadata");
  const toolReleaseMetadataSignaturePath = required(
    values,
    "tool-release-metadata-signature",
  );
  const extension = resolve(values.extension ?? join(projectRoot, "dist-companion"));
  const outputDirectory = resolve(values.output ?? join(projectRoot, "artifacts"));
  validateReleaseArgumentPolicy(values);

  const hostMetadata = await stat(host);
  if (!hostMetadata.isFile() || (hostMetadata.mode & 0o111) === 0) {
    throw new Error("Native host must be an executable regular file");
  }
  if (!values.development) {
    verifyDeveloperIdSignature(host, "Native host");
    for (const name of ["yt-dlp", "ffmpeg", "ffprobe", "deno"]) {
      verifyDeveloperIdSignature(join(tools, "bin", name), `Managed ${name}`);
    }
  }
  const extensionManifest = JSON.parse(
    await readFile(join(extension, "manifest.json"), "utf8"),
  );
  if (
    extensionManifest.version !== packageMetadata.version ||
    extensionManifest.key !== COMPANION_MANIFEST_KEY ||
    extensionIdFromManifestKey(extensionManifest.key) !== COMPANION_EXTENSION_ID ||
    !extensionManifest.permissions?.includes("nativeMessaging") ||
    !extensionManifest.optional_permissions?.includes("cookies")
  ) {
    throw new Error("Extension input is not the reviewed companion variant");
  }

  const toolManifest = JSON.parse(await readFile(toolManifestPath, "utf8"));
  const toolSignature = await readFile(toolSignaturePath, "utf8");
  const toolReleaseMetadata = JSON.parse(
    await readFile(toolReleaseMetadataPath, "utf8"),
  );
  const toolReleaseMetadataSignature = await readFile(
    toolReleaseMetadataSignaturePath,
    "utf8",
  );
  const publicKeyPem = await readFile(defaultPublicKeyPath, "utf8");
  await verifyManagedToolRelease({
    root: tools,
    manifest: toolManifest,
    signature: toolSignature,
    releaseMetadata: toolReleaseMetadata,
    releaseMetadataSignature: toolReleaseMetadataSignature,
    publicKeyPem,
  });
  const target = toolReleaseMetadata.target;
  if (!["arm64", "x86_64"].includes(target) ||
      toolReleaseMetadata.compatibility?.companionVersion !== packageMetadata.version) {
    throw new Error("Managed tools must match this release version and a supported Mac architecture");
  }
  for (const binary of [host, ...["yt-dlp", "ffmpeg", "ffprobe", "deno"].map(
    (name) => join(tools, "bin", name),
  )]) {
    run("lipo", [binary, "-verify_arch", target]);
  }

  const releaseName = values.development
    ? `media-sniper-companion-macos-${toolReleaseMetadata.target}-development-v${packageMetadata.version}`
    : `media-sniper-companion-macos-${toolReleaseMetadata.target}-v${packageMetadata.version}`;
  // Cloud-synced project directories can reattach Finder metadata during signing.
  const releaseRoot = await mkdtemp(join(tmpdir(), `${releaseName}-`));
  const diskImagePath = join(outputDirectory, `${releaseName}.dmg`);
  await mkdir(outputDirectory, { recursive: true });
  await rm(releaseRoot, { force: true, recursive: true });
  await rm(diskImagePath, { force: true });
  await mkdir(releaseRoot, { recursive: true });

  const installApp = join(releaseRoot, "Install Media Sniper Companion.app");
  await makeApp({
    target,
    name: "Install Media Sniper Companion",
    identifier: "com.grej.media-sniper.companion-installer",
    source: "installer/macos/InstallMediaSniperCompanion.swift",
    destination: installApp,
    resources: async (resourceDirectory) => {
      const payload = join(resourceDirectory, "payload");
      await mkdir(join(payload, "native-host"), { recursive: true });
      await cp(host, join(payload, "native-host/media-sniper-companion"));
      await chmod(join(payload, "native-host/media-sniper-companion"), 0o755);
      await cp(
        join(projectRoot, "packaging/native-host/com.grej.media_sniper.json.in"),
        join(payload, "native-host/com.grej.media_sniper.json.in"),
      );
      await cp(extension, join(payload, "extension"), { recursive: true });
      await mkdir(join(payload, "managed-tools/payload"), { recursive: true });
      await cp(tools, join(payload, "managed-tools/payload"), { recursive: true });
      await cp(toolManifestPath, join(payload, "managed-tools/manifest.json"));
      await cp(toolSignaturePath, join(payload, "managed-tools/manifest.sig"));
      await cp(
        toolReleaseMetadataPath,
        join(payload, "managed-tools/release-metadata.json"),
      );
      await cp(
        toolReleaseMetadataSignaturePath,
        join(payload, "managed-tools/release-metadata.sig"),
      );
      await cp(defaultPublicKeyPath, join(payload, "managed-tools/release-public-key.pem"));
      await cp(join(projectRoot, "packaging/compatibility.json"), join(payload, "compatibility.json"));
      const compatibility = JSON.parse(
        await readFile(join(projectRoot, "packaging/compatibility.json"), "utf8"),
      );
      await writeFile(
        join(payload, "COMPATIBILITY.md"),
        renderCompatibilityTable(compatibility, toolReleaseMetadata),
        "utf8",
      );
      await cp(
        join(projectRoot, "packaging/companion/THIRD_PARTY_NOTICES.md"),
        join(payload, "THIRD_PARTY_NOTICES.md"),
      );
      await writeFile(
        join(payload, "release.json"),
        `${JSON.stringify({
          schemaVersion: 2,
          releaseVersion: packageMetadata.version,
          extensionVersion: packageMetadata.version,
          companionVersion: packageMetadata.version,
          extensionId: COMPANION_EXTENSION_ID,
          toolReleaseId: toolManifest.version,
          target: toolReleaseMetadata.target,
        }, null, 2)}\n`,
        "utf8",
      );
    },
  });

  const uninstallApp = join(releaseRoot, "Uninstall Media Sniper Companion.app");
  await makeApp({
    target,
    name: "Uninstall Media Sniper Companion",
    identifier: "com.grej.media-sniper.companion-uninstaller",
    source: "installer/macos/UninstallMediaSniperCompanion.swift",
    destination: uninstallApp,
  });

  const signIdentity = values.development ? "-" : values["sign-identity"];
  for (const app of [installApp, uninstallApp]) {
    // Copied source files can carry Finder metadata that invalidates app signing.
    run("xattr", ["-cr", app]);
    const signingArguments = ["--force"];
    if (!values.development) {
      signingArguments.push("--options", "runtime", "--timestamp");
    }
    signingArguments.push("--sign", signIdentity, app);
    run("codesign", signingArguments);
    run("codesign", ["--verify", "--deep", "--strict", app]);
  }

  run("hdiutil", [
    "create",
    "-fs",
    "HFS+",
    "-format",
    "UDZO",
    "-srcfolder",
    releaseRoot,
    "-volname",
    "Media Sniper Companion",
    diskImagePath,
  ]);
  if (!values.development) {
    run("xcrun", [
      "notarytool",
      "submit",
      diskImagePath,
      "--keychain-profile",
      values["notary-profile"],
      "--wait",
    ]);
    run("xcrun", ["stapler", "staple", diskImagePath]);
    run("xcrun", ["stapler", "validate", diskImagePath]);
  }
  const digest = createHash("sha256").update(await readFile(diskImagePath)).digest("hex");
  await writeFile(`${diskImagePath}.sha256`, `${digest}  ${releaseName}.dmg\n`, "utf8");
  await rm(releaseRoot, { force: true, recursive: true });
  console.log(`Created ${diskImagePath}`);
  console.log(`SHA-256: ${digest}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
