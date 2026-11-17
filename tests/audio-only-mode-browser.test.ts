import path from 'node:path';

import { test, expect } from '@playwright/test';
import { build } from 'vite';
let source: string;
test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'catalog-test-boundaries',
        enforce: 'pre',
        resolveId(id) {
          if (id === '@/utils' || id === '@/i18n') return '\0' + id;
          return undefined;
        },
        load(id) {
          if (id === '\0@/utils') return 'export const createPlugin=x=>x;';
          if (id === '\0@/i18n') return 'export const t=x=>x;';
          return undefined;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: {
        entry: path.resolve('src/plugins/audio-only-mode/index.ts'),
        name: 'CatalogPlugin',
        formats: ['iife'],
      },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!('output' in output)) throw Error('Expected a completed bundle');
  source = output.output
    .filter((item) => item.type === 'chunk')
    .map((item) => item.code)
    .join('\n');
});

test('native browser renderer readiness replacement, stop and late config resolution release ownership', async ({
  page,
}) => {
  await page.setContent('<div id="queue"></div>');
  await page.addScriptTag({ content: source });
  const result = await page.evaluate(async () => {
    const win = window as unknown as {
        CatalogPlugin: {
          config: { enabled: boolean };
          renderer: {
            onPlayerApiReady(
              api: unknown,
              context: { getConfig: () => Promise<unknown> },
            ): Promise<void>;
            stop(): void;
            onConfigChange(config: { enabled: boolean }): void;
          };
        };
      },
      plugin = win.CatalogPlugin,
      renderer = plugin.renderer;
    const listeners = new Map<string, Set<() => void>>();
    let calls = 0;
    const api = Object.assign(document.createElement('div'), {
      getVideoData: () => ({ video_id: 'official001' }),
      getPlayerResponse: () => ({
        videoDetails: {
          videoId: 'official001',
          musicVideoType: 'MUSIC_VIDEO_TYPE_OMV',
        },
      }),
      getCurrentTime: () => 0,
      getPlayerState: () => 1,
      loadVideoById: () => calls++,
      addEventListener: (name: string, fn: () => void) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(fn);
      },
      removeEventListener: (name: string, fn: () => void) =>
        listeners.get(name)?.delete(fn),
    });
    api.id = 'movie_player';
    document.body.append(api);
    const count = () =>
      [...listeners.values()].reduce((n, set) => n + set.size, 0);
    const context = { getConfig: () => Promise.resolve({ enabled: true }) };
    await renderer.onPlayerApiReady(api, context);
    const first = count();
    const stale = [...listeners.get('onStateChange')!][0];
    await renderer.onPlayerApiReady(api, context);
    const repeated = count();
    renderer.stop();
    stale();
    const stopped = count();
    let resolve!: (x: unknown) => void;
    const pending = renderer.onPlayerApiReady(api, {
      getConfig: () => new Promise((done) => (resolve = done)),
    });
    renderer.stop();
    resolve({ enabled: true });
    await pending;
    const late = count();
    await renderer.onPlayerApiReady(api, context);
    renderer.onConfigChange({ enabled: false });
    return {
      defaultOff: plugin.config.enabled,
      first,
      repeated,
      stopped,
      late,
      disabled: count(),
      calls,
    };
  });
  expect(result).toEqual({
    defaultOff: false,
    first: 2,
    repeated: 2,
    stopped: 0,
    late: 0,
    disabled: 0,
    calls: 0,
  });
});
