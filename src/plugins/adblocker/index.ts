import { t } from '@/i18n';
import { createBlockerBackend } from '@/providers/blocker-backend';
import { createBlockerPreload } from '@/providers/blocker-preload';
import { createPlugin } from '@/utils';

import { createAdblockerRenderer } from './renderer';
import { blockers, type AdblockerConfig } from './types';

const sources = [
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/filters.txt',
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/quick-fixes.txt',
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/unbreak.txt',
];

const reloadNotice = () =>
  t('plugins.adblocker.reload-notice', {
    defaultValue:
      'Changes to With blocklists reload the player page and may interrupt playback.',
  });

export default createPlugin({
  name: () => t('plugins.adblocker.name', { defaultValue: 'Ad Blocker' }),
  description: () =>
    `${t('plugins.adblocker.description', {
      defaultValue:
        'Block advertisements using player responses, filter lists, or ad speedup.',
    })} ${reloadNotice()}`,
  restartNeeded: false,
  config: {
    enabled: true,
    cache: true,
    blocker: blockers.InPlayer,
    additionalBlockLists: [],
    disableDefaultLists: false,
  } as AdblockerConfig,
  menu: async ({ getConfig, setConfig }) => {
    const config = await getConfig();
    return [
      {
        label: t('plugins.adblocker.menu.blocker', { defaultValue: 'Blocker' }),
        submenu: [
          ...Object.values(blockers).map((blocker) => ({
            label: blocker,
            type: 'radio' as const,
            checked: config.blocker === blocker,
            click: async () => {
              await setConfig({ blocker });
            },
          })),
          { type: 'separator' as const },
          { label: reloadNotice(), enabled: false },
        ],
      },
    ];
  },
  backend: createBlockerBackend('adblocker', () => Promise.resolve(sources)),
  preload: createBlockerPreload('adblocker'),
  renderer: createAdblockerRenderer(),
});
