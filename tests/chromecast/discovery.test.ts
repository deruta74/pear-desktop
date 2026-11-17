import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { expect, test } from '@playwright/test';
import { transformWithOxc } from 'vite';
import * as endpoint from '../../src/plugins/chromecast/endpoint';
import * as receivers from '../../src/plugins/chromecast/receivers';

test('Cast discovery drops invalid services, caps receivers and ignores stopped callbacks', async () => {
  const browser = Object.assign(new EventEmitter(), {
    start() {},
    stop() {},
    update() {},
  });
  const mdns = new EventEmitter();
  const timers = new Map<object, () => void>();
  let list: any[] = [];
  let updates = 0;
  class Bonjour {
    server = { mdns };
    find() {
      return browser;
    }
    destroy() {}
  }
  const key = `discovery_${crypto.randomUUID()}`;
  const state = {
    Bonjour,
    ...endpoint,
    ...receivers,
    setTimeout: (fn: () => void) => {
      const id = {};
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id: object) => timers.delete(id),
  };
  (globalThis as any)[key] = state;
  const raw = await readFile(
    new URL('../../src/plugins/chromecast/discovery.ts', import.meta.url),
    'utf8',
  );
  const code = (
    await transformWithOxc(
      raw.replace(/^import[\s\S]*?;\n/gm, ''),
      'discovery.ts',
    )
  ).code;
  const prefix = `const {${Object.keys(state).join(',')}}=globalThis[${JSON.stringify(key)}];\n`;
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(prefix + code).toString('base64')}`
  );
  const stop = module.startCastDiscovery((next: any[]) => {
    list = next;
    updates++;
  });
  try {
    const service = {
      addresses: ['192.168.1.20'],
      port: 8009,
      txt: { id: 'speaker', fn: 'Speaker\u0000' },
    };
    for (const invalid of [
      { ...service, port: -1 },
      { ...service, addresses: ['127.0.0.1'] },
      { ...service, port: '8009' },
    ])
      browser.emit('up', invalid);
    expect(list).toEqual([]);
    for (let i = 0; i < 100; i++)
      browser.emit('up', {
        ...service,
        txt: { id: `speaker-${i}`, fn: 'Speaker\u0000' },
      });
    expect(list).toHaveLength(24);
    expect(list[0].name).toBe('Speaker');
    stop();
    const count = updates;
    browser.emit('up', service);
    browser.emit('down', service);
    expect(updates).toBe(count);
    expect(timers.size).toBe(0);
  } finally {
    stop();
    delete (globalThis as any)[key];
  }
});
