import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import {
  clampSemitones,
  formatSemitones,
  MAX_SEMITONES,
  MIN_SEMITONES,
} from './constants';
import { createPitchRenderer } from './renderer';

export default createPlugin({
  name: () => t('plugins.pitch-shifter.name'),
  description: () => t('plugins.pitch-shifter.description'),
  authors: ['arielcorte'],
  restartNeeded: false,
  config: { enabled: false, semitones: 0 },
  menu: async ({ getConfig, setConfig }) => {
    const config = await getConfig();
    const steps = Array.from(
      { length: MAX_SEMITONES - MIN_SEMITONES + 1 },
      (_, i) => MAX_SEMITONES - i,
    );
    return [
      {
        label: t('plugins.pitch-shifter.menu.semitones'),
        submenu: steps.map((value) => ({
          label: formatSemitones(value),
          type: 'radio' as const,
          checked: clampSemitones(config.semitones) === value,
          click() {
            setConfig({ semitones: value });
          },
        })),
      },
      {
        label: t('plugins.pitch-shifter.menu.reset'),
        click() {
          setConfig({ semitones: 0 });
        },
      },
    ];
  },
  renderer: createPitchRenderer(),
});
