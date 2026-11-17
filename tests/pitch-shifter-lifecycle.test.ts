/* oxlint-disable typescript/no-explicit-any, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-return, @stylistic/no-mixed-operators */
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { build } from 'vite';

let source: string;
test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '@': path.resolve('src') } },
    plugins: [
      {
        name: 'pitch-fixture',
        enforce: 'pre',
        resolveId(id) {
          if (id.endsWith('task7-entry')) return '\0task7-entry';
          if (id === '@/utils' || id === '@/i18n') return '\0' + id;
          if (id === path.resolve('src/utils')) return '\0@/utils';
          if (id === path.resolve('src/i18n')) return '\0@/i18n';
          return undefined;
        },
        load(id) {
          if (id === '\0task7-entry')
            return `export * from '${path.resolve('src/providers/renderer-audio.ts')}';export {createPitchController} from '${path.resolve('src/plugins/pitch-shifter/controller.ts')}';export {createPitchRenderer} from '${path.resolve('src/plugins/pitch-shifter/renderer.ts')}';export {default as plugin} from '${path.resolve('src/plugins/pitch-shifter/index.ts')}';export {EqualizerController} from '${path.resolve('src/plugins/equalizer/controller.ts')}';export {DATTORRO_WORKLET_SOURCE} from '${path.resolve('src/plugins/player-actions/slowed-reverb/worklet.ts')}';export {computeDattorroParams} from '${path.resolve('src/plugins/player-actions/slowed-reverb/engine.ts')}';`;
          if (id === '\0@/utils') return 'export const createPlugin=x=>x;';
          if (id === '\0@/i18n') return 'export const t=x=>x;';
          return undefined;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'task7-entry', name: 'PitchFixture', formats: ['iife'] },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!('output' in output)) throw Error('Expected bundle');
  source = output.output
    .filter((item) => item.type === 'chunk')
    .map((item) => item.code)
    .join('\n');
});
test.beforeEach(async ({ page }) => {
  await page.route('https://pitch.fixture.invalid/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><video></video></body></html>',
    }),
  );
  await page.goto('https://pitch.fixture.invalid/');
  await page.addScriptTag({ content: source });
});

test('late enable on paused native media attaches without reload, follows A B absent A, and disposes on graph retirement', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = (window as any).PitchFixture,
      context = new AudioContext();
    const native = window.AudioWorkletNode,
      nodes: AudioWorkletNode[] = [],
      disposals: string[] = [];
    window.AudioWorkletNode = class extends native {
      constructor(
        ctx: BaseAudioContext,
        name: string,
        options?: AudioWorkletNodeOptions,
      ) {
        super(ctx, name, options);
        nodes.push(this);
        const send = this.port.postMessage.bind(this.port);
        this.port.postMessage = (message: unknown) => {
          if (message === 'dispose') disposals.push(name);
          send(message);
        };
      }
    };
    const a = document.querySelector('video')!,
      b = document.createElement('video');
    const sourceA = context.createMediaElementSource(a),
      sourceB = context.createMediaElementSource(b);
    let graph = api.initializeAudioGraph(context, sourceA);
    const renderer = api.createPitchRenderer();
    await renderer.start({
      getConfig: () => Promise.resolve({ enabled: true, semitones: 3 }),
    });
    await renderer.settled();
    const paused = a.paused,
      first = nodes.length;
    api.retireAudioGraph(graph);
    a.replaceWith(b);
    graph = api.initializeAudioGraph(context, sourceB);
    document.dispatchEvent(
      new CustomEvent('peard:audio-can-play', {
        detail: {
          audioContext: context,
          audioSource: sourceB,
          audioGraph: graph,
        },
      }),
    );
    await renderer.settled();
    const second = nodes.length;
    api.retireAudioGraph(graph);
    b.remove();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    document.body.append(a);
    graph = api.initializeAudioGraph(context, sourceA);
    document.dispatchEvent(
      new CustomEvent('peard:audio-can-play', {
        detail: {
          audioContext: context,
          audioSource: sourceA,
          audioGraph: graph,
        },
      }),
    );
    await renderer.settled();
    const returned = nodes.length;
    api.retireAudioGraph(graph);
    const retired = disposals.length;
    renderer.stop();
    await context.close();
    window.AudioWorkletNode = native;
    return {
      paused,
      first,
      second,
      returned,
      retired,
      disposals: disposals.length,
    };
  });
  expect(result).toEqual({
    paused: true,
    first: 1,
    second: 2,
    returned: 3,
    retired: 3,
    disposals: 3,
  });
});

