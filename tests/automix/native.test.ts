import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { startCrossfadeFixture } from '../helpers/crossfade-native';

const exports = "export {default as automix} from '@/plugins/automix';";
test('actual AutoMix renderer applies live tempo/key plan to the shared native handoff', async ({
  page,
}) => {
  test.setTimeout(60000);
  const client = await page.context().newCDPSession(page);
  await client.send('Performance.enable');
  const before = await client.send('Performance.getMetrics');
  const fixtureStart = Date.now();
  await startCrossfadeFixture(page, {
    rendererExport: 'automix',
    sourceExports: exports,
    waveSeconds: 30,
    pulse: true,
  });
  const fixtureSetupMs = Date.now() - fixtureStart;
  await expect
    .poll(() => page.evaluate(() => (window as any).crossfadeFixture.nexts), {
      timeout: 40000,
      intervals: [100],
    })
    .toBe(1);
  const result = await page.evaluate(async () => {
    const f = (window as any).crossfadeFixture;
    await new Promise((r) => setTimeout(r, 300));
    const plan = f.renderer.lastPlan;
    const before = {
      plan,
      analysis: f.renderer.lastAnalysis,
      count: f.graph.auxiliaryMediaCount,
      registered: f.aux.length,
      requests: f.requests,
      tail: f.power(500),
      incoming: f.power(1000),
      time: f.aux[0]?.currentTime,
    };
    f.renderer.stop();
    const after = f.graph.auxiliaryMediaCount;
    await f.context.close();
    return { ...before, after };
  });
  const after = await client.send('Performance.getMetrics');
  const metric = (metrics: typeof before, name: string) =>
    metrics.metrics.find((item) => item.name === name)?.value ?? 0;
  const proof = {
    environment:
      'Chromium headless muted, owned local-WAV fixture; not packaged app or user profile',
    fixtureSetupMs,
    rendererTaskSeconds:
      metric(after, 'TaskDuration') - metric(before, 'TaskDuration'),
    elapsedSeconds: metric(after, 'Timestamp') - metric(before, 'Timestamp'),
    jsHeapUsedBytes: metric(after, 'JSHeapUsedSize'),
    result,
  };
  if (process.env.AUTOMIX_PROOF_OUTPUT)
    await writeFile(
      process.env.AUTOMIX_PROOF_OUTPUT,
      JSON.stringify(proof, null, 2),
    );
  expect(result.analysis.bpm).toBeGreaterThanOrEqual(100);
  expect(result.analysis.bpm).toBeLessThanOrEqual(140);
  expect(result.plan.fadeInDuration).toBeGreaterThanOrEqual(1900);
  expect(result.plan.fadeInDuration).toBeLessThanOrEqual(4100);
  expect(result.plan.fadeInDuration).not.toBe(3000);
  expect(result.count).toBe(1);
  expect(result.registered).toBe(1);
  expect(result.requests).toBe(1);
  expect(result.time).toBeGreaterThan(20);
  expect(result.tail).toBeGreaterThan(0);
  expect(result.incoming).toBeGreaterThan(0);
  expect(result.after).toBe(0);
});

test('AutoMix conflict and stop reject late stream results before graph admission', async ({
  page,
}) => {
  await startCrossfadeFixture(page, {
    rendererExport: 'automix',
    sourceExports: exports,
    requestDelay: true,
  });
  const before = await page.evaluate(() => {
    const f = (window as any).crossfadeFixture;
    (window as any).mainConfig.get = () => ({ crossfade: { enabled: true } });
    f.renderer.onConfigChange({ enabled: true, blendBeats: 8, maxSeconds: 6 });
    f.main.dispatchEvent(new Event('timeupdate'));
    return { nexts: f.nexts, count: f.graph.auxiliaryMediaCount };
  });
  expect(before).toEqual({ nexts: 0, count: 0 });
  await page.evaluate(() => {
    const f = (window as any).crossfadeFixture;
    f.renderer.stop();
    f.resolve();
  });
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(() => {
      const f = (window as any).crossfadeFixture;
      return {
        nexts: f.nexts,
        count: f.graph.auxiliaryMediaCount,
        registered: f.aux.length,
      };
    }),
  ).toEqual({ nexts: 0, count: 0, registered: 0 });
});

test('changed native next identity rejects an already pending AutoMix stream', async ({
  page,
}) => {
  await startCrossfadeFixture(page, {
    rendererExport: 'automix',
    sourceExports: exports,
    requestDelay: true,
  });
  await page.evaluate(() => {
    const f = (window as any).crossfadeFixture;
    (document.querySelector('#queue') as any).queue.getItems = () => [
      {
        playlistPanelVideoRenderer: { videoId: 'AAAAAAAAAAA', selected: true },
      },
      {
        playlistPanelVideoRenderer: { videoId: 'CCCCCCCCCCC', selected: false },
      },
    ];
    f.resolve();
    f.main.dispatchEvent(new Event('timeupdate'));
  });
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(() => {
      const f = (window as any).crossfadeFixture;
      f.renderer.stop();
      return {
        nexts: f.nexts,
        count: f.graph.auxiliaryMediaCount,
        registered: f.aux.length,
      };
    }),
  ).toEqual({ nexts: 0, count: 0, registered: 0 });
});

