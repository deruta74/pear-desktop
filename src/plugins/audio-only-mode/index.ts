import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { createAudioOnlyController } from './controller';

export default createPlugin({
  name: () => t('plugins.audio-only-mode.name'),
  description: () => t('plugins.audio-only-mode.description'),
  restartNeeded: false,
  config: { enabled: false },
  renderer: {
    generation: 0,
    dispose: undefined as (() => void) | undefined,
    async onPlayerApiReady(player, { getConfig }) {
      const generation = ++this.generation;
      this.dispose?.();
      this.dispose = undefined;
      const config = await getConfig();
      if (generation !== this.generation || !config.enabled) return;
      const controller = createAudioOnlyController(
        player,
        document,
        () => generation === this.generation,
      );
      if (generation !== this.generation) controller.dispose();
      else this.dispose = controller.dispose;
    },
    onConfigChange(config) {
      if (!config.enabled) {
        ++this.generation;
        this.dispose?.();
        this.dispose = undefined;
      }
    },
    stop() {
      ++this.generation;
      this.dispose?.();
      this.dispose = undefined;
    },
  },
});
