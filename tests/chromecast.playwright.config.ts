import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './chromecast',
  testMatch: '**/*.test.ts',
  workers: 1,
  reporter: 'list',
  outputDir: '../test-results/chromecast',
});
