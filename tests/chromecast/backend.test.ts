import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { expect, test } from '@playwright/test';
import { transformWithOxc } from 'vite';
import * as endpoint from '../../src/plugins/chromecast/endpoint';
import * as receivers from '../../src/plugins/chromecast/receivers';
import * as autoCast from '../../src/plugins/chromecast/auto-cast';

async function fixture() {
  const key = `cast_${crypto.randomUUID()}`;
  const handlers = new Map<string, (...args: any[]) => any>();
  const sent: unknown[] = [];
  const settings: Record<string, unknown> = { enabled: true };
  const frame = { url: 'https://music.youtube.com/' };
  const contents = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: frame,
    getURL: () => frame.url,
    isDestroyed: () => false,
    send: (...args: unknown[]) => sent.push(args),
  });
  const timers = new Map<object, () => void>();
  const sessions: FakeSession[] = [];
  class FakeSession extends EventEmitter {
    handle = `cast-1-${sessions.length + 1}`;
    ended = false;
    resolve!: () => void;
    actions: unknown[] = [];
    constructor(
      readonly name: string,
      readonly appId: string,
    ) {
      super();
      sessions.push(this);
    }
    snapshot() {
      return {
        handle: this.handle,
        appId: this.appId,
        status: 'connected',
        receiver: { name: this.name },
      };
    }
    connect() {
      return new Promise<void>((resolve) => {
        this.resolve = resolve;
      });
    }
    leave() {
      this.ended = true;
      this.emit('stopped', 'disconnected');
    }
    stop() {
      this.ended = true;
      this.emit('stopped', 'stopped');
      return Promise.resolve();
    }
    sendMessage(...args: unknown[]) {
      this.actions.push(args);
    }
    setVolumeLevel(...args: unknown[]) {
      this.actions.push(args);
    }
    setMuted(...args: unknown[]) {
      this.actions.push(args);
    }
    loadMedia(...args: unknown[]) {
      this.actions.push(args);
    }
    queueLoad(...args: unknown[]) {
      this.actions.push(args);
    }
  }
  const state = {
    ...endpoint,
    ...receivers,
    ...autoCast,
    CastDeviceSession: FakeSession,
    ipcMain: {
      handle: (name: string, fn: any) => handlers.set(name, fn),
      removeHandler: (name: string) => handlers.delete(name),
    },
    store: {
      get: () => settings,
      set: (path: string, value: unknown) => {
        settings[path.split('.').at(-1)!] = value;
      },
    },
    config: {
      get: () => 'https://music.youtube.com/',
      defaultConfig: { url: 'https://music.youtube.com/' },
    },
    t: (x: string) => x,
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    startCastDiscovery: (fn: any) => {
      state.discover = fn;
      return () => {};
    },
    discover: (_list: unknown[]) => {},
    setTimeout: (fn: () => void) => {
      const id = {};
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id: object) => timers.delete(id),
  };
  (globalThis as any)[key] = state;
  const raw = await readFile(
    new URL('../../src/plugins/chromecast/backend.ts', import.meta.url),
    'utf8',
  );
  const compiled = (
    await transformWithOxc(
      raw.replace(/^import[\s\S]*?;\n/gm, ''),
      'backend.ts',
    )
  ).code;
  const names = Object.keys(state).filter((name) => name !== 'discover');
  const prefix = `const {${names.join(',')}}=globalThis[${JSON.stringify(key)}];\n`;
  const { CastBackend } = await import(
    `data:text/javascript;base64,${Buffer.from(prefix + compiled).toString('base64')}`
  );
  const service = new CastBackend({ webContents: contents });
  service.start();
  const event = { sender: contents, senderFrame: frame };
  const invoke = (request: unknown, senderEvent = event) =>
    handlers.get('peard:cast:session')!(senderEvent, request);
  const receiver = {
    id: 'speaker',
    host: '192.168.1.20',
    port: 8009,
    name: 'Speaker',
  };
  state.discover([receiver]);
  return {
    service,
    invoke,
    settings,
    event,
    state,
    sessions,
    sent,
    timers,
    receiver,
    connect: async () => {
      const pending = invoke({
        op: 'connect',
        receiverId: 'speaker',
        appId: 'CC1AD845',
      });
      sessions.at(-1)!.resolve();
      return pending;
    },
    close: () => {
      service.stop();
      delete (globalThis as any)[key];
    },
  };
}

