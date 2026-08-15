import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: "http://127.0.0.1:4175",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run test:e2e:serve",
    url: "http://127.0.0.1:4175/tests/e2e/fixtures/player.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
