import { t } from '@/i18n';
import { getPlaybackOwner } from '@/providers/playback-owner';
import {
  getCurrentAudioGraph,
  type RendererAudioGraph,
} from '@/providers/renderer-audio';
import { createRenderer } from '@/utils';

import { planAutoMix, type Analysis } from './analysis';
import {
  MAX_STREAM_BYTES,
  MAX_TRACK_SECONDS,
  type AutoMixConfig,
} from './config';
import { exclusiveMixAllowed } from './exclusive';
import { createAutoMixSampler } from './sampler';

import {
  crossfadeDefaults,
  type CrossfadePluginConfig,
} from '../crossfade/config';
import { createCrossfadeController } from '../crossfade/controller';
import { validCrossfadeStream, type StreamResult } from '../crossfade/stream';

import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

export const renderer = createRenderer<
  {
    generation: number;
    running: boolean;
    startAbort?: AbortController;
    bind?: () => void;
    detach?: () => void;
    graph?: RendererAudioGraph;
    boundApi?: MusicPlayer;
    config?: AutoMixConfig;
    ipc?: RendererContext<AutoMixConfig>['ipc'];
    dispose?: () => void;
    refresh?: () => void;
    lastPlan?: CrossfadePluginConfig;
    lastAnalysis?: Analysis;
  },
  AutoMixConfig
>({
  generation: 0,
  running: false,
  async start({ getConfig, ipc }) {
    this.running = false;
    this.startAbort?.abort();
    const owner = new AbortController();
    this.startAbort = owner;
    window.addEventListener('pagehide', () => owner.abort(), {
      once: true,
      signal: owner.signal,
    });
    this.detach?.();
    this.dispose?.();
    const generation = ++this.generation;
    const config = await getConfig();
    if (
      this.generation !== generation ||
      owner.signal.aborted ||
      config.enabled !== true
    )
      return;
    this.config = config;
    this.ipc = ipc;
    this.running = true;
    const ready = () => {
      if (this.generation === generation) this.bind?.();
    };
    const detach = () => {
      owner.abort();
      this.running = false;
      document.removeEventListener('peard:audio-can-play', ready);
      window.removeEventListener('pagehide', detach);
      this.dispose?.();
      this.bind = undefined;
      this.graph = undefined;
      this.boundApi = undefined;
      if (this.detach === detach) this.detach = undefined;
    };
    this.detach = detach;
    document.addEventListener('peard:audio-can-play', ready);
    window.addEventListener('pagehide', detach, { once: true });
  },
  stop() {
    this.startAbort?.abort();
    this.startAbort = undefined;
    this.running = false;
    this.generation++;
    this.detach?.();
    this.dispose?.();
    this.dispose = undefined;
    this.refresh = undefined;
    this.lastPlan = undefined;
    this.lastAnalysis = undefined;
  },
  onConfigChange(config) {
    this.config = config;
    this.refresh?.();
  },
  onPlayerApiReady(api) {
    if (!this.running) return;
    const bind = () => {
      if (!this.running) return;
      const main = document.querySelector('video'),
        graph = getCurrentAudioGraph();
      if (graph === this.graph && this.boundApi === api && this.dispose) return;
      this.dispose?.();
      if (!main || !graph || !this.config || !this.ipc) return;
      this.graph = graph;
      this.boundApi = api;
      const generation = this.generation;
      let stopped = false;
      const allowed = () =>
        !stopped &&
        generation === this.generation &&
        exclusiveMixAllowed(
          'automix',
          this.config?.enabled === true,
          window.mainConfig.get('plugins'),
        );
      const identity = () => {
        const id = api.getVideoData()?.video_id,
          binding = id && getPlaybackOwner(api)?.binding(id);
        return binding
          ? `${binding.documentId}:${binding.episodeId}:${main.currentSrc}`
          : '';
      };
      const sampler = createAutoMixSampler(main, graph, allowed, identity);
      const status = document.createElement('div');
      status.setAttribute('role', 'status');
      const controller = createCrossfadeController({
        mode: 'automix',
        api,
        main,
        graph,
        config: {
          ...crossfadeDefaults,
          enabled: true,
          fadeInDuration: 6000,
          fadeOutDuration: 6000,
          secondsBeforeEnd: 8,
        },
        isAllowed: allowed,
        plan: (state) => {
          if (!allowed() || !state.nextId || state.duration > MAX_TRACK_SECONDS)
            return null;
          const expected = `${state.binding.documentId}:${state.binding.episodeId}:${state.source}`;
          if (identity() !== expected) return null;
          this.lastAnalysis = sampler.analysis(expected);
          const plan = planAutoMix(this.lastAnalysis, this.config!);
          this.lastPlan = plan;
          return plan;
        },
        requestAudio: async (id) => {
          const stream = (await this.ipc!.invoke(
            'peard:automix:audio-url',
            id,
          )) as StreamResult | null;
          return allowed() &&
            validCrossfadeStream(stream) &&
            stream.contentLength <= MAX_STREAM_BYTES
            ? stream
            : null;
        },
        onUnavailable: () => {
          if (!allowed()) return;
          status.textContent = t('plugins.automix.unavailable');
          if (!status.isConnected) document.body.append(status);
        },
      });
      const refresh = () => {
        controller.rearm();
        sampler.refresh();
        if (!allowed()) {
          status.textContent = t('plugins.automix.conflict');
          if (!status.isConnected) document.body.append(status);
        } else status.remove();
      };
      this.refresh = refresh;
      const releaseConfig = this.ipc.subscribe?.(
        'config-changed',
        (id: unknown) => {
          if (id === 'crossfade' || id === 'automix') refresh();
        },
      );
      const releaseSpeed = this.ipc.subscribe?.(
        'peard:playback-speed-step',
        () => {
          controller.cancel();
          sampler.refresh();
        },
      );
      const abort = new AbortController();
      let releaseGraph: (() => void) | undefined;
      const dispose = () => {
        if (stopped) return;
        stopped = true;
        abort.abort();
        controller.dispose();
        sampler.dispose();
        status.remove();
        releaseConfig?.();
        releaseSpeed?.();
        releaseGraph?.();
        if (this.dispose === dispose) {
          this.dispose = undefined;
          this.refresh = undefined;
          this.graph = undefined;
          this.boundApi = undefined;
        }
      };
      this.dispose = dispose;
      window.addEventListener('pagehide', dispose, {
        once: true,
        signal: abort.signal,
      });
      releaseGraph = graph.observeRetirement(dispose);
      if (!allowed()) refresh();
    };
    this.bind = bind;
    bind();
  },
});
