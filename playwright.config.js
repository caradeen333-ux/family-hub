// playwright.config.js — E2E harness. Serves the built site/ and runs the
// mocked-endpoint suites. @real tests are excluded here; they run locally
// against dedicated test Google accounts.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  testIgnore: /.*@real.*/,
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 420, height: 780 },
  },
  webServer: {
    command: 'node scripts/serve-site.js',
    port: 4173,
    reuseExistingServer: true,
    stdout: 'ignore',
  },
});
