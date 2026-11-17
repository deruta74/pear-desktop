import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './automix',
  testMatch: '**/*.test.ts',
  workers: 1,
  reporter: 'list',
  outputDir: '../test-results/automix',
  use: {
    headless: true,
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    },
  },
});
