import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectCurrentTabAuth, createCompanionJobState, validatePublicPageUrl } from "@/core/companion/service";
import { getDownload } from "@/core/database/downloads";

describe("companion page boundary", () => {
  it.each([
    "file:///tmp/source.mp4",
    "javascript:alert(1)",
    "data:text/plain,hello",
    "chrome://settings",
    "http://localhost/video",
    "http://player.localhost/video",
    "http://127.0.0.1/video",
    "http://127.8.9.10/video",
    "http://10.0.0.2/video",
    "http://172.16.2.3/video",
    "http://192.168.1.2/video",
    "http://169.254.1.1/video",
    "http://100.64.1.1/video",
    "http://198.18.1.1/video",
    "http://[fc00::1]/video",
    "http://[fe80::1]/video",
  ])("rejects %s", (url) => {
    expect(() => validatePublicPageUrl(url)).toThrow();
  });

  it("accepts public HTTP(S) URLs including option-looking paths", () => {
    expect(validatePublicPageUrl("https://example.test/--exec?token=secret").protocol).toBe("https:");
    expect(validatePublicPageUrl("http://example.test/watch").protocol).toBe("http:");
  });
});

describe("Brave current-tab session boundary", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      permissions: {
        contains: vi.fn(async () => true),
        request: vi.fn(async () => true),
      },
      cookies: {
        getAllCookieStores: vi.fn(async () => [
          { id: "profile-a", tabIds: [11] },
          { id: "profile-b", tabIds: [22] },
        ]),
        getAll: vi.fn(async () => [{
          name: "session", value: "ephemeral-secret", domain: ".example.test", path: "/",
          secure: true, httpOnly: true, sameSite: "lax", hostOnly: false, session: true,
        }]),
      },
    });
  });

  it("uses the active tab's exact cookie store and preserves private state", async () => {
    const auth = await collectCurrentTabAuth({ id: 22, url: "https://example.test/watch", incognito: true } as chrome.tabs.Tab);
    expect(auth).toMatchObject({ mode: "current-tab", cookieStoreId: "profile-b", incognito: true });
    expect(chrome.cookies.getAll).toHaveBeenCalledWith({ url: "https://example.test/watch", storeId: "profile-b" });
  });

  it("fails closed instead of flattening partitioned cookie scope", async () => {
    vi.mocked(chrome.cookies.getAll).mockResolvedValueOnce([{
      name: "partitioned", value: "secret", domain: ".example.test", path: "/", secure: true,
      httpOnly: true, sameSite: "no_restriction", hostOnly: false, session: true,
      partitionKey: { topLevelSite: "https://example.test" },
    } as chrome.cookies.Cookie]);
    await expect(collectCurrentTabAuth({ id: 11, url: "https://example.test/watch" } as chrome.tabs.Tab))
      .rejects.toMatchObject({ code: "AUTH_SCOPE_INSUFFICIENT" });
  });
});

describe("secret-free companion history", () => {
  it("stores source identity and receipt fields but never the probe token", async () => {
    const jobId = `history-${crypto.randomUUID()}`;
    await createCompanionJobState(jobId, {
      extractorKey: "Generic", mediaId: "media-1", webpageUrl: "https://example.test/watch",
      title: "Fixture", durationMs: 10_000, isLive: false, probeToken: "must-not-persist",
      probedAt: Date.now(), selections: [{ kind: "preset", key: "best", label: "Best" }],
    }, "best", "download");
    const state = await getDownload(jobId);
    expect(state?.operation?.backend).toBe("yt-dlp");
    expect(state?.metadata.source?.kind).toBe("yt-dlp");
    expect(JSON.stringify(state)).not.toContain("must-not-persist");
    expect(JSON.stringify(state)).not.toContain("cookies");
  });
});
