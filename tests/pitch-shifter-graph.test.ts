/* oxlint-disable typescript/no-explicit-any, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument */
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { build } from 'vite';

let source: string;
test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: path.resolve('src/providers/renderer-audio.ts'),
        name: 'GraphFixture',
        formats: ['iife'],
      },
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

test('post-master insert follows master for main, processed wet and auxiliary routes; either release order is exact', async ({
  page,
}) => {
  const results = await page.evaluate(async () => {
    const rows = [];
    for (const order of ['pitch-first', 'eq-first'])
      for (const release of ['none', 'eq', 'pitch', 'both']) {
        const context = new OfflineAudioContext(1, 4800, 48000);
        const main = new EventTarget();
        Object.assign(main, { volume: 1, muted: false });
        const source = context.createGain();
        Object.defineProperty(source, 'mediaElement', { value: main });
        const graph = (window as any).GraphFixture.initializeAudioGraph(
          context,
          source,
        );
        const signal = (level: number, target: AudioNode) => {
          const tone = context.createConstantSource();
          tone.offset.value = level;
          tone.connect(target);
          tone.start();
        };
        signal(0.02, source);
        signal(0.05, graph.masterInput);
        const aux = context.createGain();
        Object.defineProperty(context, 'createMediaElementSource', {
          value: () => aux,
        });
        const disposeAux = graph.registerMedia(document.createElement('audio'));
        signal(0.03, aux);
        const eq = context.createGain(),
          pitch = context.createGain();
        eq.gain.value = 2;
        pitch.gain.value = 3;
        let stopEq!: () => void, stopPitch!: () => void;
        if (order === 'pitch-first') {
          stopPitch = graph.insertPostMaster(pitch, pitch);
          stopEq = graph.insertMaster(eq, eq);
        } else {
          stopEq = graph.insertMaster(eq, eq);
          stopPitch = graph.insertPostMaster(pitch, pitch);
        }
        let secondMasterRejected = false,
          secondPitchRejected = false;
        try {
          graph.insertMaster(context.createGain(), context.createGain());
        } catch {
          secondMasterRejected = true;
        }
        try {
          graph.insertPostMaster(context.createGain(), context.createGain());
        } catch {
          secondPitchRejected = true;
        }
        if (release === 'eq' || release === 'both') stopEq();
        if (release === 'pitch' || release === 'both') stopPitch();
        const buffer = await context.startRendering();
        rows.push({
          order,
          release,
          value: buffer.getChannelData(0)[3000],
          secondMasterRejected,
          secondPitchRejected,
          aux: graph.auxiliaryMediaCount,
        });
        disposeAux();
        (window as any).GraphFixture.retireAudioGraph(graph);
      }
    return rows;
  });
  for (const row of results) {
    expect(row.value).toBeCloseTo(
      row.release === 'none'
        ? 0.6
        : row.release === 'eq'
          ? 0.3
          : row.release === 'pitch'
            ? 0.2
            : 0.1,
      5,
    );
    expect(row.secondMasterRejected).toBe(true);
    expect(row.secondPitchRejected).toBe(true);
    expect(row.aux).toBe(1);
  }
});

test('stale disposers cannot remove a replacement insert and retirement disconnects both slots', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const context = new OfflineAudioContext(1, 4800, 48000);
    const source = context.createGain();
    Object.defineProperty(source, 'mediaElement', {
      value: Object.assign(new EventTarget(), { volume: 1, muted: false }),
    });
    const graph = (window as any).GraphFixture.initializeAudioGraph(
      context,
      source,
    );
    const eq = context.createGain(),
      old = context.createGain(),
      pitch = context.createGain();
    eq.gain.value = 2;
    pitch.gain.value = 4;
    const stopEq = graph.insertMaster(eq, eq),
      stale = graph.insertPostMaster(old, old);
    stale();
    const stopPitch = graph.insertPostMaster(pitch, pitch);
    stale();
    const signal = context.createConstantSource();
    signal.offset.value = 0.01;
    signal.connect(source);
    signal.start();
    const buffer = await context.startRendering();
    (window as any).GraphFixture.retireAudioGraph(graph);
    stopEq();
    stopPitch();
    stale();
    let retiredRejects = false;
    try {
      graph.insertPostMaster(old, old);
    } catch {
      retiredRejects = true;
    }
    return {
      value: buffer.getChannelData(0)[3000],
      retiredRejects,
      current: (window as any).GraphFixture.getCurrentAudioGraph(),
    };
  });
  expect(result.value).toBeCloseTo(0.08, 5);
  expect(result.retiredRejects).toBe(true);
  expect(result.current).toBeNull();
});

test('retirement inside native connect rolls back the new post-master route', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const context = new OfflineAudioContext(1, 4800, 48000);
    const source = context.createGain();
    Object.defineProperty(source, 'mediaElement', {
      value: Object.assign(new EventTarget(), { volume: 1, muted: false }),
    });
    const graph = (window as any).GraphFixture.initializeAudioGraph(
      context,
      source,
    );
    const input = context.createGain(),
      output = context.createGain();
    input.connect(output);
    const connect = output.connect.bind(output);
    Object.defineProperty(output, 'connect', {
      value: (destination: AudioNode) => {
        const result = connect(destination);
        (window as any).GraphFixture.retireAudioGraph(graph);
        return result;
      },
    });
    let rejected = false;
    try {
      graph.insertPostMaster(input, output);
    } catch {
      rejected = true;
    }
    const signal = context.createConstantSource();
    signal.offset.value = 0.1;
    signal.connect(source);
    signal.start();
    const buffer = await context.startRendering();
    return {
      rejected,
      peak: Math.max(...buffer.getChannelData(0).map(Math.abs)),
    };
  });
  expect(result.rejected).toBe(true);
  expect(result.peak).toBe(0);
});

test('retirement observers release processor ownership once, including late subscriptions', async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const context = new OfflineAudioContext(1, 128, 48000),
      source = context.createGain();
    Object.defineProperty(source, 'mediaElement', {
      value: Object.assign(new EventTarget(), { volume: 1, muted: false }),
    });
    const api = (window as any).GraphFixture,
      graph = api.initializeAudioGraph(context, source);
    let active = 0,
      removed = 0,
      late = 0;
    const remove = graph.observeRetirement(() => removed++);
    remove();
    graph.observeRetirement(() => {
      active++;
      api.retireAudioGraph(graph);
    });
    api.retireAudioGraph(graph);
    api.retireAudioGraph(graph);
    graph.observeRetirement(() => late++);
    return { active, removed, late };
  });
  expect(result).toEqual({ active: 1, removed: 0, late: 1 });
});
