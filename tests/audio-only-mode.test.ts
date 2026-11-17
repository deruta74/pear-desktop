import { test, expect } from '@playwright/test';
import { Window } from 'happy-dom';

import { createAudioOnlyController } from '../src/plugins/audio-only-mode/controller';

function fixture() {
  const win = new Window();
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = '<div id="queue"></div>';
  let id = 'official001',
    type = 'MUSIC_VIDEO_TYPE_OMV',
    state = 1;
  const listeners = new Map<string, Set<() => void>>();
  const calls: unknown[][] = [];
  const atv = (videoId = 'catalog0001', kind = 'MUSIC_VIDEO_TYPE_ATV') => ({
    videoId,
    navigationEndpoint: {
      watchEndpoint: {
        videoId,
        watchEndpointMusicSupportedConfigs: {
          watchEndpointMusicConfig: { musicVideoType: kind },
        },
      },
    },
  });
  const original = {
    playlistPanelVideoWrapperRenderer: {
      primaryRenderer: {
        playlistPanelVideoRenderer: { videoId: id, selected: true },
      },
      counterpart: [
        { counterpartRenderer: { playlistPanelVideoRenderer: atv() } },
      ],
    },
  };
  const rows = [
    { playlistPanelVideoRenderer: { videoId: 'previous001' } },
    original,
    { playlistPanelVideoRenderer: { videoId: 'following01' } },
  ];
  let selectedItemIndex = 1;
  const store = {
    getState: () => ({ queue: { items: rows, selectedItemIndex } }),
  };
  (doc.querySelector('#queue') as unknown as { queue: unknown }).queue = {
    store: { store },
  };
  const api = Object.assign(doc.createElement('div'), {
    getVideoData: () => ({ video_id: id }),
    getPlayerResponse: () => ({
      videoDetails: { videoId: id, musicVideoType: type },
    }),
    getCurrentTime: (): number => 42.25,
    getPlayerState: () => state,
    loadVideoById: (...args: unknown[]) => {
      calls.push(['load', ...args]);
      emit();
    },
    cueVideoById: (...args: unknown[]) => {
      calls.push(['cue', ...args]);
      emit();
    },
    addEventListener: (key: string, fn: () => void) => {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(fn);
    },
    removeEventListener: (key: string, fn: () => void) =>
      listeners.get(key)?.delete(fn),
  });
  api.id = 'movie_player';
  doc.body.append(api);
  function emit() {
    for (const fn of listeners.get('onStateChange') ?? []) fn();
  }
  return {
    win,
    doc,
    api,
    calls,
    listeners,
    rows,
    original,
    atv,
    emit,
    store,
    identity(next: string, kind = type) {
      id = next;
      type = kind;
    },
    state(next: number) {
      state = next;
    },
    select(next: number) {
      selectedItemIndex = next;
    },
    start() {
      return createAudioOnlyController(api, doc);
    },
  };
}

test('verified catalog counterpart replaces eligible OMV once at current time without editing original queue', async () => {
  const f = fixture();
  const before = JSON.stringify(f.rows);
  const c = f.start();
  expect(f.calls).toEqual([['load', 'catalog0001', 42.25, 'default']]);
  f.emit();
  expect(f.calls).toHaveLength(1);
  expect(JSON.stringify(f.rows)).toBe(before);
  f.select(2);
  f.identity('following01');
  f.emit();
  expect(f.calls).toHaveLength(1);
  f.select(0);
  f.identity('previous001');
  f.emit();
  expect(f.calls).toHaveLength(1);
  c.dispose();
  await f.win.happyDOM.close();
});

test('paused owner cues replacement without starting playback; unsupported state fails closed', async () => {
  for (const state of [2, 0, 3, -1]) {
    const f = fixture();
    f.state(state);
    const c = f.start();
    expect(f.calls).toEqual(
      state === 2 ? [['cue', 'catalog0001', 42.25, 'default']] : [],
    );
    c.dispose();
    await f.win.happyDOM.close();
  }
});

test('ATV, UGC, unknown, same-ID, unverified or conflicting counterpart keep original', async () => {
  for (const kind of [
    'MUSIC_VIDEO_TYPE_ATV',
    'MUSIC_VIDEO_TYPE_UGC',
    'unknown',
    'same',
    'unverified',
    'conflicting',
  ]) {
    const f = fixture();
    if (kind.startsWith('MUSIC') || kind === 'unknown')
      f.identity('official001', kind);
    else
      f.original.playlistPanelVideoWrapperRenderer.counterpart = [
        {
          counterpartRenderer: {
            playlistPanelVideoRenderer: f.atv(
              kind === 'same' ? 'official001' : 'catalog0001',
              kind === 'unverified'
                ? 'MUSIC_VIDEO_TYPE_OMV'
                : 'MUSIC_VIDEO_TYPE_ATV',
            ),
          },
        },
      ];
    if (kind === 'conflicting')
      f.original.playlistPanelVideoWrapperRenderer.counterpart.push({
        counterpartRenderer: {
          playlistPanelVideoRenderer: f.atv('catalog0002'),
        },
      });
    const c = f.start();
    expect(f.calls, kind).toHaveLength(0);
    c.dispose();
    await f.win.happyDOM.close();
  }
});

