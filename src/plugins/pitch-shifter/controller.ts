import {
  getCurrentAudioGraph,
  type RendererAudioGraph,
} from '@/providers/renderer-audio';

import { clampSemitones } from './constants';
import { PROCESSOR_NAME, registerPitchShifterProcessor } from './processor';

const modules = new WeakMap<AudioContext, Promise<void>>();
function loadProcessor(context: AudioContext) {
  const existing = modules.get(context);
  if (existing) return existing;
  const source = `(${registerPitchShifterProcessor.toString()})(${JSON.stringify(PROCESSOR_NAME)});`;
  const url = URL.createObjectURL(
    new Blob([source], { type: 'application/javascript' }),
  );
  let load: Promise<void>;
  try {
    load = context.audioWorklet.addModule(url);
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  const pending = load.finally(() => URL.revokeObjectURL(url));
  modules.set(context, pending);
  pending.catch(() => {
    if (modules.get(context) === pending) modules.delete(context);
  });
  return pending;
}

/** One worklet in the renderer's dedicated post-EQ slot, never a destination override. */
export function createPitchController(
  graph: RendererAudioGraph,
  semitones: number,
  current: () => boolean,
) {
  const context = graph.audioContext;
  let disposed = false,
    value = clampSemitones(semitones),
    node: AudioWorkletNode | null = null;
  let release: (() => void) | undefined,
    releaseRetirement: (() => void) | undefined;
  const alive = () =>
    !disposed &&
    current() &&
    !disposed &&
    getCurrentAudioGraph() === graph &&
    context.state !== 'closed';
  const retireNode = (owned: AudioWorkletNode) => {
    owned.onprocessorerror = null;
    try {
      owned.port.postMessage('dispose');
    } catch {
      /* Closed. */
    }
    try {
      owned.disconnect();
    } catch {
      /* Detached. */
    }
    try {
      owned.port.close();
    } catch {
      /* Closed. */
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    releaseRetirement?.();
    releaseRetirement = undefined;
    const previousRelease = release;
    release = undefined;
    try {
      previousRelease?.();
    } catch (error) {
      console.error('[pitch-shifter] Could not release insert', error);
    } finally {
      const owned = node;
      node = null;
      if (owned) retireNode(owned);
    }
  };
  const stop = graph.observeRetirement(dispose);
  if (disposed) stop();
  else releaseRetirement = stop;
  const ready = (async () => {
    try {
      if (!alive()) return false;
      await loadProcessor(context);
      if (!alive()) return false;
      const owned = new AudioWorkletNode(context, PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        parameterData: { semitones: value },
      });
      if (!alive()) {
        retireNode(owned);
        return false;
      }
      node = owned;
      owned.onprocessorerror = dispose;
      const stopInsert = graph.insertPostMaster(owned, owned);
      if (!alive()) {
        stopInsert();
        dispose();
        return false;
      }
      release = stopInsert;
      return true;
    } catch (error) {
      dispose();
      console.error('[pitch-shifter] Could not attach processor', error);
      return false;
    }
  })();
  return {
    ready,
    dispose,
    setSemitones(next: number) {
      value = clampSemitones(next);
      if (!alive() || !node) return;
      const parameter = node.parameters.get('semitones');
      if (!parameter) return;
      const now = context.currentTime;
      parameter.cancelAndHoldAtTime(now);
      parameter.linearRampToValueAtTime(value, now + 0.02);
    },
  };
}
