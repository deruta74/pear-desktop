import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test, expect, _electron as electron } from '@playwright/test';

import {
  assertStartupFacts,
  refreshStartupFacts,
  waitForStartupFacts,
} from './helpers/electron-startup.js';

const observer = path.resolve(
  import.meta.dirname,
  'helpers/electron-startup-observer.cjs',
);

test.describe('test-only Electron startup observer', () => {
  /**
   * @param {{ wrongProfile?: boolean, visible?: boolean, preload?: boolean, exit?: boolean, delayedShow?: boolean }} options
   * @param {(fixture: { application: import('@playwright/test').ElectronApplication, child: import('node:child_process').ChildProcess, profile: string, factsPath: string, actionPath: string, actionDone: string }) => Promise<void>} check
   */
  async function withFixture(options, check) {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'pear-startup-observer-'),
    );
    const profile = path.join(directory, 'profile');
    const wrongProfile = path.join(directory, 'wrong-profile');
    const factsPath = path.join(directory, 'facts.json');
    const actionPath = path.join(directory, 'action.txt');
    const actionDone = path.join(directory, 'action-done.json');
    let application;
    let child;
    try {
      await mkdir(profile);
      await mkdir(wrongProfile);
      const entry = path.join(directory, 'main.cjs');
      await writeFile(
        entry,
        `
        const { app, BrowserWindow } = require('electron');
        const fs = require('node:fs');
        const ownedWindows = [];
        app.on('browser-window-created', (_event, nativeWindow) => ownedWindows.push(nativeWindow));
        if (${Boolean(options.wrongProfile)}) app.setPath('userData', ${JSON.stringify(wrongProfile)});
        app.whenReady().then(() => {
          const window = new BrowserWindow({ show: ${options.visible !== false && !options.delayedShow}, width: 320, height: 240 });
          window.loadURL('data:text/html,<title>Owned startup fixture</title>');
          fs.watchFile(${JSON.stringify(actionPath)}, { interval: 20 }, (current) => {
            if (!current.nlink) return;
            fs.unwatchFile(${JSON.stringify(actionPath)});
            const action = fs.readFileSync(${JSON.stringify(actionPath)}, 'utf8');
            const publishState = () => {
              const state = { closed: window.isDestroyed(), visible: !window.isDestroyed() && window.isVisible() };
              fs.writeFileSync(${JSON.stringify(actionDone)} + '.tmp', JSON.stringify(state));
              fs.renameSync(${JSON.stringify(actionDone)} + '.tmp', ${JSON.stringify(actionDone)});
            };
            if (action === 'hide') { window.hide(); publishState(); }
            else if (action === 'close') {
              new BrowserWindow({ show: false, width: 160, height: 120 });
              window.once('closed', publishState);
              window.close();
            }
            else throw new Error('Unknown owned fixture action');
          });
          ${options.delayedShow ? 'setTimeout(() => window.show(), 50);' : ''}
          ${options.exit ? 'setTimeout(() => app.exit(23), 500);' : ''}
        });
      `,
      );
      application = await electron.launch({
        args: [
          ...(options.preload === false ? [] : ['--require', observer]),
          entry,
          `--user-data-dir=${profile}`,
          '--no-sandbox',
          '--disable-gpu',
        ],
        env: { ...process.env, PEAR_TEST_STARTUP_FACTS: factsPath },
      });
      child = application.process();
      await application.firstWindow();
      await check({
        application,
        child,
        profile,
        factsPath,
        actionPath,
        actionDone,
      });
    } finally {
      try {
        if (
          application &&
          child?.exitCode === null &&
          child.signalCode === null
        )
          await application.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }

  test('captures the actual isolated profile and native visible window', async () => {
    await withFixture({}, async ({ child, profile, factsPath }) => {
      const facts = await waitForStartupFacts(child, factsPath, 2000);
      await assertStartupFacts(child, facts, profile);
      expect(facts.pid).toBe(child.pid);
      expect(facts.visibleWindow).toBe(true);
    });
  });

  test('missing preload facts remain a failure despite a real visible window', async () => {
    await withFixture({ preload: false }, async ({ child, factsPath }) => {
      await expect(waitForStartupFacts(child, factsPath, 200)).rejects.toThrow(
        /No startup facts/,
      );
    });
  });

  test('observes a window shown after app ready and window creation', async () => {
    await withFixture(
      { delayedShow: true },
      async ({ child, profile, factsPath }) => {
        const facts = await waitForStartupFacts(child, factsPath, 2000);
        await assertStartupFacts(child, facts, profile);
      },
    );
  });

  test('foreign process and false visibility facts remain failures', async () => {
    await withFixture({}, async ({ child, profile, factsPath }) => {
      const facts = await waitForStartupFacts(child, factsPath, 2000);
      await expect(
        assertStartupFacts(child, { ...facts, pid: -1 }, profile),
      ).rejects.toThrow(/different process/);
      await expect(
        assertStartupFacts(child, { ...facts, visibleWindow: false }, profile),
      ).rejects.toThrow(/visible window/);
    });
  });

  test('a hidden native window cannot satisfy startup visibility', async () => {
    await withFixture({ visible: false }, async ({ child, factsPath }) => {
      await expect(waitForStartupFacts(child, factsPath, 200)).rejects.toThrow(
        /No startup facts/,
      );
    });
  });

  test('the wrong real userData path remains a failure', async () => {
    await withFixture(
      { wrongProfile: true },
      async ({ child, profile, factsPath }) => {
        const facts = await waitForStartupFacts(child, factsPath, 2000);
        await expect(assertStartupFacts(child, facts, profile)).rejects.toThrow(
          /userData/,
        );
      },
    );
  });

  test('a genuine main-process exit remains a failure with its actual code', async () => {
    await withFixture(
      { visible: false, exit: true },
      async ({ child, factsPath }) => {
        await expect(
          waitForStartupFacts(child, factsPath, 2000),
        ).rejects.toThrow(/exited.*23/);
        expect(child.exitCode).toBe(23);
      },
    );
  });

  test('abrupt process termination remains a failure and permits owned cleanup', async () => {
    await withFixture({ visible: false }, async ({ child, factsPath }) => {
      child.kill('SIGKILL');
      await expect(waitForStartupFacts(child, factsPath, 2000)).rejects.toThrow(
        /exited/,
      );
    });
  });

  test('malformed facts fail immediately instead of being retried as readiness', async () => {
    await withFixture({ preload: false }, async ({ child, factsPath }) => {
      await writeFile(factsPath, '{');
      await expect(waitForStartupFacts(child, factsPath, 2000)).rejects.toThrow(
        SyntaxError,
      );
    });
  });

  test('stale facts cannot satisfy refresh when the observer is absent', async () => {
    await withFixture(
      { preload: false },
      async ({ child, profile, factsPath }) => {
        await writeFile(
          factsPath,
          JSON.stringify({
            pid: child.pid,
            userData: profile,
            visibleWindow: true,
          }),
        );
        await expect(
          refreshStartupFacts(child, factsPath, 200),
        ).rejects.toThrow(/No refreshed startup facts acknowledgement/);
      },
    );
  });

  for (const action of ['close', 'hide']) {
    test(`a window that ${action}s after initial facts cannot retain valid visibility`, async () => {
      await withFixture(
        {},
        async ({
          application,
          child,
          profile,
          factsPath,
          actionPath,
          actionDone,
        }) => {
          const page = await application.firstWindow();
          const initial = await waitForStartupFacts(child, factsPath, 2000);
          await assertStartupFacts(child, initial, profile);
          await writeFile(actionPath, action);
          await expect
            .poll(async () => {
              try {
                return await readFile(actionDone, 'utf8');
              } catch (error) {
                if (
                  !(error instanceof Error) ||
                  !('code' in error) ||
                  error.code !== 'ENOENT'
                )
                  throw error;
                return '';
              }
            })
            .toBe(
              action === 'close'
                ? '{"closed":true,"visible":false}'
                : '{"closed":false,"visible":false}',
            );
          await expect.poll(() => page.isClosed()).toBe(action === 'close');
          expect(child.exitCode).toBeNull();
          const current = await refreshStartupFacts(child, factsPath, 2000);
          await expect(
            assertStartupFacts(child, current, profile),
          ).rejects.toThrow(/visible window/);
        },
      );
    });
  }
});
