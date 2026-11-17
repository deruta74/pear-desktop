import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';
import { transformWithOxc } from 'vite';

test('Cast plugin retires pending starts before stop or a replacement start', async () => {
  const key = `lifecycle_${crypto.randomUUID()}`;
  const imports: Array<(value: unknown) => void> = [];
  const services: FakeBackend[] = [];
  class FakeBackend {
    started = false;
    stopped = false;
    constructor(_window: unknown) {
      services.push(this);
    }
    start() {
      this.started = true;
    }
    stop() {
      this.stopped = true;
    }
  }
  const state = {
    createPlugin: (value: unknown) => value,
    t: (key: string) => key,
    loadBackend: () => new Promise((resolve) => imports.push(resolve)),
  };
  (globalThis as any)[key] = state;
  try {
    const raw = await readFile(
      new URL('../../src/plugins/chromecast/index.ts', import.meta.url),
      'utf8',
    );
    const source = raw
      .replace(/^import[\s\S]*?;\n/gm, '')
      .replace("await import('./backend')", 'await loadBackend()');
    const code = (await transformWithOxc(source, 'index.ts')).code;
    const prefix = `const {${Object.keys(state).join(',')}}=globalThis[${JSON.stringify(key)}];\n`;
    const { default: plugin } = await import(
      `data:text/javascript;base64,${Buffer.from(prefix + code).toString('base64')}`
    );
    const backend = plugin.backend;
    const first = backend.start({ window: {} });
    backend.stop();
    const replacement = backend.start({ window: {} });
    imports[1]({ CastBackend: FakeBackend });
    await replacement;
    imports[0]({ CastBackend: FakeBackend });
    await first;
    expect(services).toHaveLength(1);
    expect(services[0].started).toBe(true);
    expect(services[0].stopped).toBe(false);
    expect(backend.service).toBe(services[0]);
    backend.stop();
    expect(services[0].stopped).toBe(true);
    expect(backend.service).toBeNull();
    const abandoned = backend.start({ window: {} });
    backend.stop();
    imports[2]({ CastBackend: FakeBackend });
    await abandoned;
    expect(services).toHaveLength(1);
    expect(backend.service).toBeNull();
  } finally {
    delete (globalThis as any)[key];
  }
});
