import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  createCompanionEnvelope,
  isCompanionEnvelope,
  validateCompanionEvent,
  validateCompanionRequest,
} from "@/core/companion/protocol";
import { COMPANION_MAX_MESSAGE_BYTES } from "@/core/companion/types";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve("protocol/fixtures", name), "utf8"));
}

const schema = JSON.parse(readFileSync(resolve("protocol/companion-v1.schema.json"), "utf8"));
const validateSchema = new Ajv2020({ allErrors: true }).compile(schema);
const anonymous = { mode: "anonymous" };
const validByType: Record<string, Record<string, unknown>> = {
  hello: { browserTarget: "brave", extensionVersion: "1.12.0" },
  probe: { pageUrl: "https://example.test/watch", auth: anonymous },
  start_download: { jobId: "job", probeToken: "token", selectionKey: "best", auth: anonymous },
  start_clip: { jobId: "job", probeToken: "token", selectionKey: "best", auth: anonymous, clip: { startMs: 0, endMs: 10_000, mode: "exact" }, allowFullDownloadFallback: false },
  cancel_job: { jobId: "job" },
  reveal_output: { outputToken: "output" },
  open_output: { outputToken: "output" },
  install_tools: {},
  update_tools: {},
  hello_result: {
    protocolVersion: 1, companionVersion: "1.0.0", browserTarget: "brave", platform: "macos",
    healthy: true, issues: [], braveProfiles: [], capabilities: {
      probe: true, download: true, sectionDownload: true, exactClip: true,
      currentTabCookies: true, braveProfileCookies: true, revealOutput: true,
    },
  },
  probe_result: (fixture("probe-result.json") as { payload: Record<string, unknown> }).payload,
  auth_required: { code: "AUTH_REQUIRED", message: "Sign in required", recoverable: true },
  job_queued: { jobId: "job", position: 1 },
  job_progress: { jobId: "job", stage: "downloading", downloadedBytes: 1, totalBytes: 2, percentage: 50 },
  fallback_required: { jobId: "job", reason: "section-unsupported", estimatedBytes: 1000 },
  job_completed: {
    jobId: "job", outputToken: "output", filename: "clip.mp4", finalPath: "/safe/clip.mp4",
    byteSize: 1000, container: "mp4", extractorKey: "Generic", mediaId: "media",
    accuracy: "exact", actualStartMs: 0, actualDurationMs: 10_000,
  },
  job_failed: { jobId: "job", code: "FORMAT_UNAVAILABLE", message: "Unavailable", recoverable: true },
  job_cancelled: { jobId: "job" },
  tool_progress: { stage: "verifying", percentage: 50, detail: "Verifying tools" },
};

function schemaEnvelope(type: string, payload: Record<string, unknown>): unknown {
  return { protocolVersion: 1, requestId: `schema-${type}`, type, payload };
}

describe("companion protocol", () => {
  it("validates every checked-in golden envelope against the canonical schema", () => {
    for (const name of ["hello.json", "probe-result.json", "job-progress.json"]) {
      expect(validateSchema(fixture(name)), `${name}: ${JSON.stringify(validateSchema.errors)}`).toBe(true);
    }
  });

  it("schema-validates every v1 request and event payload and closes each object", () => {
    expect(Object.keys(validByType)).toHaveLength(19);
    for (const [type, payload] of Object.entries(validByType)) {
      expect(validateSchema(schemaEnvelope(type, payload)), `${type}: ${JSON.stringify(validateSchema.errors)}`).toBe(true);
      expect(validateSchema(schemaEnvelope(type, { ...payload, unexpected: true })), `${type} accepted an extra field`).toBe(false);
    }
  });

  it("accepts shared request and event fixtures", () => {
    expect(validateCompanionRequest(fixture("hello.json"))).toBe(true);
    expect(validateCompanionEvent(fixture("probe-result.json"))).toBe(true);
    expect(validateCompanionEvent(fixture("job-progress.json"))).toBe(true);
  });

  it("rejects wrong versions, unknown messages, and non-object payloads", () => {
    expect(validateCompanionRequest({ ...fixture("hello.json") as object, protocolVersion: 2 })).toBe(false);
    expect(validateCompanionRequest(createCompanionEnvelope("run_command", "bad", {}))).toBe(false);
    expect(isCompanionEnvelope({ protocolVersion: 1, requestId: "x", type: "hello", payload: "bad" })).toBe(false);
    expect(isCompanionEnvelope({ protocolVersion: 1, requestId: "bad.id", type: "hello", payload: {} })).toBe(false);
    expect(validateSchema({ protocolVersion: 1, requestId: "bad id", type: "install_tools", payload: {} })).toBe(false);
  });

  it("rejects raw probe fields and malformed progress instead of trusting the host", () => {
    const probe = fixture("probe-result.json") as { payload: Record<string, unknown> };
    expect(validateCompanionEvent({ ...probe, payload: { ...probe.payload, formats: [{ url: "https://signed.invalid" }] } })).toBe(false);
    const progress = fixture("job-progress.json") as { payload: Record<string, unknown> };
    expect(validateCompanionEvent({ ...progress, payload: { ...progress.payload, percentage: 101 } })).toBe(false);
    expect(validateCompanionEvent(schemaEnvelope("job_completed", {
      ...validByType.job_completed, durationMs: 10.5,
    }))).toBe(false);
    expect(validateSchema(schemaEnvelope("job_completed", {
      ...validByType.job_completed, durationMs: 10.5,
    }))).toBe(false);
  });

  it("rejects request-side arbitrary arguments, paths, and selection extras", () => {
    const download = createCompanionEnvelope("start_download", "download-1", {
      jobId: "job-1", probeToken: "opaque", selectionKey: "best", auth: { mode: "anonymous" },
      args: ["--exec", "anything"], outputPath: "/tmp/escape",
    });
    expect(validateCompanionRequest(download)).toBe(false);
  });

  it("enforces the 256 KiB transport boundary", () => {
    const oversized = {
      protocolVersion: 1,
      requestId: "large",
      type: "probe_result",
      payload: { title: "x".repeat(COMPANION_MAX_MESSAGE_BYTES) },
    };
    expect(isCompanionEnvelope(oversized)).toBe(false);
  });

  it("creates bounded versioned envelopes", () => {
    expect(createCompanionEnvelope("hello", "request-1", { extensionVersion: "1.0.0" })).toEqual({
      protocolVersion: 1,
      requestId: "request-1",
      type: "hello",
      payload: { extensionVersion: "1.0.0" },
    });
    expect(() => createCompanionEnvelope("hello", "x".repeat(129), {})).toThrow();
  });
});
