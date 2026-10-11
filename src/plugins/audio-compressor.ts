import { t } from '@/i18n';
import {
  getCurrentAudioGraph,
  graphFromAnnouncement,
  type RendererAudioGraph,
} from '@/providers/renderer-audio';
import { createPlugin } from '@/utils';

let graph: RendererAudioGraph | null = null;
let compressor: DynamicsCompressorNode | null = null;
let release: (() => void) | null = null;

function detach() {
  release?.();
  release = null;
  compressor?.disconnect();
  compressor = null;
  graph = null;
}
function attach(next: RendererAudioGraph | null) {
  if (!next || next === graph) return;
  detach();
  const node = next.audioContext.createDynamicsCompressor();
  node.threshold.value = -50;
  node.ratio.value = 12;
  node.knee.value = 40;
  node.attack.value = 0;
  node.release.value = 0.25;
  try {
    release = next.insertDry(node, node);
    graph = next;
    compressor = node;
  } catch (error) {
    node.disconnect();
    console.error('[audio-compressor] Could not attach dry insert', error);
  }
}
const handler = ({ detail }: CustomEvent<Compressor>) =>
  attach(graphFromAnnouncement(detail));

export default createPlugin({
  name: () => t('plugins.audio-compressor.name'),
  description: () => t('plugins.audio-compressor.description'),
  renderer: {
    onPlayerApiReady() {
      attach(getCurrentAudioGraph());
    },
    start() {
      document.addEventListener('peard:audio-can-play', handler, {
        passive: true,
      });
      attach(getCurrentAudioGraph());
    },
    stop() {
      document.removeEventListener('peard:audio-can-play', handler);
      detach();
    },
  },
});
