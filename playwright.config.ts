import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.WA_WEB_URL ?? 'http://127.0.0.1:5173',
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? 'chrome',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
