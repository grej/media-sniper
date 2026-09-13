import { describe, expect, it } from "vitest";
import {
  MAX_UPDATE_METADATA_BYTES,
  PENDING_UPDATE_TTL_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_SNOOZE_MS,
  compareStableSemver,
  createPendingPostUpdate,
  parseAnacondaPackageMetadata,
  parseStableSemver,
  shouldRunScheduledCheck,
  updateAlarmSchedule,
  updateIsVisible,
  validatePendingPostUpdate,
} from "../../../src/core/companion/update";

function metadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "media-sniper-installer",
    full_name: "gjennings/media-sniper-installer",
    owner: { login: "gjennings" },
    latest_version: "1.13.0",
    files: [{
      owner: "gjennings",
      version: "1.13.0",
      basename: "osx-arm64/media-sniper-installer-1.13.0-h123_0.conda",
      upload_time: "2026-08-29T12:00:00Z",
      labels: ["main"],
      attrs: {
        subdir: "osx-arm64",
      },
    }],
    ...overrides,
  });
}

describe("companion release updates", () => {
  it("compares only strict stable SemVer releases", () => {
    expect(parseStableSemver("1.13.0")).toEqual([1, 13, 0]);
    expect(parseStableSemver("1.13.0-rc.1")).toBeNull();
    expect(parseStableSemver("01.13.0")).toBeNull();
    expect(compareStableSemver("1.13.1", "1.13.0")).toBe(1);
    expect(compareStableSemver("1.13.0", "1.13.0")).toBe(0);
    expect(compareStableSemver("1.12.9", "1.13.0")).toBe(-1);
  });

  it("accepts only the fixed owner, package, main label, and Mac subdir", () => {
    expect(parseAnacondaPackageMetadata(metadata(), "osx-arm64")).toEqual({
      version: "1.13.0",
      publishedAt: "2026-08-29T12:00:00Z",
      subdir: "osx-arm64",
    });
    expect(() => parseAnacondaPackageMetadata(metadata({ name: "other" }), "osx-arm64"))
      .toThrow("identity");
    expect(() => parseAnacondaPackageMetadata(metadata(), "osx-64"))
      .toThrow("unavailable");
    const withoutMain = JSON.parse(metadata());
    withoutMain.files[0].labels = ["candidate"];
    expect(() => parseAnacondaPackageMetadata(JSON.stringify(withoutMain), "osx-arm64"))
      .toThrow("unavailable");
  });

  it("rejects oversized and malformed advisory responses", () => {
    expect(() => parseAnacondaPackageMetadata("x".repeat(MAX_UPDATE_METADATA_BYTES + 1), "osx-arm64"))
      .toThrow("too large");
    expect(() => parseAnacondaPackageMetadata("<html></html>", "osx-arm64"))
      .toThrow("valid JSON");
    expect(() => parseAnacondaPackageMetadata(metadata({ latest_version: "latest" }), "osx-arm64"))
      .toThrow("invalid release version");
  });

  it("throttles successful checks for 24 hours and jitters startup once", () => {
    const now = 1_000_000_000;
    expect(shouldRunScheduledCheck({}, now)).toBe(true);
    expect(shouldRunScheduledCheck({ lastSuccessfulCheckAt: now - UPDATE_CHECK_INTERVAL_MS + 1 }, now)).toBe(false);
    expect(shouldRunScheduledCheck({ lastSuccessfulCheckAt: now - UPDATE_CHECK_INTERVAL_MS }, now)).toBe(true);
    expect(updateAlarmSchedule(0)).toEqual({ delayInMinutes: 5, periodInMinutes: 1440 });
    expect(updateAlarmSchedule(1).delayInMinutes).toBeLessThan(30);
  });

  it("shows only upgrades and honors a seven-day version snooze", () => {
    const now = Date.now();
    expect(updateIsVisible({ latestVersion: "1.13.0" }, "1.12.0", now)).toBe(true);
    expect(updateIsVisible({ latestVersion: "1.13.0" }, "1.13.0", now)).toBe(false);
    expect(updateIsVisible({ latestVersion: "1.12.0" }, "1.13.0", now)).toBe(false);
    expect(updateIsVisible({
      latestVersion: "1.13.0",
      dismissedVersion: "1.13.0",
      snoozeUntil: now + UPDATE_SNOOZE_MS,
    }, "1.12.0", now)).toBe(false);
  });

  it("bounds and authenticates the one-tab post-update marker", () => {
    const now = Date.now();
    const marker = createPendingPostUpdate("1.13.0", 42, "https://example.com/watch#part", now);
    expect(marker.normalizedUrl).toBe("https://example.com/watch");
    expect(marker.expiresAt - marker.createdAt).toBe(PENDING_UPDATE_TTL_MS);
    expect(validatePendingPostUpdate(marker, "1.13.0", now + 1)).toBe(true);
    expect(validatePendingPostUpdate(marker, "1.12.0", now + 1)).toBe(false);
    expect(validatePendingPostUpdate(marker, "1.13.0", marker.expiresAt + 1)).toBe(false);
  });
});
