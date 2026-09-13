import { expect, test, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const FIXTURE_PATH = "/tests/e2e/fixtures/player.html";
const PROXIED_FIXTURE_PATH = "/tests/e2e/fixtures/proxied-player.html";
const EXTENSION_NAME = "Media Sniper";

interface ExtensionHarness {
  context: BrowserContext;
  extensionId: string;
  fixturePage: Page;
  fixtureTabId: number;
  serviceWorker: Worker;
  userDataDir: string;
}

let harness: ExtensionHarness;

async function waitForServiceWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? context.waitForEvent("serviceworker");
}

async function queryFixtureTabId(serviceWorker: Worker, fixtureUrl: string): Promise<number> {
  const tabId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === url)?.id;
  }, fixtureUrl);
  if (tabId === undefined) throw new Error(`Could not find fixture tab for ${fixtureUrl}`);
  return tabId;
}

async function activateFixtureTab(): Promise<void> {
  await harness.serviceWorker.evaluate(async (tabId) => {
    await chrome.tabs.update(tabId, { active: true });
  }, harness.fixtureTabId);
}

async function detectedVideoCount(): Promise<number> {
  return detectedVideoCountForTab(harness.fixtureTabId);
}

async function detectedVideoCountForTab(tabId: number): Promise<number> {
  return harness.serviceWorker.evaluate(async (targetTabId) => {
    return new Promise<number>((resolveCount) => {
      chrome.tabs.sendMessage(targetTabId, { type: "GET_DETECTED_VIDEOS" }, (response) => {
        if (chrome.runtime.lastError) return resolveCount(0);
        resolveCount(Array.isArray(response?.videos) ? response.videos.length : 0);
      });
    });
  }, tabId);
}

async function detectedVideosForTab(tabId: number): Promise<Array<Record<string, unknown>>> {
  return harness.serviceWorker.evaluate(async (targetTabId) => {
    return new Promise<Array<Record<string, unknown>>>((resolveVideos) => {
      chrome.tabs.sendMessage(targetTabId, { type: "GET_DETECTED_VIDEOS" }, (response) => {
        if (chrome.runtime.lastError) return resolveVideos([]);
        resolveVideos(Array.isArray(response?.videos) ? response.videos : []);
      });
    });
  }, tabId);
}

async function openPopupPage(): Promise<Page> {
  const popup = await harness.context.newPage();
  await popup.setViewportSize({ width: 400, height: 480 });
  await popup.goto(`chrome-extension://${harness.extensionId}/popup/popup.html`);
  await activateFixtureTab();
  await popup.reload();
  await expect(popup.locator(".header-title")).toHaveText(EXTENSION_NAME);
  return popup;
}

async function openClipEditor(popup: Page): Promise<void> {
  await expect(popup.locator(".video-btn-clip")).toHaveCount(1);
  await popup.locator(".video-btn-clip").click();
  await expect(popup.locator(".clip-editor")).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ baseURL }) => {
  const userDataDir = await mkdtemp(resolve(tmpdir(), "media-sniper-e2e-"));
  const extensionPath = resolve(process.cwd(), "dist");
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  const serviceWorker = await waitForServiceWorker(context);
  const extensionId = new URL(serviceWorker.url()).host;
  const fixturePage = await context.newPage();
  const fixtureUrl = new URL(FIXTURE_PATH, baseURL).href;
  await fixturePage.goto(fixtureUrl);
  await fixturePage.locator("#fixture-video").evaluate(async (video: HTMLVideoElement) => {
    if (video.readyState === 0) {
      await new Promise<void>((resolveLoaded) => {
        video.addEventListener("loadedmetadata", () => resolveLoaded(), { once: true });
      });
    }
    video.currentTime = Math.min(1.234, Math.max(0, video.duration - 0.1));
  });
  const fixtureTabId = await queryFixtureTabId(serviceWorker, fixtureUrl);
  harness = { context, extensionId, fixturePage, fixtureTabId, serviceWorker, userDataDir };
  await activateFixtureTab();
  await expect.poll(detectedVideoCount).toBeGreaterThan(0);
});

