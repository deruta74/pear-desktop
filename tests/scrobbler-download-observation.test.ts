import { test, expect } from '@playwright/test';
import { scrobblerAuthNative } from './helpers/scrobbler-auth-native';

/** Diagnostic evidence only: the original 100ms acceptance test remains unchanged. */
test('diagnostic only native download guard and owned file lifecycle around original100ms observation', async ({}, testInfo) => {
  const fixture = await scrobblerAuthNative({ observeDownloads: true });
  try {
    const result = await fixture.evaluate(async ({ BrowserWindow }) => {
      const f = (globalThis as any).AuthWindowFixture;
      const observation = f.downloadObservation;
      const surface = f.openScrobblingAuthWindow(
        f.main,
        'https://www.last.fm/api/auth/?token=owned',
        new AbortController().signal,
      );
      let surfaceClosed = false;
      surface.closed.then(() => {
        surfaceClosed = true;
        observation.mark('surface-closed-promise');
      });
      await surface.ready;
      const auth = BrowserWindow.getAllWindows().find(
        (win) => win.getParentWindow() === f.main,
      )!;
      const ownedSession = auth.webContents.session;
      observation.snapshot('surface-ready', ownedSession);
      // Keep the original link-popup, permission and navigation behavior exactly.
      const answer = f.handlers.get(auth.webContents.id)({
        url: 'https://sso.fixture.invalid/link',
        referrer: { url: 'https://www.last.fm', policy: 'default' },
      });
      const contents = answer.createWindow({
        show: true,
        alwaysOnTop: true,
        kiosk: true,
        fullscreen: true,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          preload: '/owned-unused-fixture',
        },
      });
      const child = BrowserWindow.fromWebContents(contents)!;
      for (let i = 0; i < 100 && contents.isLoading(); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const preferences = contents.getLastWebPreferences();
      const desktop = {
        top: child.isAlwaysOnTop(),
        kiosk: child.isKiosk(),
        fullscreen: child.isFullScreen(),
      };
      let permission: boolean | undefined;
      f.permissions.get(ownedSession)(
        auth.webContents,
        'media',
        (value: boolean) => (permission = value),
        {},
      );
      const permissionCheck = f.permissionChecks.get(ownedSession)(
        auth.webContents,
        'openExternal',
        'https://www.last.fm',
        {},
      );
      observation.snapshot('before-original-navigation', ownedSession);
      await auth.webContents.executeJavaScript(
        "location.href='https://www.last.fm/download';void 0",
      );
      observation.mark('original-navigation-script-return');
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Literal original call, no suffix filter or deletion. Names never leave this owned fixture.
      const originalFiles = f.downloadFiles();
      const original100ms = observation.snapshot(
        'original100ms-snapshot',
        ownedSession,
      );
      const sourceClosedAt100ms = surfaceClosed;
      surface.close();
      observation.mark('original-explicit-surface-close');
      await surface.closed;
      observation.snapshot('after-original-surface-closed', ownedSession);
      // Separate bounded observations, not a replacement/extension of the original100ms gate.
      for (const interval of [25, 75, 150, 250]) {
        await new Promise((resolve) => setTimeout(resolve, interval));
        observation.snapshot('later-observation', ownedSession);
      }
      const stages = observation.stages();
      const before = stages.filter(
        (stage: any) => stage.stage === 'will-download-before-guard',
      );
      const after = stages.filter(
        (stage: any) => stage.stage === 'will-download-after-emission',
      );
      const last = stages.at(-1);
      const guardObserved =
        before.length > 0 &&
        before.every((stage: any) => stage.activeGuardIds.length === 1);
      const prevented =
        after.length > 0 &&
        after.every((stage: any) => stage.prevented === true);
      const itemCancelledOrRemoved =
        after.length > 0 &&
        after.every(
          (stage: any) =>
            stage.item.state === 'cancelled' ||
            stage.item.stateUnavailable === true,
        );
      const originalEmpty = originalFiles.length === 0;
      const laterEmpty =
        last.physical.entries === 0 && last.physical.bytes === 0;
      const classification = !before.length
        ? 'no-native-download-event-observed'
        : !guardObserved
          ? 'guard-absent-or-ambiguous-at-native-event'
          : !prevented
            ? 'native-event-not-prevented'
            : !originalEmpty && laterEmpty
              ? original100ms.physical.tmpFiles > 0
                ? 'native-tmp-file-after-prevented-event-later-absent'
                : 'owned-file-after-prevented-event-later-absent'
              : !originalEmpty
                ? 'owned-file-still-present-at-last-observation'
                : 'original100ms-empty-after-prevented-native-event';
      return {
        diagnosticOnly: true,
        environment: {
          platform: process.platform,
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
        },
        security: {
          desktop,
          node: preferences.nodeIntegration,
          isolation: preferences.contextIsolation,
          sandbox: preferences.sandbox,
          preload: preferences.preload ?? '',
          permission,
          permissionCheck,
          permissionsRemoved:
            f.permissions.get(ownedSession) === null &&
            f.permissionChecks.get(ownedSession) === null,
        },
        original100ms: {
          originalDownloadFilesCount: originalFiles.length,
          originalAssertionWouldPass: originalEmpty,
          surfaceClosed: sourceClosedAt100ms,
          snapshot: original100ms,
        },
        guardObserved,
        prevented,
        guardCallEvidence:
          'passive inference only; production listener registration untouched',
        itemCancelledOrRemoved,
        laterEmpty,
        classification,
        stages: stages.map((stage: any) => ({
          ...stage,
          elapsedMs: stage.time - original100ms.time,
        })),
      };
    });
    const summary = JSON.stringify(result);
    console.log('SCROBBLER_DOWNLOAD_DIAGNOSTIC ' + summary);
    await testInfo.attach('owned-download-lifecycle.json', {
      body: summary,
      contentType: 'application/json',
    });
    expect(result.diagnosticOnly).toBe(true);
    expect(result.security).toEqual({
      desktop: { top: false, kiosk: false, fullscreen: false },
      node: false,
      isolation: true,
      sandbox: true,
      preload: '',
      permission: false,
      permissionCheck: false,
      permissionsRemoved: true,
    });
    expect(
      result.stages.some(
        (stage: any) => stage.stage === 'original100ms-snapshot',
      ),
    ).toBe(true);
    expect(
      result.stages.filter((stage: any) => stage.stage === 'later-observation'),
    ).toHaveLength(4);
    // No later-empty assertion accepts or repairs the original Windows failure.
  } finally {
    await fixture.close();
  }
});
