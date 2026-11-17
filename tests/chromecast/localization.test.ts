import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';
import i18next from 'i18next';

for (const language of ['en', 'ru']) {
  test(`Cast localized labels resolve at plugins.chromecast in ${language}`, async () => {
    const translation = JSON.parse(
      await readFile(
        new URL(`../../src/i18n/resources/${language}.json`, import.meta.url),
        'utf8',
      ),
    );
    const instance = i18next.createInstance();
    await instance.init({
      lng: language,
      resources: { [language]: { translation } },
    });
    expect(instance.t('plugins.chromecast.name')).toBe('Google Cast');
    for (const key of [
      'description',
      'menu.auto-cast-on-startup',
      'dialog.no-devices.message',
      'dialog.stop.message',
    ]) {
      const path = `plugins.chromecast.${key}`;
      expect(instance.t(path)).not.toBe(path);
    }
  });
}
