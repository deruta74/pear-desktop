import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test, expect } from '@playwright/test';
import { Window } from 'happy-dom';

// Run the actual renderer entry's startup and IPC hooks. Only native, style,
// translation and plugin-registry boundaries are replaced; no copied hook logic.
async function fixture(plugins: Record<string, any>) {
  const dom = new Window();
  dom.document.body.innerHTML = '<div id="movie_player"></div><video></video>';
  const handlers = new Map<string, (...args: any[]) => any>();
  const errors: unknown[][] = [];
  const traces: unknown[] = [];
  const contexts = new Map<string, object>();
  const key = `ready_${crypto.randomUUID()}`;
  const state = {
    dom,
    plugins,
    handlers,
    errors,
    traces,
    contexts,
    window: {
      electronIs: {
        osx: () => false,
        windows: () => false,
        linux: () => true,
        dev: () => false,
      },
      mainConfig: { get: () => undefined },
      ipcRenderer: {
        on: (id: string, fn: (...args: any[]) => any) => handlers.set(id, fn),
        send() {},
      },
    },
  };
  (globalThis as any)[key] = state;
  const raw = await readFile(
    new URL('../src/renderer.ts', import.meta.url),
    'utf8',
  );
  const actual = stripTypeScriptTypes(raw)
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace('initObserver().then(preload).then(main);', 'export { main };');
  const boundaries = `
const fixture=globalThis[${JSON.stringify(key)}];
const {window}=fixture; const document=fixture.dom.document;
const setTheme=()=>{}; const registerWindowDefaultTrustedTypePolicy=()=>{};
const i18t=(key,options)=>({key,options}); const LoggerPrefix='[YTMusic]';
const console={error:(...args)=>fixture.errors.push(args),trace:err=>fixture.traces.push(err)};
const startingPages={}; const setInterval=()=>0;
const createContext=id=>{if(!fixture.contexts.has(id))fixture.contexts.set(id,{id});return fixture.contexts.get(id)};
const getAllLoadedRendererPlugins=()=>fixture.plugins;
const getLoadedRendererPlugin=id=>fixture.plugins[id];
const loadAllRendererPlugins=async()=>{}; const forceLoadRendererPlugin=async()=>{};
const forceUnloadRendererPlugin=async()=>{};
class AudioContext {destination={};createMediaElementSource(){return {connect(){}}}}
`;
  const source = await import(
    `data:text/javascript;base64,${Buffer.from(boundaries + actual).toString('base64')}`
  );
  return {
    ...state,
    source,
    player: dom.document.querySelector('#movie_player'),
    close: async () => {
      delete (globalThis as any)[key];
      await dom.happyDOM.close();
    },
  };
}

for (const asynchronous of [false, true]) {
  test(`startup continues after a ${asynchronous ? 'rejected' : 'throwing'} plugin and preserves hook arguments`, async () => {
    const failure = new Error('fixture failure');
    const calls: unknown[] = [];
    const broken = {
      onPlayerApiReady() {
        if (asynchronous) return Promise.reject(failure);
        throw failure;
      },
    };
    const healthy = {
      onPlayerApiReady(this: unknown, api: unknown, context: unknown) {
        calls.push([this, api, context]);
      },
    };
    let functionCalls = 0;
    const fn = Object.assign(() => functionCalls++, {
      onPlayerApiReady: () => functionCalls++,
    });
    const f = await fixture({
      broken: { renderer: broken },
      healthy: { renderer: healthy },
      final: { renderer: healthy },
      function: { renderer: fn },
    });
    try {
      await expect(f.source.main()).resolves.toBeUndefined();
      expect(calls).toEqual([
        [healthy, f.player, f.contexts.get('healthy')],
        [healthy, f.player, f.contexts.get('final')],
      ]);
      expect(functionCalls).toBe(0);
      expect(f.errors).toHaveLength(1);
      expect(f.traces).toEqual([failure]);
      expect(f.errors[0][1]).toEqual({
        key: 'common.console.plugins.execute-failed',
        options: { pluginName: 'broken', contextName: 'onPlayerApiReady' },
      });
    } finally {
      await f.close();
    }
  });
  test(`late enable isolates a ${asynchronous ? 'rejected' : 'throwing'} API-ready hook`, async () => {
    const calls: unknown[] = [];
    const failure = new Error('late failure');
    const f = await fixture({});
    const healthy = {
      onPlayerApiReady(this: unknown, api: unknown, context: unknown) {
        calls.push([this, api, context]);
      },
    };
    try {
      await f.source.main();
      f.plugins.broken = {
        renderer: {
          onPlayerApiReady() {
            if (asynchronous) return Promise.reject(failure);
            throw failure;
          },
        },
      };
      f.plugins.healthy = { renderer: healthy };
      const enable = f.handlers.get('plugin:enable')!;
      await expect(enable({}, 'broken')).resolves.toBeUndefined();
      await enable({}, 'healthy');
      expect(calls).toEqual([[healthy, f.player, f.contexts.get('healthy')]]);
      expect(f.errors).toHaveLength(1);
      expect(f.traces).toEqual([failure]);
    } finally {
      await f.close();
    }
  });
}
