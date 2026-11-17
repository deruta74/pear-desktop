import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: [
    'crossfade-controller.test.ts',
    'crossfade-reverb-composition.test.ts',
    'crossfade-routing.test.ts',
    'crossfade-envelope.test.ts',
    'crossfade-stream.test.ts',
  ],
  workers: 1,
  reporter: 'list',
  outputDir: '../test-results/automix-regression',
  use: {
    headless: true,
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    },
  },
});
