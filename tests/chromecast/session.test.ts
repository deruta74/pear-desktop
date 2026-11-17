import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { expect, test } from '@playwright/test';
import { transformWithOxc } from 'vite';

async function fixture() {
  const key = `session_${crypto.randomUUID()}`;
  const channels = new Map<
    string,
    EventEmitter & { send: (data: unknown) => void }
  >();
  const outbound: unknown[] = [];
  const timers = new Map<object, () => void>();
  class Client extends EventEmitter {
    connect(_receiver: unknown, ready: () => void) {
      ready();
    }
    createChannel(_source: string, _dest: string, ns: string) {
      const channel = Object.assign(new EventEmitter(), {
        send: (data: unknown) => outbound.push(data),
      });
      channels.set(ns, channel);
      return channel;
    }
    close() {}
  }
  const state = {
    EventEmitter,
    Client,
    setTimeout: (fn: () => void) => {
      const key = {};
      timers.set(key, fn);
      return key;
    },
    clearTimeout: (key: object) => timers.delete(key),
    setInterval: (fn: () => void) => {
      const key = {};
      timers.set(key, fn);
      return key;
    },
    clearInterval: (key: object) => timers.delete(key),
  };
  (globalThis as any)[key] = state;
  const raw = await readFile(
    new URL('../../src/plugins/chromecast/session.ts', import.meta.url),
    'utf8',
  );
  const code = (
    await transformWithOxc(
      raw.replace(/^import[\s\S]*?;\n/gm, ''),
      'session.ts',
    )
  ).code;
  const prefix = `const {${Object.keys(state).join(',')}}=globalThis[${JSON.stringify(key)}];\n`;
  const { CastDeviceSession } = await import(
    `data:text/javascript;base64,${Buffer.from(prefix + code).toString('base64')}`
  );
  const session = new CastDeviceSession('Speaker', 'CC1AD845');
  const pending = session.connect({ host: '192.168.1.20', port: 8009 });
  const status = (sessionId = 'ours', transportId = 'transport') =>
    channels.get('urn:x-cast:com.google.cast.receiver')!.emit('message', {
      type: 'RECEIVER_STATUS',
      status: {
        applications: [{ appId: 'CC1AD845', sessionId, transportId }],
      },
    });
  status();
  await pending;
  return {
    session,
    channels,
    status,
    timers,
    outbound,
    close: () => {
      session.leave();
      delete (globalThis as any)[key];
    },
  };
}

test('Cast transport ends ownership when receiver replaces the app session', async () => {
  const f = await fixture();
  try {
    f.status('someone-else', 'new-transport');
    expect(f.session.snapshot().status).toBe('stopped');
    expect(f.timers.size).toBe(0);
    expect(() =>
      f.session.sendMessage('urn:x-cast:com.google.cast.media', {
        type: 'GET_STATUS',
      }),
    ).toThrow();
  } finally {
    f.close();
  }
});

test('Cast ignores late receiver callbacks and releases stop probes on disconnect', async () => {
  const f = await fixture();
  try {
    const pending = f.session.stop();
    const rejected = expect(pending).rejects.toThrow('before stop');
    f.session.leave();
    await rejected;
    expect(f.timers.size).toBe(0);
    const ended = f.session.snapshot();
    const writes = f.outbound.length;
    f.status('late', 'late-transport');
    expect(f.session.snapshot()).toEqual(ended);
    expect(f.outbound).toHaveLength(writes);
    expect(() =>
      f.session.sendMessage('urn:x-cast:com.google.cast.media', {}),
    ).toThrow();
  } finally {
    f.close();
  }
});
