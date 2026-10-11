/** Renderer-owned music buses. Raw analyser taps retain the original media source. */
export interface RendererAudioGraph {
  audioContext: AudioContext;
  audioSource: MediaElementAudioSourceNode;
  dryInput: GainNode;
  masterInput: GainNode;
  musicGate: GainNode;
  insertMain(input: AudioNode, output: AudioNode): () => void;
  insertDry(input: AudioNode, output: AudioNode): () => void;
  insertMaster(input: AudioNode, output: AudioNode): () => void;
  registerMedia(element: HTMLMediaElement, gain?: GainNode): () => void;
}

let current: RendererAudioGraph | null = null;
const graphs = new WeakMap<AudioNode, RendererAudioGraph>();

export function getCurrentAudioGraph(): RendererAudioGraph | null {
  return current;
}

export function initializeAudioGraph(
  audioContext: AudioContext,
  audioSource: MediaElementAudioSourceNode,
): RendererAudioGraph {
  const existing = graphs.get(audioSource);
  if (existing) return (current = existing);
  const dryInput = audioContext.createGain();
  const masterInput = audioContext.createGain();
  const musicGate = audioContext.createGain();
  // Only the renderer's original dry edge is ours to replace. Never detach raw taps.
  try {
    audioSource.disconnect(audioContext.destination);
  } catch {
    /* no original edge */
  }
  audioSource.connect(dryInput);
  dryInput.connect(masterInput);
  masterInput.connect(musicGate);
  musicGate.connect(audioContext.destination);
  const main = audioSource.mediaElement;
  const syncMute = () => {
    musicGate.gain.value = main?.muted || main?.volume === 0 ? 0 : 1;
  };
  syncMute();
  main?.addEventListener('volumechange', syncMute);
  const contextChanged = () => {
    if (audioContext.state !== 'closed') return;
    main?.removeEventListener('volumechange', syncMute);
    audioContext.removeEventListener('statechange', contextChanged);
    if (current?.audioContext === audioContext) current = null;
  };
  audioContext.addEventListener('statechange', contextChanged);
  const mediaNodes = new WeakMap<
    HTMLMediaElement,
    MediaElementAudioSourceNode
  >();
  const activeMedia = new WeakSet<HTMLMediaElement>();
  function insert(upstream: AudioNode, downstream: AudioNode) {
    let active: { input: AudioNode; output: AudioNode; token: object } | null =
      null;
    return (input: AudioNode, output: AudioNode) => {
      if (active) throw new Error('The music insert is already owned');
      const token = {};
      try {
        upstream.connect(input);
        output.connect(downstream);
        upstream.disconnect(downstream);
      } catch (error) {
        try {
          upstream.disconnect(input);
        } catch {
          /* rollback only our edge */
        }
        try {
          output.disconnect(downstream);
        } catch {
          /* rollback only our edge */
        }
        throw error;
      }
      active = { input, output, token };
      return () => {
        if (active?.token !== token) return;
        upstream.connect(downstream);
        upstream.disconnect(input);
        output.disconnect(downstream);
        active = null;
      };
    };
  }
  const graph: RendererAudioGraph = {
    audioContext,
    audioSource,
    dryInput,
    masterInput,
    musicGate,
    insertMain: insert(audioSource, dryInput),
    insertDry: insert(dryInput, masterInput),
    insertMaster: insert(masterInput, musicGate),
    registerMedia(element, suppliedGain) {
      if (element === audioSource.mediaElement)
        throw new Error('Main media is already registered');
      if (activeMedia.has(element))
        throw new Error('Auxiliary media is already registered');
      if (suppliedGain && suppliedGain.context !== audioContext)
        throw new Error('Auxiliary gain belongs to another audio context');
      let source = mediaNodes.get(element);
      if (!source) {
        source = audioContext.createMediaElementSource(element);
        mediaNodes.set(element, source);
      }
      const gain = suppliedGain ?? audioContext.createGain();
      source.connect(gain);
      gain.connect(dryInput);
      activeMedia.add(element);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        source.disconnect(gain);
        gain.disconnect(dryInput);
        activeMedia.delete(element);
      };
    },
  };
  graphs.set(audioSource, graph);
  return (current = graph);
}

export function graphFromAnnouncement(detail: {
  audioContext: AudioContext;
  audioSource: MediaElementAudioSourceNode;
  audioGraph?: RendererAudioGraph;
}): RendererAudioGraph {
  return detail.audioGraph
    ? (current = detail.audioGraph)
    : initializeAudioGraph(detail.audioContext, detail.audioSource);
}