test('Cast requires the owning main frame, explicit enablement and discovered identity', async () => {
  const f = await fixture();
  try {
    await expect(
      f.invoke({ op: 'connect', receiverId: 'speaker', appId: 'CC1AD845' }, {
        ...f.event,
        senderFrame: {},
      } as any),
    ).rejects.toThrow('sender');
    await expect(
      f.invoke({
        op: 'connect',
        receiverId: 'http://127.0.0.1',
        appId: 'CC1AD845',
      }),
    ).rejects.toThrow('receiver');
    await expect(
      f.invoke({ op: 'connect', receiverId: 'unknown', appId: 'CC1AD845' }),
    ).rejects.toThrow('unavailable');
    expect(f.sessions).toHaveLength(0);
    f.settings.enabled = false;
    await expect(
      f.invoke({ op: 'connect', receiverId: 'speaker', appId: 'CC1AD845' }),
    ).rejects.toThrow();
  } finally {
    f.close();
  }
});

test('Cast bounds requests and rejects transport control through app messages', async () => {
  const f = await fixture();
  try {
    const { handle } = await f.connect();
    for (const request of [
      {
        op: 'send',
        handle,
        namespace: 'urn:x-cast:com.google.cast.receiver',
        data: '{"type":"LAUNCH"}',
      },
      {
        op: 'send',
        handle,
        namespace: 'urn:x-cast:com.google.cast.media',
        data: 'x'.repeat(1_000_001),
      },
      { op: 'load', handle, request: { x: 'x'.repeat(1_000_001) } },
      { op: 'mute', handle, muted: 'false' },
      { op: 'arbitrary', handle },
      { op: 'volume', handle: 'cast-1-999', level: 1 },
    ])
      await expect(f.invoke(request)).rejects.toThrow();
    expect(f.sessions[0].actions).toEqual([]);
    await f.invoke({
      op: 'send',
      handle,
      namespace: 'urn:x-cast:com.google.cast.media',
      data: '{"type":"GET_STATUS"}',
    });
    expect(f.sessions[0].actions).toHaveLength(1);
  } finally {
    f.close();
  }
});

test('replacing or stopping Cast rejects late connection completion and stale events', async () => {
  const f = await fixture();
  try {
    const old = f.invoke({
      op: 'connect',
      receiverId: 'speaker',
      appId: 'CC1AD845',
    });
    const rejected = expect(old).rejects.toThrow();
    const next = f.connect();
    f.sessions[0].resolve();
    await rejected;
    await next;
    expect(f.sessions[0].ended).toBe(true);
    const count = f.sent.length;
    f.sessions[0].emit('message', 'urn:x-cast:com.google.cast.media', '{}');
    f.sessions[0].emit('stopped', 'stopped');
    expect(f.sent).toHaveLength(count);
    expect(f.settings.autoReconnectSuppressed).toBe(false);
    const pending = f.invoke({
      op: 'connect',
      receiverId: 'speaker',
      appId: 'CC1AD845',
    });
    const stopped = expect(pending).rejects.toThrow();
    f.service.stop();
    f.sessions.at(-1)!.resolve();
    await stopped;
    expect(f.sent).toHaveLength(count);
    expect(f.timers.size).toBe(0);
  } finally {
    f.close();
  }
});

test('explicit disconnect suppresses reconnect and reconnect attempts are bounded', async () => {
  const f = await fixture();
  try {
    const { handle } = await f.connect();
    f.settings.autoCastOnStartup = true;
    await f.invoke({ op: 'leave', handle });
    expect(f.settings.autoReconnectSuppressed).toBe(true);
    f.state.discover([f.receiver]);
    expect(f.sessions).toHaveLength(1);
    expect(f.timers.size).toBe(0);
    await f.connect();
    expect(f.settings.autoReconnectSuppressed).toBe(false);
    for (let i = 0; i < 10; i++) {
      f.sessions.at(-1)!.emit('stopped', 'disconnected');
      for (const [id, fn] of f.timers) {
        f.timers.delete(id);
        fn();
      }
      f.sessions.at(-1)!.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(f.sessions.length).toBeLessThanOrEqual(7);
  } finally {
    f.close();
  }
});

test('manual Cast receiver selection excludes automatic connection admission while pending', async () => {
  const f = await fixture();
  try {
    await f.connect();
    f.settings.autoCastOnStartup = true;
    const second = {
      ...f.receiver,
      id: 'second-speaker',
      host: '192.168.1.21',
    };
    f.state.discover([f.receiver, second]);
    const pending = f.invoke({
      op: 'connect',
      receiverId: second.id,
      appId: 'CC1AD845',
    });
    f.state.discover([f.receiver, second]);
    expect(f.sessions).toHaveLength(2);
    expect(f.sessions.filter((session) => !session.ended)).toHaveLength(1);
    f.sessions[1].resolve();
    const selected = await pending;
    expect(f.settings.lastReceiverId).toBe(second.id);
    f.state.discover([f.receiver, second]);
    expect(f.sessions).toHaveLength(2);
    await f.invoke({ op: 'volume', handle: selected.handle, level: 0.5 });
    expect(f.sessions[1].actions).toEqual([[0.5]]);
  } finally {
    f.close();
  }
});
