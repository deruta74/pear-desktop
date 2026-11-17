import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import { test, expect } from '@playwright/test';
import { Hono } from 'hono';
import { transformWithOxc } from 'vite';

async function fixture() {
  const provider = await readFile(
    new URL('../src/providers/song-info.ts', import.meta.url),
    'utf8',
  );
  const enumSource = (
    await transformWithOxc(
      provider.match(/export enum MediaType \{[\s\S]*?\n\}/)![0],
      'media-type.ts',
    )
  ).code;
  const { MediaType } = await import(
    `data:text/javascript;base64,${Buffer.from(enumSource).toString('base64')}`
  );
  const key = `amuse_${crypto.randomUUID()}`;
  const ipcMain = new EventEmitter();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  Object.assign(ipcMain, {
    handle: (key: string, handler: (...args: any[]) => unknown) =>
      handlers.set(key, handler),
    removeHandler: (key: string) => handlers.delete(key),
  });
  const frame = {};
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame });
  const messages: string[] = [];
  const context = {
    window: { webContents: contents },
    ipc: {
      send: (channel: string) => messages.push(channel),
    },
  };
  const state = {
    Hono,
    ipcMain,
    callback: undefined as any,
    current: undefined as any,
    now: 1000,
  };
  (globalThis as any)[key] = state;
  const raw = await readFile(
    new URL('../src/plugins/amuse/backend.ts', import.meta.url),
    'utf8',
  );
  const actual = stripTypeScriptTypes(raw).replace(/^import[\s\S]*?;\n/gm, '');
  const boundaries = `const fixture=globalThis[${JSON.stringify(key)}];
    const Hono=fixture.Hono; const ipcMain=fixture.ipcMain; const cors=()=>async(c,next)=>next();
    const randomUUID=()=>globalThis.crypto.randomUUID();
    const Date={now:()=>fixture.now};
    const serve=()=>({close(){}}); const t=key=>key; const createBackend=x=>x;
    const MediaType=${JSON.stringify(MediaType)};
    const registerCallback=(fn, options)=>{fixture.callback=fn;if(options?.replayCurrent && fixture.current)fn(fixture.current,'video');return()=>{fixture.callback=undefined}};`;
  const source = await import(
    `data:text/javascript;base64,${Buffer.from(boundaries + actual).toString('base64')}`
  );
  source.default.start(context);
  return {
    MediaType,
    set: (info: any, event = 'video') => {
      state.current = info;
      state.callback(info, event);
    },
    tick: (at: number) => {
      state.now = at;
    },
    ready: () =>
      handlers.get('peard:amuse-player-ready')?.({
        sender: contents,
        senderFrame: frame,
      }),
    ad: (token: unknown, value: unknown, native = true) =>
      ipcMain.emit(
        'peard:amuse-ad-state',
        { sender: contents, senderFrame: native ? frame : {} },
        token,
        value,
      ),
    messages,
    stop: () => source.default.stop(),
    restart: () => source.default.start(context),
    subscriptionCount: () => ipcMain.listenerCount('peard:amuse-ad-state'),
    hasSongSubscription: () => Boolean(state.callback),
    query: async (route = '/query') =>
      (await source.default.app.request(route)).json(),
    close: () => {
      source.default.stop();
      delete (globalThis as any)[key];
    },
  };
}

test('Amuse exposes the full empty 6K Labs contract on both routes', async () => {
  const f = await fixture();
  try {
    const value = await f.query();
    expect(value).toEqual({
      apiVersion: 2,
      player: {
        hasSong: false,
        isPaused: true,
        volumePercent: 0,
        seekbarCurrentPosition: 0,
        seekbarCurrentPositionHuman: '0:00',
        positionUpdatedAt: 0,
        statePercent: 0,
        likeStatus: 'INDIFFERENT',
        repeatType: 'NONE',
      },
      track: {
        author: '',
        title: '',
        album: '',
        cover: '',
        duration: 0,
        durationHuman: '0:00',
        url: '',
        id: '',
        isVideo: false,
        isAdvertisement: false,
        inLibrary: false,
        mediaType: '',
        playlistId: '',
      },
    });
    expect(await f.query('/api')).toEqual(value);
  } finally {
    f.close();
  }
});

