import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('./iframe-player.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const first = 'jNQXAC9IVRw';
const second = 'M7lc1UVf-VE';

function wrapper({ playlist = false } = {}) {
  const url = 'https://wrapper.test/iframe-player.html';
  const window = { origin: 'https://wrapper.test' };
  const frame = {
    src: playlist ? 'https://www.youtube.com/embed?listType=playlist' : `https://www.youtube.com/embed/${first}`,
    isConnected: true,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 450, bottom: 300, width: 450, height: 300 }),
  };
  const document = {
    URL: url,
    baseURI: url,
    documentElement: { dataset: { wrapperUrl: url } },
    visibilityState: 'visible',
    getElementById: () => frame,
    addEventListener() {},
  };
  let handlers;
  let actualState = -1;
  let id = first;
  let plays = 0;
  const seeks = [];
  const yt = {
    getVideoUrl: () => `https://www.youtube.com/watch?v=${id}`,
    getPlayerState: () => actualState,
    getDuration: () => 20,
    getCurrentTime: () => actualState === 0 ? 20 : 1,
    getIframe: () => frame,
    playVideo: () => { plays += 1; },
    seekTo: (position) => { seeks.push(position); },
  };
  runInNewContext(script, {
    URL, self: window, top: window, document, window, innerWidth: 450, innerHeight: 300,
    YT: { Player: function (_frame, { events }) { handlers = events; return yt; } },
  });
  window.onYouTubeIframeAPIReady();
  return {
    frame, document,
    ready: () => handlers.onReady({ target: yt }),
    change: (data, { official = data, video = first } = {}) => {
      actualState = official;
      id = video;
      handlers.onStateChange({ data });
    },
    blocked: () => handlers.onAutoplayBlocked(),
    player: window.pearIframePlayer,
    plays: () => plays,
    seeks,
  };
}

test('the inline IFrame script is allowed by its content security policy', () => {
  const hash = createHash('sha256').update(script).digest('base64');
  assert.ok(html.includes(`script-src 'sha256-${hash}'`));
});

test('repeat track accepts only the observed end of the exact video and only once', () => {
  const view = wrapper();
  const { player } = view;
  player.repeatTrack(first, 1);
  view.ready();
  player.repeatTrack(first, 1);
  assert.equal(view.plays(), 0);

  view.change(1);
  const firstCycle = player.snapshot().repeatCycle;
  assert.ok(firstCycle > 0);
  player.repeatTrack(first, firstCycle);
  view.change(0);
  player.repeatTrack(first, firstCycle);
  assert.equal(view.plays(), 0, 'an end must be observed before dispatch');
  assert.equal(player.snapshot().repeatCycle, firstCycle);
  player.repeatTrack(second, firstCycle);
  player.repeatTrack(first, firstCycle + 1);
  assert.equal(view.plays(), 0);
  player.repeatTrack(first, firstCycle);
  player.repeatTrack(first, firstCycle);
  assert.equal(view.plays(), 1);

  view.change(1, { official: 0 });
  assert.equal(player.snapshot().repeatCycle, null);
  view.change(0);
  player.repeatTrack(first, firstCycle);
  assert.equal(view.plays(), 1);

  view.change(1);
  const secondCycle = player.snapshot().repeatCycle;
  assert.ok(secondCycle > firstCycle);
  view.change(0);
  assert.equal(player.snapshot().repeatCycle, secondCycle);
  player.repeatTrack(first, firstCycle);
  assert.equal(view.plays(), 1);
  player.repeatTrack(first, secondCycle);
  assert.equal(view.plays(), 2);
});

test('repeat track rejects hidden and changed frames, changed playback, blocks, and playlists', () => {
  const playing = wrapper();
  playing.ready();
  playing.change(1);
  const cycle = playing.player.snapshot().repeatCycle;
  playing.change(0);
  playing.player.snapshot();
  playing.document.visibilityState = 'hidden';
  playing.player.repeatTrack(first, cycle);
  playing.document.visibilityState = 'visible';
  const src = playing.frame.src;
  playing.frame.src = 'https://www.youtube.com/embed/M7lc1UVf-VE';
  playing.player.repeatTrack(first, cycle);
  playing.frame.src = src;
  playing.change(0, { video: second });
  playing.player.repeatTrack(first, cycle);
  playing.change(0);
  playing.blocked();
  playing.player.repeatTrack(first, cycle);
  assert.equal(playing.plays(), 0);

  const playlist = wrapper({ playlist: true });
  playlist.ready();
  playlist.change(1);
  assert.equal(playlist.player.snapshot().repeatCycle, null);
  playlist.change(0);
  playlist.player.repeatTrack(first, 1);
  assert.equal(playlist.plays(), 0);
});

for (const pollFirstEnd of [true, false]) {
  test(`repeat track expires the old cycle when a subsequent run ends between polls (first end polled: ${pollFirstEnd})`, () => {
    const view = wrapper();
    const { player } = view;
    view.ready();
    view.change(1);
    const oldCycle = player.snapshot().repeatCycle;
    view.change(0);
    if (pollFirstEnd) assert.equal(player.snapshot().repeatCycle, oldCycle);
    view.change(1);
    view.change(0);

    if (pollFirstEnd) {
      player.repeatTrack(first, oldCycle);
      assert.equal(view.plays(), 0, 'the delayed command must expire before the next poll');
    }
    assert.equal(player.snapshot().repeatCycle, null);
    player.repeatTrack(first, oldCycle);
    assert.equal(view.plays(), 0);

    view.change(1);
    const freshCycle = player.snapshot().repeatCycle;
    assert.ok(freshCycle > oldCycle);
    view.change(0);
    assert.equal(player.snapshot().repeatCycle, freshCycle);
    player.repeatTrack(first, freshCycle);
    assert.equal(view.plays(), 1);
  });
}

test('a seek after ending expires the repeat cycle before the IFrame acknowledges the seek', () => {
  const view = wrapper();
  const { player } = view;
  view.ready();
  view.change(1);
  const cycle = player.snapshot().repeatCycle;
  player.seek(7);
  assert.deepEqual(view.seeks, [7]);
  assert.equal(player.snapshot().repeatCycle, cycle, 'seeking while playing keeps the cycle');
  view.change(0);
  assert.equal(player.snapshot().repeatCycle, cycle);

  player.seek(3);
  assert.deepEqual(view.seeks, [7, 3]);
  player.repeatTrack(first, cycle);
  assert.equal(view.plays(), 0);
  assert.equal(player.snapshot().repeatCycle, null);
});

test('conflicting playback signals invalidate a terminal repeat cycle', () => {
  const view = wrapper();
  const { player } = view;
  view.ready();
  view.change(1);
  const cycle = player.snapshot().repeatCycle;
  view.change(0);
  assert.equal(player.snapshot().repeatCycle, cycle);

  view.change(1, { official: 0 });
  view.change(0);
  player.repeatTrack(first, cycle);
  assert.equal(view.plays(), 0);
});
