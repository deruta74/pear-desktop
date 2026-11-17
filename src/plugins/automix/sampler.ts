import {
  getCurrentAudioGraph,
  type RendererAudioGraph,
} from '@/providers/renderer-audio';

import { analyseFrames, FPS, MAX_FRAMES, type Frame } from './analysis';

/** Raw-source tap only: no processor/output edge, no fetch, no decoder or retained PCM. */
export function createAutoMixSampler(
  main: HTMLVideoElement,
  graph: RendererAudioGraph,
  allowed: () => boolean,
  identity: () => string = () => main.currentSrc,
) {
  const analyser = graph.audioContext.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  const waveform = new Float32Array(analyser.fftSize),
    spectrum = new Float32Array(analyser.frequencyBinCount);
  const classes = Int8Array.from({ length: spectrum.length }, (_, bin) => {
    const hz = (bin * graph.audioContext.sampleRate) / analyser.fftSize;
    if (hz < 110 || hz > 2000) return -1;
    const semitones = 12 * Math.log2(hz / 440);
    const midi = Math.round(semitones + 69);
    return ((midi % 12) + 12) % 12;
  });
  let frames: Frame[] = [],
    source = '',
    timer: ReturnType<typeof setInterval> | undefined,
    connected = false,
    stopped = false;
  let lastWall: number | undefined, lastAudio: number | undefined;
  const clear = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    frames = [];
    source = '';
    lastWall = undefined;
    lastAudio = undefined;
    if (connected) {
      connected = false;
      try {
        graph.audioSource.disconnect(analyser);
      } catch {
        /* Retired graph. */
      }
    }
  };
  const eligible = () =>
    !stopped &&
    allowed() &&
    getCurrentAudioGraph() === graph &&
    graph.audioSource.mediaElement === main &&
    main.isConnected &&
    !main.paused &&
    !main.ended &&
    !main.seeking &&
    graph.audioContext.state === 'running';
  const sample = () => {
    if (!eligible()) {
      clear();
      return;
    }
    const wall = performance.now(),
      audio = graph.audioContext.currentTime * 1000;
    if (lastWall !== undefined && lastAudio !== undefined) {
      const wallGap = wall - lastWall,
        audioGap = audio - lastAudio;
      if (
        wallGap < 20 ||
        wallGap > 100 ||
        audioGap < 20 ||
        audioGap > 100 ||
        Math.abs(wallGap - audioGap) > 40
      )
        frames = [];
    }
    lastWall = wall;
    lastAudio = audio;
    if (source !== identity()) {
      frames = [];
      source = identity();
    }
    try {
      analyser.getFloatTimeDomainData(waveform);
      analyser.getFloatFrequencyData(spectrum);
      let energy = 0;
      for (const value of waveform) energy += value * value;
      const chroma = new Array<number>(12).fill(0);
      for (let bin = 1; bin < spectrum.length; bin++)
        if (classes[bin] >= 0 && Number.isFinite(spectrum[bin]))
          chroma[classes[bin]] += 10 ** (spectrum[bin] / 20);
      frames.push({ energy: energy / waveform.length, chroma });
      if (frames.length > MAX_FRAMES) frames.shift();
    } catch {
      clear();
    }
  };
  const refresh = () => {
    if (!eligible()) {
      clear();
      return;
    }
    if (!connected) {
      graph.audioSource.connect(analyser);
      connected = true;
    }
    if (!timer) timer = setInterval(sample, 1000 / FPS);
  };
  const reset = () => {
    clear();
    refresh();
  };
  const abort = new AbortController();
  for (const event of ['playing', 'play'])
    main.addEventListener(event, refresh, { signal: abort.signal });
  for (const event of [
    'pause',
    'ended',
    'seeking',
    'loadstart',
    'emptied',
    'peard:src-changed',
  ])
    main.addEventListener(event, clear, { signal: abort.signal });
  main.addEventListener('seeked', reset, { signal: abort.signal });
  graph.audioContext.addEventListener('statechange', refresh, {
    signal: abort.signal,
  });
  let release: (() => void) | undefined;
  release = graph.observeRetirement(() => dispose());
  function dispose() {
    if (stopped) return;
    stopped = true;
    abort.abort();
    clear();
    analyser.disconnect();
    release?.();
  }
  refresh();
  return {
    refresh,
    dispose,
    analysis: (expected = identity()) =>
      analyseFrames(
        eligible() && source === expected && source === identity()
          ? frames
          : [],
      ),
    get frameCount() {
      return frames.length;
    },
  };
}