test.afterAll(async () => {
  if (!harness) return;
  await harness.context.close();
  await rm(harness.userDataDir, { recursive: true, force: true });
});

test("starts as the unpacked Media Sniper MV3 extension", async () => {
  expect(harness.serviceWorker.url()).toBe(
    `chrome-extension://${harness.extensionId}/background.js`,
  );
  const identity = await harness.serviceWorker.evaluate(() => {
    const manifest = chrome.runtime.getManifest();
    return {
      id: chrome.runtime.id,
      manifestVersion: manifest.manifest_version,
      name: manifest.name,
      version: manifest.version,
    };
  });
  expect(identity).toEqual({
    id: harness.extensionId,
    manifestVersion: 3,
    name: EXTENSION_NAME,
    version: JSON.parse(await readFile(new URL("../../manifest.json", import.meta.url), "utf8")).version,
  });
});

test("detects a delayed tokenized MP4 through a 302 to a PHP 206 proxy", async ({ baseURL }) => {
  const page = await harness.context.newPage();
  const loggedMessages: string[] = [];
  const capturePageLog = (message: { text(): string }) => loggedMessages.push(message.text());
  const captureWorkerLog = (message: { text(): string }) => loggedMessages.push(message.text());
  page.on("console", capturePageLog);
  harness.serviceWorker.on("console", captureWorkerLog);
  const fixtureUrl = new URL(PROXIED_FIXTURE_PATH, baseURL).href;
  await page.goto(fixtureUrl);
  const tabId = await queryFixtureTabId(harness.serviceWorker, fixtureUrl);

  await expect.poll(async () => {
    const [video] = await detectedVideosForTab(tabId);
    return {
      sourceUrl: video?.sourceUrl,
      redirectCount: Array.isArray(video?.redirectChain) ? video.redirectChain.length : 0,
    };
  }).toEqual({
    sourceUrl: expect.stringContaining("something_720p.mp4?v-acctoken="),
    redirectCount: 2,
  });
  const videos = await detectedVideosForTab(tabId);
  expect(videos).toHaveLength(1);
  expect(videos[0]).toMatchObject({
    format: "direct",
    contentType: "video/mp4",
    sourceUrl: expect.stringContaining("something_720p.mp4?v-acctoken="),
    url: expect.stringContaining("remote_control.php?file="),
  });
  expect(videos[0].redirectChain).toEqual([
    expect.stringContaining("something_720p.mp4?v-acctoken="),
    expect.stringContaining("remote_control.php?file="),
  ]);
  expect(videos.every((video) => !String(video.url).includes(".mp4.jpg"))).toBe(true);
  expect(loggedMessages.join("\n")).not.toContain("e2e-secret");
  page.off("console", capturePageLog);
  harness.serviceWorker.off("console", captureWorkerLog);
  await page.close();
});

test("recovers protected media requested before document_idle", async ({ baseURL }) => {
  const page = await harness.context.newPage();
  const fixtureUrl = new URL(`${PROXIED_FIXTURE_PATH}?early=1`, baseURL).href;
  await page.goto(fixtureUrl);
  const tabId = await queryFixtureTabId(harness.serviceWorker, fixtureUrl);

  await expect.poll(() => detectedVideoCountForTab(tabId)).toBeGreaterThan(0);
  const videos = await detectedVideosForTab(tabId);
  expect(videos).toHaveLength(1);
  expect(videos[0]).toMatchObject({
    contentType: "video/mp4",
    url: expect.stringContaining("remote_control.php?file="),
  });
  await page.close();
});

