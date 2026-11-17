import {
  getCurrentAudioGraph,
  type RendererAudioGraph,
} from '@/providers/renderer-audio';

import { clampSemitones } from './constants';
import { createPitchController } from './controller';

export type PitchConfig = { enabled: boolean; semitones: number };
export function createPitchRenderer() {
  let generation = 0,
    revision = 0,
    started = false;
  let config: PitchConfig = { enabled: false, semitones: 0 };
  let graph: RendererAudioGraph | null = null,
    controller: ReturnType<typeof createPitchController> | null = null;
  let observer: MutationObserver | undefined,
    pending: Promise<boolean> = Promise.resolve(false);
  const matches = (next: RendererAudioGraph) =>
    getCurrentAudioGraph() === next &&
    next.audioContext.state !== 'closed' &&
    next.audioSource.mediaElement.isConnected &&
    document.querySelector('video') === next.audioSource.mediaElement;
  const clear = () => {
    const previous = controller;
    controller = null;
    graph = null;
    previous?.dispose();
  };
  const reconcile = () => {
    if (!started || !config.enabled) {
      clear();
      return;
    }
    const next = getCurrentAudioGraph();
    if (!next || !matches(next)) {
      clear();
      return;
    }
    if (graph === next && controller) {
      controller.setSemitones(config.semitones);
      return;
    }
    clear();
    graph = next;
    const epoch = generation;
    const current = () =>
      started &&
      config.enabled &&
      epoch === generation &&
      graph === next &&
      matches(next);
    const owned = createPitchController(next, config.semitones, current);
    if (!current()) {
      owned.dispose();
      return;
    }
    controller = owned;
    pending = owned.ready;
  };
  const onPageHide = () => stop();
  const stop = () => {
    started = false;
    generation++;
    revision++;
    clear();
    observer?.disconnect();
    observer = undefined;
    document.removeEventListener('peard:audio-can-play', reconcile);
    window.removeEventListener('pagehide', onPageHide);
  };
  return {
    async start({
      getConfig,
    }: {
      getConfig: () => PitchConfig | Promise<PitchConfig>;
    }) {
      stop();
      started = true;
      const epoch = generation,
        version = revision;
      document.addEventListener('peard:audio-can-play', reconcile);
      window.addEventListener('pagehide', onPageHide, { once: true });
      observer = new MutationObserver(reconcile);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      const next = await getConfig();
      if (!started || epoch !== generation || version !== revision) return;
      config = {
        enabled: next.enabled,
        semitones: clampSemitones(next.semitones),
      };
      reconcile();
    },
    onConfigChange(next: PitchConfig) {
      revision++;
      config = {
        enabled: next.enabled,
        semitones: clampSemitones(next.semitones),
      };
      reconcile();
    },
    onPlayerApiReady() {
      reconcile();
    },
    stop,
    settled() {
      return pending;
    },
  };
}
