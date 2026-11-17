import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { startPlaylistSearch, startPlaylistNameSearch } from './controller';
import style from './style.css?inline';

export default createPlugin<unknown, unknown, { release?: () => void }>({
  name: () => t('plugins.playlist-search.name'),
  description: () => t('plugins.playlist-search.description'),
  authors: ['donovan-yohan', 'ekloff'],
  restartNeeded: false,
  config: { enabled: false },
  stylesheets: [style],
  renderer: {
    start() {
      this.release?.();
      const collection = startPlaylistSearch(document, {
        label: t('plugins.playlist-search.label'),
        placeholder: t('plugins.playlist-search.placeholder'),
        clear: t('plugins.playlist-search.clear'),
        results: (matches, total) =>
          t('plugins.playlist-search.results', { matches, total }),
      });
      const names = startPlaylistNameSearch(document, {
        label: t('plugins.playlist-search.names-label'),
        placeholder: t('plugins.playlist-search.names-placeholder'),
        clear: t('plugins.playlist-search.clear'),
        results: (matches, total) =>
          t('plugins.playlist-search.names-results', { matches, total }),
      });
      this.release = () => {
        names();
        collection();
      };
    },
    stop() {
      this.release?.();
      this.release = undefined;
    },
  },
});
