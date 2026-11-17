import { expect, test } from '@playwright/test';
import { equalizerBundle, fixturePage } from '../helpers/equalizer-bundle';
import { exclusiveMixAllowed } from '../../src/plugins/automix/exclusive';

test('shared guard excludes both transition features when the other is enabled', () => {
  for (const mode of ['automix', 'crossfade'] as const) {
    expect(exclusiveMixAllowed(mode, true, {})).toBe(true);
    expect(
      exclusiveMixAllowed(mode, true, {
        automix: { enabled: true },
        crossfade: { enabled: true },
      }),
    ).toBe(false);
    expect(exclusiveMixAllowed(mode, false, {})).toBe(false);
    expect(exclusiveMixAllowed(mode, true, null)).toBe(false);
  }
});

test('actual beta entry defaults off and native menu changes only beat count', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).ipcRenderer = { on() {}, send() {} };
  });
  await fixturePage(
    page,
    await equalizerBundle(
      "export {default as automix} from '@/plugins/automix';",
    ),
  );
  const result = await page.evaluate(async () => {
    const plugin = (window as any).EqualizerFixture.automix;
    const changes: unknown[] = [];
    const menu = await plugin.menu({
      getConfig: () => plugin.config,
      setConfig: (value: unknown) => changes.push(value),
    });
    menu[1].click();
    return {
      enabled: plugin.config.enabled,
      name: plugin.name(),
      labels: menu.map((row: any) => row.label),
      changes,
    };
  });
  expect(result.enabled).toBe(false);
  expect(result.name).toContain('Beta');
  expect(result.changes).toEqual([{ blendBeats: 4 }]);
  expect(result.labels[0]).toContain('no tempo stretching');
});

test('live analyser collector releases its bounded ring on pause, conflict and graph retirement', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(
      "export * from '@/providers/renderer-audio'; export {createAutoMixSampler} from '@/plugins/automix/sampler';",
    ),
  );
  const result = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture,
      main = document.querySelector('video')!;
    Object.defineProperty(main, 'paused', { get: () => false });
    const context = new AudioContext(),
      graph = f.initializeAudioGraph(
        context,
        context.createMediaElementSource(main),
      );
    await context.resume();
    let allowed = true;
    const sampler = f.createAutoMixSampler(main, graph, () => allowed);
    await new Promise((r) => setTimeout(r, 180));
    const active = sampler.frameCount;
    main.dispatchEvent(new Event('pause'));
    await new Promise((r) => setTimeout(r, 120));
    const paused = sampler.frameCount;
    main.dispatchEvent(new Event('playing'));
    await new Promise((r) => setTimeout(r, 120));
    allowed = false;
    sampler.refresh();
    const conflict = sampler.frameCount;
    allowed = true;
    sampler.refresh();
    f.retireAudioGraph(graph);
    await new Promise((r) => setTimeout(r, 100));
    const retired = sampler.frameCount;
    sampler.dispose();
    await context.close();
    return {
      active,
      paused,
      conflict,
      retired,
      count: graph.auxiliaryMediaCount,
    };
  });
  expect(result.active).toBeGreaterThan(0);
  expect(result).toMatchObject({
    paused: 0,
    conflict: 0,
    retired: 0,
    count: 0,
  });
});

test('actual renderer cannot finish a pending start after stop or pagehide', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).ipcRenderer = { on() {}, send() {} };
  });
  await fixturePage(
    page,
    await equalizerBundle(
      "export {default as automix} from '@/plugins/automix';",
    ),
  );
  const result = await page.evaluate(async () => {
    const renderer = (window as any).EqualizerFixture.automix.renderer;
    let resolve!: (value: unknown) => void;
    const config = { enabled: true, blendBeats: 8, maxSeconds: 6 };
    const context = {
      getConfig: () => new Promise((r) => (resolve = r)),
      ipc: {},
    };
    const first = renderer.start(context);
    renderer.stop();
    resolve(config);
    await first;
    const stopped = !renderer.running && !renderer.detach;
    const second = renderer.start(context);
    window.dispatchEvent(new Event('pagehide'));
    resolve(config);
    await second;
    return { stopped, hidden: !renderer.running && !renderer.detach };
  });
  expect(result).toEqual({ stopped: true, hidden: true });
});

test('sampler resets history after a delayed timer instead of treating the gap as 20 Hz', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(
      "export * from '@/providers/renderer-audio';export {createAutoMixSampler} from '@/plugins/automix/sampler';",
    ),
  );
  const result = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture,
      main = document.querySelector('video')!;
    Object.defineProperty(main, 'paused', { get: () => false });
    const context = new AudioContext();
    await context.resume();
    const graph = f.initializeAudioGraph(
      context,
      context.createMediaElementSource(main),
    );
    const sampler = f.createAutoMixSampler(main, graph, () => true);
    await new Promise((r) => setTimeout(r, 400));
    const before = sampler.frameCount;
    const end = performance.now() + 250;
    while (performance.now() < end) {}
    await new Promise((r) => setTimeout(r, 60));
    const after = sampler.frameCount;
    sampler.dispose();
    await context.close();
    return { before, after };
  });
  expect(result.before).toBeGreaterThan(4);
  expect(result.after).toBeLessThanOrEqual(2);
});
