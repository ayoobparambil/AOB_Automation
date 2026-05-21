import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 300_000,
  expect: {
    timeout: 30_000,
  },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['./src/businessHtmlReporter.ts'],
  ],
  outputDir: 'test-results',
  use: {
    baseURL: process.env.AOB_BASE_URL ?? 'https://stage.bponline.dev',
    headless: process.env.CI ? true : false,
    launchOptions: {
      slowMo: Number(process.env.PLAYWRIGHT_SLOW_MO_MS ?? (process.env.CI ? 0 : 100)),
    },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
