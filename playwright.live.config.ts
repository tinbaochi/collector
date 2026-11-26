import { defineConfig } from '@playwright/test';

/** Shared-review E2E: GitHub Pages build in live mode (fixture data) + local stand-in of the review worker. */
export default defineConfig({
  testDir: 'tests/ui-live',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5182/', locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', channel: process.env.CI ? undefined : 'msedge' },
  webServer: [
    { command: 'npx tsx scripts/fake-review-worker.ts', url: 'http://127.0.0.1:5181/health', reuseExistingServer: false, timeout: 60_000 },
    {
      command: 'npx tsx scripts/build-live-fixture.ts && npx vite build --mode pages && npx vite preview --mode pages --port 5182 --strictPort',
      url: 'http://127.0.0.1:5182/',
      env: { REVIEW_API_URL: 'http://127.0.0.1:5181' },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