test('same-track AutoMix re-arms after conflict while the previous physical request settles', async ({
  page,
}) => {
  await startCrossfadeFixture(page, {
    rendererExport: 'automix',
    sourceExports: exports,
    requestDelay: true,
  });
  await page.evaluate(() => {
    const f = (window as any).crossfadeFixture;
    (window as any).mainConfig.get = () => ({ crossfade: { enabled: true } });
    f.renderer.onConfigChange({ enabled: true, blendBeats: 8, maxSeconds: 6 });
    (window as any).mainConfig.get = () => ({ crossfade: { enabled: false } });
    f.renderer.onConfigChange({ enabled: true, blendBeats: 8, maxSeconds: 6 });
    f.main.dispatchEvent(new Event('timeupdate'));
    f.resolve();
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).crossfadeFixture.requests))
    .toBe(2);
  await page.evaluate(() => (window as any).crossfadeFixture.resolve());
  await expect
    .poll(() => page.evaluate(() => (window as any).crossfadeFixture.nexts), {
      timeout: 5000,
      intervals: [20],
    })
    .toBe(1);
  await page.evaluate(() => {
    const f = (window as any).crossfadeFixture;
    f.renderer.stop();
  });
});

test('latest API rebinds a replacement shared graph and readiness listener retires on stop', async ({
  page,
}) => {
  await startCrossfadeFixture(page, {
    rendererExport: 'automix',
    sourceExports: exports,
    requestDelay: true,
  });
  const result = await page.evaluate(() => {
    const f = (window as any).crossfadeFixture,
      modules = (window as any).EqualizerFixture;
    const old = f.graph;
    modules.retireAudioGraph(old);
    const next = document.createElement('video');
    f.main.replaceWith(next);
    const graph = modules.initializeAudioGraph(
      f.context,
      f.context.createMediaElementSource(next),
    );
    document.dispatchEvent(
      new CustomEvent('peard:audio-can-play', {
        detail: {
          audioGraph: graph,
          audioSource: graph.audioSource,
          audioContext: f.context,
        },
      }),
    );
    const rebound = f.renderer.graph === graph && f.renderer.boundApi === f.api;
    f.renderer.stop();
    document.dispatchEvent(
      new CustomEvent('peard:audio-can-play', {
        detail: { audioGraph: graph },
      }),
    );
    return {
      rebound,
      oldCount: old.auxiliaryMediaCount,
      newCount: graph.auxiliaryMediaCount,
      afterStop: f.renderer.graph === undefined,
      bindingRetired: f.renderer.bind === undefined,
    };
  });
  expect(result).toEqual({
    rebound: true,
    oldCount: 0,
    newCount: 0,
    afterStop: true,
    bindingRetired: true,
  });
});

for (const first of ['crossfade', 'automix'])
  test(`${first} survives the other mode being enabled then disabled`, async ({
    page,
  }) => {
    const second = first === 'crossfade' ? 'automix' : 'crossfade';
    await startCrossfadeFixture(page, {
      rendererExport: first,
      sourceExports: exports,
      requestDelay: true,
    });
    await page.evaluate(
      async ({ first, second }) => {
        const f = (window as any).crossfadeFixture,
          modules = (window as any).EqualizerFixture;
        let plugins: any = {
          crossfade: { enabled: true },
          automix: { enabled: true },
        };
        (window as any).mainConfig.get = () => plugins;
        f.emitIpc('config-changed', second, { enabled: true });
        const other = modules[second].renderer;
        await other.start({
          getConfig: async () => ({ ...modules[second].config, enabled: true }),
          ipc: { invoke: async () => f.stream, subscribe: f.subscribe },
        });
        other.onPlayerApiReady(f.api);
        f.main.dispatchEvent(new Event('timeupdate'));
        other.stop();
        plugins = { [first]: { enabled: true }, [second]: { enabled: false } };
        f.emitIpc('config-changed', second, { enabled: false });
        f.main.dispatchEvent(new Event('timeupdate'));
        f.resolve();
      },
      { first, second },
    );
    await expect
      .poll(
        () => page.evaluate(() => (window as any).crossfadeFixture.requests),
        { timeout: 3000 },
      )
      .toBe(2);
    await page.evaluate(() => (window as any).crossfadeFixture.resolve());
    await expect
      .poll(() => page.evaluate(() => (window as any).crossfadeFixture.nexts), {
        timeout: 5000,
        intervals: [20],
      })
      .toBe(1);
    expect(
      await page.evaluate(() => {
        const f = (window as any).crossfadeFixture;
        const count = f.graph.auxiliaryMediaCount;
        f.renderer.stop();
        return { count, after: f.graph.auxiliaryMediaCount };
      }),
    ).toEqual({ count: 1, after: 0 });
  });
