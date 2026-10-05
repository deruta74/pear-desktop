import path from 'node:path';
import process from 'node:process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { test, expect, _electron as electron } from '@playwright/test';

process.env.NODE_ENV = 'test';

const appPath = path.resolve(import.meta.dirname, '..');

test('Pear Desktop App - With default settings, app is launched and visible', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'pear-desktop-test-'));
  const app = await electron.launch({
    cwd: appPath,
    args: [
      appPath,
      `--user-data-dir=${profile}`,
      '--no-sandbox',
      '--disable-gpu',
      '--whitelisted-ips=',
      '--disable-dev-shm-usage',
    ],
  });

  try {
    const actualProfile = await app.evaluate(({ app }) =>
      app.getPath('userData'),
    );
    expect(await realpath(actualProfile)).toBe(await realpath(profile));

    const window = await app.firstWindow();

    // First launch can show Google's regional consent page before Music.
    await expect
      .poll(() => window.url())
      .toMatch(/^https:\/\/(music|consent)\.youtube\.com(?:\/|$)/);
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((window) => window.isVisible()),
        ),
      )
      .toBe(true);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});