test("defaults clip timestamps to clock format and toggles to seconds", async () => {
  const popup = await openPopupPage();
  await openClipEditor(popup);

  const fields = popup.locator(".clip-time-input");
  await expect(fields.nth(0)).toHaveValue("00:00:00.000");
  await expect(fields.nth(1)).toHaveValue(/^00:00:\d{2}\.\d{3}$/);
  await expect(popup.locator(".clip-time-display-select")).toHaveValue("clock");

  await popup.locator(".clip-time-display-select").selectOption("seconds");
  await expect(fields.nth(0)).toHaveValue("0.000");
  await expect(fields.nth(1)).toHaveValue(/^\d+\.\d{3}$/);
  await popup.close();
});

test("stacks clip timestamps and keeps every editor control inside the popup", async () => {
  const popup = await openPopupPage();
  await openClipEditor(popup);

  const timeControls = popup.locator(".clip-time-control");
  const startBox = await timeControls.nth(0).boundingBox();
  const endBox = await timeControls.nth(1).boundingBox();
  expect(startBox).not.toBeNull();
  expect(endBox).not.toBeNull();
  expect(endBox!.y).toBeGreaterThanOrEqual(startBox!.y + startBox!.height);

  const layout = await popup.locator(".clip-editor").evaluate((editor) => {
    const editorRect = editor.getBoundingClientRect();
    const controls = [...editor.querySelectorAll<HTMLElement>("button, input, select")];
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      editorOverflow: editor.scrollWidth - editor.clientWidth,
      outOfBounds: controls
        .filter((control) => {
          const rect = control.getBoundingClientRect();
          return rect.left < editorRect.left - 0.5 || rect.right > editorRect.right + 0.5;
        })
        .map((control) => control.className),
    };
  });

  expect(layout.documentOverflow).toBeLessThanOrEqual(0);
  expect(layout.editorOverflow).toBeLessThanOrEqual(0);
  expect(layout.outOfBounds).toEqual([]);
  await popup.close();
});

test("restores a draft after the popup document is remounted", async () => {
  const popup = await openPopupPage();
  await openClipEditor(popup);
  const fields = popup.locator(".clip-time-input");
  await fields.nth(0).fill("00:00:01.111");
  await fields.nth(0).press("Tab");
  await fields.nth(1).fill("00:00:03.333");
  await fields.nth(1).press("Tab");
  await expect.poll(async () => {
    return harness.serviceWorker.evaluate(async () => {
      const storage = await chrome.storage.session.get(null);
      return Object.values(storage).some((value) => {
        const draft = value as { startMs?: number; endMs?: number } | undefined;
        return draft?.startMs === 1_111 && draft?.endMs === 3_333;
      });
    });
  }).toBe(true);
  await activateFixtureTab();
  await popup.reload();
  await expect(popup.locator(".header-title")).toHaveText(EXTENSION_NAME);
  await openClipEditor(popup);
  await expect(popup.locator(".clip-time-input").nth(0)).toHaveValue("00:00:01.111");
  await expect(popup.locator(".clip-time-input").nth(1)).toHaveValue("00:00:03.333");
  await popup.close();
});

test("keeps the page overlay off by default and follows enabled lifecycle", async () => {
  const overlay = harness.fixturePage.locator("[data-media-sniper-clip-overlay]");
  await expect(overlay).toHaveCount(0);

  await harness.serviceWorker.evaluate(async () => {
    const { storage_config: current } = await chrome.storage.local.get("storage_config");
    await chrome.storage.local.set({
      storage_config: {
        ...(current ?? {}),
        clipping: { ...(current?.clipping ?? {}), overlayEnabled: true },
      },
    });
  });
  await expect(overlay).toHaveCount(1);
  await expect(overlay.locator(".panel.visible")).toHaveCount(1);
  await expect(overlay.locator(".brand")).toHaveText(EXTENSION_NAME);
  await expect(overlay.locator(".time")).toHaveText(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);

  await harness.serviceWorker.evaluate(async () => {
    const { storage_config: current } = await chrome.storage.local.get("storage_config");
    await chrome.storage.local.set({
      storage_config: {
        ...(current ?? {}),
        clipping: { ...(current?.clipping ?? {}), overlayEnabled: false },
      },
    });
  });
  await expect(overlay).toHaveCount(0);
});
