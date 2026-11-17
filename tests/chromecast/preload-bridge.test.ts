import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { transformWithOxc } from 'vite';
import * as endpoint from '../../src/plugins/chromecast/endpoint';

test('Cast preload bounds methods, reserves raw IPC and retires page callbacks', async () => {
  const raw = await readFile(
    new URL('../../src/plugins/chromecast/preload-bridge.ts', import.meta.url),
    'utf8',
  );
  const key = `bridge_${crypto.randomUUID()}`;
  let bridge: any;
  let onEvent: any;
  let pagehide: any;
  let removed = false;
  const calls: unknown[] = [];
  (globalThis as any)[key] = {
    ...endpoint,
    contextBridge: {
      exposeInMainWorld: (_name: string, api: any) => {
        bridge = api;
      },
    },
    ipcRenderer: {
      on: (_name: string, fn: any) => {
        onEvent = fn;
      },
      removeListener: () => {
        removed = true;
      },
      invoke: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve();
      },
    },
    webFrame: { executeJavaScriptInIsolatedWorld: () => Promise.resolve() },
    window: {
      addEventListener: (_name: string, fn: any) => {
        pagehide = fn;
      },
    },
    pageApiSource: '',
  };
  try {
    const code = (
      await transformWithOxc(
        raw.replace(/^import[\s\S]*?;\n/gm, ''),
        'preload-bridge.ts',
      )
    ).code;
    const keys = Object.keys((globalThis as any)[key]);
    const prefix = `const {${keys.join(',')}}=globalThis[${JSON.stringify(key)}];\n`;
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(prefix + code).toString('base64')}`
    );
    module.setupCastBridge();
    expect(bridge.invoke).toBeUndefined();
    for (const run of [
      () =>
        bridge.sendMessage(
          'cast-1-1',
          'urn:x-cast:com.google.cast.receiver',
          '{}',
        ),
      () => bridge.setMuted('cast-1-1', 'false'),
      () => bridge.setVolume('cast-1-1', NaN),
      () => bridge.loadMedia('cast-1-1', { x: 'x'.repeat(1_000_001) }),
    ])
      await expect(Promise.resolve().then(run)).rejects.toThrow();
    expect(calls).toEqual([]);
    let delivered = 0;
    bridge.onEvent(() => delivered++);
    onEvent({}, { type: 'stopped', handle: 'cast-1-1' });
    expect(delivered).toBe(1);
    pagehide();
    onEvent({}, { type: 'stopped', handle: 'cast-1-1' });
    expect(delivered).toBe(1);
    expect(removed).toBe(true);
    await expect(bridge.leave('cast-1-1')).rejects.toThrow();
    const preload = await readFile(
      new URL('../../src/preload.ts', import.meta.url),
      'utf8',
    );
    expect(preload).toContain("channel.startsWith('peard:cast:')");
    expect(preload).toContain('chromecast?.enabled === true');
  } finally {
    delete (globalThis as any)[key];
  }
});