test('Amuse timestamps real position updates and retires its subscriptions', async () => {
  const f = await fixture();
  try {
    const token = f.ready();
    expect(f.messages).toContain('peard:setup-time-changed-listener');
    const song = {
      artist: 'Artist',
      title: 'Title',
      videoId: 'id',
      elapsedSeconds: 0,
      playlistId: 'RD-tracks',
      mediaType: f.MediaType.Audio,
    };
    f.set(song);
    f.tick(2000);
    expect((await f.query()).player.positionUpdatedAt).toBe(1000);
    song.elapsedSeconds = 1;
    f.set(song, 'time');
    f.tick(3000);
    const value = await f.query();
    expect(value.player).toMatchObject({
      seekbarCurrentPosition: 1,
      positionUpdatedAt: 2000,
    });
    expect(value.track).toMatchObject({
      mediaType: 'AUDIO',
      playlistId: 'RD-tracks',
    });
    f.ad(token, true, false);
    expect((await f.query()).track.isAdvertisement).toBe(false);
    f.ad(token, true);
    expect((await f.query()).track.isAdvertisement).toBe(true);
    f.ad(token, false);
    expect((await f.query()).track.isAdvertisement).toBe(false);
    f.restart();
    expect(f.subscriptionCount()).toBe(1);
    const nextToken = f.ready();
    expect(nextToken).not.toBe(token);
    expect((await f.query()).player.positionUpdatedAt).toBe(0);
    f.ad(token, true);
    expect((await f.query()).track.isAdvertisement).toBe(false);
    f.ad(nextToken, true);
    expect((await f.query()).track.isAdvertisement).toBe(true);
    f.stop();
    expect(f.subscriptionCount()).toBe(0);
    expect(f.hasSongSubscription()).toBe(false);
  } finally {
    f.close();
  }
});

test('Amuse supplies real metadata and finite bounded progress', async () => {
  const f = await fixture();
  try {
    f.set({
      artist: 'Artist',
      title: 'Title',
      album: 'Album',
      videoId: 'id',
      songDuration: 125.9,
      elapsedSeconds: 66.9,
      mediaType: f.MediaType.Audio,
    });
    const value = await f.query();
    expect(value.player).toMatchObject({
      hasSong: true,
      seekbarCurrentPosition: 66,
      seekbarCurrentPositionHuman: '1:06',
      statePercent: 53,
    });
    expect(value.track).toMatchObject({
      album: 'Album',
      duration: 125,
      durationHuman: '2:05',
      isVideo: false,
    });
    f.set({
      artist: 'Artist',
      title: 'Title',
      songDuration: 5,
      elapsedSeconds: 999,
      mediaType: f.MediaType.UserGeneratedContent,
    });
    expect((await f.query()).player.statePercent).toBe(100);
    f.set({
      artist: 'Artist',
      title: 'Title',
      songDuration: NaN,
      elapsedSeconds: -Infinity,
    });
    expect((await f.query()).player.seekbarCurrentPositionHuman).toBe('0:00');
    expect((await f.query()).track.duration).toBe(0);
  } finally {
    f.close();
  }
});

test('Amuse recognizes the actual official music video enum as video', async () => {
  const f = await fixture();
  try {
    f.set({
      artist: 'Artist',
      title: 'Title',
      videoId: 'id',
      mediaType: f.MediaType.OriginalMusicVideo,
    });
    expect((await f.query()).track.isVideo).toBe(true);
  } finally {
    f.close();
  }
});

test('Amuse reports replacement player ads and stops old renderer delivery', async ({
  page,
}) => {
  const raw = await readFile(
    new URL('../src/plugins/amuse/renderer.ts', import.meta.url),
    'utf8',
  );
  const actual = stripTypeScriptTypes(raw)
    .replace(/^import .*;\n/gm, '')
    .replace('export const renderer', 'window.amuseRenderer');
  await page.setContent(
    '<ytmusic-app><div id="movie_player"></div></ytmusic-app>',
  );
  await page.addScriptTag({ content: 'const createRenderer=x=>x;\n' + actual });
  await page.evaluate(async () => {
    const fixture = window as any;
    fixture.reports = [];
    const player = document.querySelector('#movie_player')!;
    fixture.amuseRenderer.onPlayerApiReady(player, {
      ipc: {
        invoke: async () => 'lease-1',
        send: (...args: unknown[]) => fixture.reports.push(args),
      },
    });
    await Promise.resolve();
    const replacement = document.createElement('div');
    replacement.id = 'movie_player';
    replacement.className = 'ad-showing';
    player.replaceWith(replacement);
  });
  const reports = () => page.evaluate(() => (window as any).reports);
  await expect.poll(reports).toEqual([
    ['peard:amuse-ad-state', 'lease-1', false],
    ['peard:amuse-ad-state', 'lease-1', true],
  ]);
  await page.evaluate(() => {
    const player = document.querySelector('#movie_player')! as Element & {
      getAdState: () => number;
    };
    player.getAdState = () => 0;
    player.classList.remove('ad-showing');
  });
  await expect
    .poll(async () => (await reports()).at(-1))
    .toEqual(['peard:amuse-ad-state', 'lease-1', false]);
  await page.evaluate(() => {
    const player = document.querySelector('#movie_player')! as Element & {
      getAdState: () => number;
    };
    player.getAdState = () => 1;
    player.dispatchEvent(new Event('onStateChange'));
  });
  await expect
    .poll(async () => (await reports()).at(-1))
    .toEqual(['peard:amuse-ad-state', 'lease-1', true]);
  await page.evaluate(async () => {
    const fixture = window as any;
    fixture.amuseRenderer.stop();
    const player = document.querySelector('#movie_player')!;
    player.dispatchEvent(new Event('onStateChange'));
    player.classList.add('ad-showing');
    await Promise.resolve();
  });
  expect(await reports()).toHaveLength(4);
});