test('pending module resolution after stop, graph retirement or native media replacement cannot install a stale node', async ({
  page,
}) => {
  const rows = await page.evaluate(async () => {
    const api = (window as any).PitchFixture,
      rows = [];
    for (const retire of ['stop', 'graph', 'media']) {
      const context = new AudioContext(),
        video = document.querySelector('video')!;
      const source = context.createMediaElementSource(video),
        graph = api.initializeAudioGraph(context, source);
      let release!: () => void;
      const nativeLoad = context.audioWorklet.addModule.bind(
        context.audioWorklet,
      );
      context.audioWorklet.addModule = async (url: string | URL) => {
        await new Promise<void>((resolve) => (release = resolve));
        return nativeLoad(url);
      };
      let inserts = 0;
      const insert = graph.insertPostMaster;
      graph.insertPostMaster = (...args: AudioNode[]) => {
        inserts++;
        return insert(...args);
      };
      const renderer = api.createPitchRenderer();
      await renderer.start({
        getConfig: () => Promise.resolve({ enabled: true, semitones: 7 }),
      });
      if (retire === 'stop') renderer.stop();
      if (retire === 'graph') api.retireAudioGraph(graph);
      if (retire === 'media')
        video.replaceWith(document.createElement('video'));
      release();
      await renderer.settled();
      rows.push({ retire, inserts });
      renderer.stop();
      api.retireAudioGraph(graph);
      await context.close();
      video.replaceWith(document.createElement('video'));
      if (!document.querySelector('video'))
        document.body.append(document.createElement('video'));
    }
    return rows;
  });
  expect(rows.map((row) => row.inserts)).toEqual([0, 0, 0]);
});

test('default-off menu persists only integer semitones and reset; disabled/re-enabled renderer releases the old worklet', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = (window as any).PitchFixture,
      patches: unknown[] = [];
    const menu = await api.plugin.menu({
      getConfig: () => Promise.resolve({ enabled: true, semitones: 3 }),
      setConfig: (patch: unknown) => patches.push(patch),
    });
    const choices = menu[0].submenu;
    choices.find((item: any) => item.label === '+7').click();
    menu[1].click();
    const context = new AudioContext(),
      video = document.querySelector('video')!,
      graph = api.initializeAudioGraph(
        context,
        context.createMediaElementSource(video),
      );
    const renderer = api.createPitchRenderer();
    await renderer.start({
      getConfig: () => Promise.resolve({ enabled: true, semitones: 3 }),
    });
    await renderer.settled();
    renderer.onConfigChange({ enabled: false, semitones: 7 });
    renderer.onConfigChange({ enabled: true, semitones: 7 });
    await renderer.settled();
    renderer.stop();
    api.retireAudioGraph(graph);
    await context.close();
    return {
      defaults: api.plugin.config,
      choices: choices.length,
      checked: choices
        .filter((item: any) => item.checked)
        .map((item: any) => item.label),
      patches,
    };
  });
  expect(result).toEqual({
    defaults: { enabled: false, semitones: 0 },
    choices: 25,
    checked: ['+3'],
    patches: [{ semitones: 7 }, { semitones: 0 }],
  });
});

test('real EQ plus Reverb wet output passes through native Pitch once without an unshifted duplicate', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = (window as any).PitchFixture,
      context = new OfflineAudioContext(2, 96000, 48000);
    const media = Object.assign(new EventTarget(), { volume: 1, muted: false });
    const source = context.createBufferSource(),
      buffer = context.createBuffer(2, 96000, 48000);
    for (let c = 0; c < 2; c++)
      for (let i = 0; i < 96000; i++)
        buffer.getChannelData(c)[i] =
          0.04 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    source.buffer = buffer;
    const raw = context.createGain();
    source.connect(raw);
    Object.defineProperty(raw, 'mediaElement', { value: media });
    const graph = api.initializeAudioGraph(context, raw),
      eq = new api.EqualizerController(graph);
    eq.apply(
      {
        mode: 'custom',
        preamp: 0,
        bands: [
          { id: 'tone', type: 'peaking', frequency: 440, gain: -3, Q: 1 },
        ],
      },
      false,
      false,
    );
    const shifter = api.createPitchController(graph, 12, () => true);
    if (!(await shifter.ready)) throw Error('Pitch not ready');
    const reverbSource = api.DATTORRO_WORKLET_SOURCE.replace(
      "registerProcessor('dattorro-reverb', DattorroReverbProcessor);",
      "class Ready extends DattorroReverbProcessor {handleMessage(data){super.handleMessage(data);if(data.type==='setParams')this.port.postMessage('ready')}};registerProcessor('dattorro-reverb',Ready);",
    );
    const url = URL.createObjectURL(
      new Blob([reverbSource], { type: 'application/javascript' }),
    );
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const wet = new AudioWorkletNode(context, 'dattorro-reverb', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const gain = context.createGain();
    gain.gain.value = 0.2;
    raw.connect(wet);
    wet.connect(gain);
    const lease = graph.registerWetOutput(gain, () => {
      throw Error('Wet route failed');
    });
    if (!(await lease.ready)) throw Error('Wet not ready');
    await new Promise<void>((resolve) => {
      wet.port.onmessage = () => resolve();
      wet.port.postMessage({
        type: 'setParams',
        params: api.computeDattorroParams(0.4),
      });
    });
    source.start();
    const audio = await context.startRendering(),
      samples = audio.getChannelData(0);
    const power = (frequency: number) => {
      let re = 0,
        im = 0;
      for (let i = 24000; i < 96000; i++) {
        re += samples[i] * Math.cos((2 * Math.PI * frequency * i) / 48000);
        im += samples[i] * Math.sin((2 * Math.PI * frequency * i) / 48000);
      }
      return re * re + im * im;
    };
    const result = {
      shifted: power(880),
      original: power(440),
      finite: [...samples].every(Number.isFinite),
      peak: Math.max(...samples.map(Math.abs)),
    };
    shifter.dispose();
    lease.release();
    wet.port.postMessage({ type: 'dispose' });
    wet.port.close();
    wet.disconnect();
    eq.stop();
    api.retireAudioGraph(graph);
    return result;
  });
  expect(result.finite).toBe(true);
  expect(result.shifted).toBeGreaterThan(1000);
  expect(result.original / result.shifted).toBeLessThan(0.0001);
  expect(result.peak).toBeLessThan(0.2);
});