test('late selected identity retries through readiness events but stale selection cannot replace newer song', async () => {
  const f = fixture();
  f.select(-1);
  const c = f.start();
  expect(f.calls).toHaveLength(0);
  f.select(1);
  f.emit();
  expect(f.calls).toHaveLength(1);
  c.dispose();
  await f.win.happyDOM.close();
  const g = fixture();
  g.select(-1);
  const d = g.start();
  g.identity('newer000001');
  g.select(1);
  g.emit();
  expect(g.calls).toHaveLength(0);
  d.dispose();
  await g.win.happyDOM.close();
});

test('disposed callbacks and replaced queue store cannot dispatch; listeners are released', async () => {
  const f = fixture();
  f.select(-1);
  const c = f.start();
  const saved = [...f.listeners.get('onStateChange')!][0];
  c.dispose();
  f.select(1);
  saved();
  expect(f.calls).toHaveLength(0);
  expect([...f.listeners.values()].every((set) => set.size === 0)).toBe(true);
  const d = f.start();
  expect(f.calls).toHaveLength(1);
  d.dispose();
  await f.win.happyDOM.close();
});

test('retry budget is finite and a new identity gets its own budget', async () => {
  const f = fixture();
  f.select(-1);
  const c = f.start();
  for (let i = 0; i < 20; i++) f.emit();
  f.select(1);
  f.emit();
  expect(f.calls).toHaveLength(0);
  c.dispose();
  await f.win.happyDOM.close();
});

test('store replacement or metadata getter retirement cannot authorize a stale dispatch', async () => {
  for (const mode of ['store', 'dispose']) {
    const f = fixture();
    f.select(-1);
    const c = f.start();
    f.select(1);
    f.api.getCurrentTime = () => {
      if (mode === 'dispose') c.dispose();
      else
        (
          f.doc.querySelector('#queue') as unknown as {
            queue: { store: { store: typeof f.store } };
          }
        ).queue.store.store = {
          getState: f.store.getState,
        };
      return 10;
    };
    f.emit();
    expect(f.calls).toHaveLength(0);
    c.dispose();
    await f.win.happyDOM.close();
  }
});

test('missing cue API leaves paused playback intact and pagehide releases listeners', async () => {
  const f = fixture();
  f.state(2);
  delete (f.api as Partial<typeof f.api>).cueVideoById;
  const c = f.start();
  expect(f.calls).toHaveLength(0);
  f.win.dispatchEvent(new f.win.Event('pagehide'));
  expect([...f.listeners.values()].every((set) => set.size === 0)).toBe(true);
  c.dispose();
  await f.win.happyDOM.close();
});

test('a fresh track identity gets a retry budget after previous exhaustion', async () => {
  const f = fixture();
  f.select(-1);
  const c = f.start();
  for (let i = 0; i < 20; i++) f.emit();
  f.identity('official002');
  f.original.playlistPanelVideoWrapperRenderer.primaryRenderer.playlistPanelVideoRenderer.videoId =
    'official002';
  f.select(1);
  f.emit();
  expect(f.calls).toHaveLength(1);
  c.dispose();
  await f.win.happyDOM.close();
});

test('an owner retired synchronously during construction cannot dispatch', async () => {
  const f = fixture();
  let current = true;
  f.api.getCurrentTime = () => {
    current = false;
    return 42;
  };
  const c = createAudioOnlyController(f.api, f.doc, () => current);
  expect(f.calls).toHaveLength(0);
  c.dispose();
  await f.win.happyDOM.close();
});

test('final selected-row getter cannot retire the owner and still dispatch', async () => {
  for (const retirement of ['dispose', 'replace-owner']) {
    const f = fixture();
    f.select(-1);
    let current = true;
    const c = createAudioOnlyController(f.api, f.doc, () => current);
    let reads = 0;
    Object.defineProperty(
      f.original.playlistPanelVideoWrapperRenderer.primaryRenderer
        .playlistPanelVideoRenderer,
      'videoId',
      {
        get() {
          if (++reads === 2) {
            if (retirement === 'dispose') c.dispose();
            else current = false;
          }
          return 'official001';
        },
      },
    );
    f.select(1);
    f.emit();
    expect(reads).toBe(2);
    expect(f.calls, retirement).toHaveLength(0);
    c.dispose();
    await f.win.happyDOM.close();
  }
});

test('replacing the DOM movie player with matching metadata retires the bound API', async () => {
  const f = fixture();
  f.select(-1);
  const element = f.api;
  const c = createAudioOnlyController(element, f.doc);
  const replacement = f.doc.createElement('div');
  replacement.id = 'movie_player';
  element.replaceWith(replacement);
  f.select(1);
  f.emit();
  expect(f.calls).toHaveLength(0);
  c.dispose();
  await f.win.happyDOM.close();
});

test('absent native movie player never authorizes a matching synthetic API', async () => {
  const f = fixture();
  f.api.remove();
  const c = f.start();
  expect(f.calls).toHaveLength(0);
  c.dispose();
  await f.win.happyDOM.close();
});
