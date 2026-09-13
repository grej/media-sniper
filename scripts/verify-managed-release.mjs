#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const bundle = resolve(process.argv[2] ?? join(root, "artifacts", `managed-tools-arm64-v${version}`));
const pageUrl = process.argv[3];
const temporary = await mkdtemp(join(tmpdir(), "media-sniper-release-check-"));
const events = [];
let child;
let stderr = "";
try {
  await cp(bundle, join(temporary, "staged"), { recursive: true });
  await mkdir(join(temporary, "Media Sniper"), { mode: 0o700 });
  child = spawn(join(root, "companion/target/release/examples/verify_release"), [temporary], { stdio: ["pipe", "pipe", "pipe"] });
  let buffered = Buffer.alloc(0);
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  child.stdout.on("data", (bytes) => {
    buffered = Buffer.concat([buffered, bytes]);
    while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE(0)) {
      const length = buffered.readUInt32LE(0);
      events.push(JSON.parse(buffered.subarray(4, 4 + length)));
      buffered = buffered.subarray(4 + length);
    }
  });
  function send(type, payload, requestId = type) {
    const body = Buffer.from(JSON.stringify({ protocolVersion: 1, requestId, type, payload }));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([header, body]));
  }
  async function waitFor(type, requestId) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const failure = events.find((event) => event.requestId === requestId && ["job_failed", "auth_required"].includes(event.type));
      if (failure) throw new Error(`${JSON.stringify(failure)}\n${stderr}`);
      const event = events.find((event) => event.type === type && event.requestId === requestId);
      if (event) return event.payload;
      if (child.exitCode !== null) throw new Error(`Verifier exited: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${type}: ${stderr}`);
  }
  send("hello", { browserTarget: "brave", extensionVersion: version });
  const hello = await waitFor("hello_result", "hello");
  assert.equal(hello.healthy, true, JSON.stringify(hello.issues));
  assert.equal(hello.companionVersion, version);
  console.log(`Verified production signature activation and healthy native hello (${version})`);
  if (pageUrl) {
    send("probe", { pageUrl, auth: { mode: "anonymous" } });
    const media = await waitFor("probe_result", "probe");
    assert(media.selections.length > 0);
    const selected = media.selections.find((selection) => !selection.audioOnly) ?? media.selections[0];
    send("start_download", { jobId: "release-download", probeToken: media.probeToken, selectionKey: selected.key,
      auth: { mode: "anonymous" } }, "download");
    await waitFor("job_completed", "download");
    send("start_clip", { jobId: "release-clip", probeToken: media.probeToken, selectionKey: selected.key,
      clip: { startMs: 1000, endMs: 3000, mode: "exact" }, allowFullDownloadFallback: false,
      auth: { mode: "anonymous" } }, "clip");
    await waitFor("job_completed", "clip");
    const outputs = await readdir(join(temporary, "Downloads"));
    assert(outputs.length >= 2);
    const durations = outputs.map((name) => {
      const inspected = spawnSync(join(bundle, "payload/bin/ffprobe"), ["-v", "error", "-show_entries", "format=duration", "-of", "json", join(temporary, "Downloads", name)], { encoding: "utf8" });
      assert.equal(inspected.status, 0, inspected.stderr);
      return Number(JSON.parse(inspected.stdout).format.duration);
    });
    assert(durations.some((duration) => Math.abs(duration - 2) < 0.2), "Exact clip must have the requested two-second duration");
    console.log("Verified real anonymous probe, download, and Exact clip with the bundled tools");
  }
  await mkdir(join(root, "artifacts/release-validation"), { recursive: true });
  await writeFile(join(root, "artifacts/release-validation/native-smoke.json"), JSON.stringify({
    version, healthy: hello.healthy, companionVersion: hello.companionVersion,
    ytDlpVersion: hello.ytDlpVersion, ffmpegVersion: hello.ffmpegVersion,
    ffprobeVersion: hello.ffprobeVersion, jsRuntime: hello.jsRuntime,
    pageUrl, verifiedOperations: pageUrl ? ["probe", "download", "exact-clip"] : ["hello"],
  }, null, 2) + "\n");
} finally {
  if (child) { child.stdin.end(); child.kill(); }
  await rm(temporary, { recursive: true, force: true });
}