test('a synchronous owner loss during insert and stale config results release every created processor', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = (window as any).PitchFixture,
      context = new AudioContext(),
      video = document.querySelector('video')!;
    const graph = api.initializeAudioGraph(
      context,
      context.createMediaElementSource(video),
    );
    let disposed = 0;
    const Native = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Native {
      constructor(
        ctx: BaseAudioContext,
        name: string,
        options?: AudioWorkletNodeOptions,
      ) {
        super(ctx, name, options);
        const send = this.port.postMessage.bind(this.port);
        this.port.postMessage = (message: unknown) => {
          if (message === 'dispose') disposed++;
          send(message);
        };
      }
    };
    const renderer = api.createPitchRenderer(),
      insert = graph.insertPostMaster;
    graph.insertPostMaster = (input: AudioNode, output: AudioNode) => {
      const release = insert(input, output);
      renderer.stop();
      return release;
    };
    await renderer.start({
      getConfig: () => Promise.resolve({ enabled: true, semitones: 7 }),
    });
    await renderer.settled();
    graph.insertPostMaster = insert;
    let resolve!: (config: unknown) => void;
    const loading = renderer.start({
      getConfig: () => new Promise((done) => (resolve = done)),
    });
    renderer.stop();
    resolve({ enabled: true, semitones: 12 });
    await loading;
    const fresh = context.createGain();
    let slotAvailable = false;
    try {
      const release = graph.insertPostMaster(fresh, fresh);
      slotAvailable = true;
      release();
    } finally {
      renderer.stop();
      api.retireAudioGraph(graph);
      await context.close();
      window.AudioWorkletNode = Native;
    }
    return { disposed, slotAvailable };
  });
  expect(result).toEqual({ disposed: 1, slotAvailable: true });
});

test('native neutral Pitch preserves pre-guard headroom while shared output protection bounds the destination', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = (window as any).PitchFixture,
      context = new OfflineAudioContext(4, 12000, 48000);
    const raw = context.createGain();
    Object.defineProperty(raw, 'mediaElement', {
      value: Object.assign(new EventTarget(), { volume: 1, muted: false }),
    });
    const graph = api.initializeAudioGraph(context, raw),
      pitch = api.createPitchController(graph, 0, () => true);
    if (!(await pitch.ready)) throw Error('Pitch not ready');
    const lease = graph.registerWetOutput(context.createGain(), () => {
      throw Error('Protection failed');
    });
    if (!(await lease.ready)) throw Error('Guard not ready');
    // Test-only measurement channels: outputInput is the processor output,
    // while channels 0/1 retain the real protected destination route.
    const monitor = context.createChannelMerger(4);
    graph.outputInput.connect(monitor, 0, 2);
    monitor.connect(context.destination);
    const signal = context.createConstantSource();
    signal.offset.value = 1.5;
    signal.connect(raw);
    signal.start();
    const rendered = await context.startRendering();
    const result = {
      before: rendered.getChannelData(2)[10000],
      after: rendered.getChannelData(0)[10000],
    };
    pitch.dispose();
    lease.release();
    monitor.disconnect();
    api.retireAudioGraph(graph);
    return result;
  });
  expect(result.before).toBeCloseTo(1.5, 6);
  expect(result.after).toBeGreaterThan(0.9);
  expect(result.after).toBeLessThanOrEqual(Math.fround(0.99));
});
