// Experimental adaptation of upstream #4749 by @SurajBhari; see EXPERIMENT.md.
import { createPlugin } from '@/utils';

import { backend } from './backend';
import { autoMixDefaults } from './config';
import { renderer } from './renderer';

export default createPlugin({
  name: () => 'AutoMix (Beta experiment)',
  description: () =>
    'Beat and tonality informed overlaps. Disable Crossfade to try this beta.',
  authors: ['SurajBhari'],
  restartNeeded: true,
  config: autoMixDefaults,
  menu: async ({ getConfig, setConfig }) => {
    const config = await getConfig();
    return [
      {
        label: 'Experimental: no tempo stretching or incoming key matching',
        enabled: false,
      },
      ...([4, 8] as const).map((beats) => ({
        label: `${beats} beat overlap (maximum ${config.maxSeconds}s)`,
        type: 'radio' as const,
        checked: config.blendBeats === beats,
        click: () => {
          setConfig({ blendBeats: beats });
        },
      })),
    ];
  },
  backend,
  renderer,
});
