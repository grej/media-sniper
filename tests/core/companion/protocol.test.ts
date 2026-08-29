import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

describe("companion protocol", () => {
  it("accepts shared request and event fixtures", () => {
    expect(validateCompanionRequest(fixture("hello.json"))).toBe(true);
    expect(validateCompanionEvent(fixture("probe-result.json"))).toBe(true);
    expect(validateCompanionEvent(fixture("job-progress.json"))).toBe(true);
  });

  it("rejects wrong versions, unknown messages, and non-object payloads", () => {
    expect(validateCompanionRequest({ ...fixture("hello.json") as object, protocolVersion: 2 })).toBe(false);
    expect(validateCompanionRequest(createCompanionEnvelope("run_command", "bad", {}))).toBe(false);
    expect(isCompanionEnvelope({ protocolVersion: 1, requestId: "x", type: "hello", payload: "bad" })).toBe(false);
  });

  it("rejects raw probe fields and malformed progress instead of trusting the host", () => {
    const probe = fixture("probe-result.json") as { payload: Record<string, unknown> };
    expect(validateCompanionEvent({ ...probe, payload: { ...probe.payload, formats: [{ url: "https://signed.invalid" }] } })).toBe(false);
    const progress = fixture("job-progress.json") as { payload: Record<string, unknown> };
    expect(validateCompanionEvent({ ...progress, payload: { ...progress.payload, percentage: 101 } })).toBe(false);
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
