import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, expect } from '@playwright/test';

async function localAudioPage(t, viewport = { width: 420, height: 475 }) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport });
  const assets = new Map([
    ['/', ['local-audio.html', 'text/html']],
    ['/style.css', ['style.css', 'text/css']],
    ['/local-audio.css', ['local-audio.css', 'text/css']],
    ['/local-audio.js', ['local-audio.js', 'text/javascript']],
    ['/local-eq.js', ['local-eq.js', 'text/javascript']],
  ]);
  const blocked = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const asset =
      url.origin === 'https://local-audio.test' && assets.get(url.pathname);
    if (!asset) {
      blocked.push(url.href);
      return route.abort();
    }
    const [file, contentType] = asset;
    const body = await readFile(new URL(file, import.meta.url)).catch(
      () => null,
    );
    return route.fulfill({
      status: body ? 200 : 404,
      contentType,
      body: body ?? 'Missing asset',
    });
  });
  await page.addInitScript(() => {
    window.commands = [];
    window.ipc = {
      postMessage: (message) => window.commands.push(JSON.parse(message)),
    };
  });
  await page.goto('https://local-audio.test/');
  const messages = () => page.evaluate(() => window.commands);
  const render = (state) =>
    page.evaluate((state) => window.renderPearLocal(state), state);
  return { page, messages, render, blocked };
}

test('requests a native folder picker and keeps playback controls active during the scan', async (t) => {
  const { page, messages, render } = await localAudioPage(t, {
    width: 290,
    height: 475,
  });
  const folder = page.getByRole('button', { name: 'Open folder' });
  const files = page.getByRole('button', { name: 'Open audio files' });
  const track = 'Current.wav';
  const transport = { positionMs: 1500, durationMs: 48000, playing: true };
  await render({ track, transport });
  await folder.click({ timeout: 1000 });
  expect((await messages()).at(-1)).toEqual({ type: 'open_folder' });
  await render({ track, transport, scanningFolder: true });
  await expect(page.getByRole('status')).toHaveText('Scanning audio folder…');
  await expect(folder).toBeFocused();
  const count = (await messages()).length;
  for (const button of [files, folder]) {
    await expect(button).toBeDisabled();
    await button.dispatchEvent('click');
  }
  expect(await messages()).toHaveLength(count);
  const pause = page.getByRole('button', { name: 'Pause', exact: true });
  await expect(pause).toBeEnabled();
  await expect(
    page.getByRole('slider', { name: 'Playback position' }),
  ).toHaveValue('1500');
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  const folderError = 'The selected folder contains no supported audio files.';
  await render({ track, transport, folderError });
  await expect(folder).toBeEnabled();
  await expect(page.getByRole('status')).toBeHidden();
  await expect(page.getByRole('alert')).toHaveText(folderError, {
    timeout: 1000,
  });
  const decodeError = 'Could not continue decoding the audio file.';
  await render({
    track,
    transport: { ...transport, error: decodeError },
    opening: true,
    folderError,
  });
  await expect(page.getByRole('alert')).toHaveText(
    `${decodeError} ${folderError}`,
  );
  await render({ track: 'Next.wav', transport, folderError });
  await expect(page.getByRole('alert')).toHaveText(folderError);
});

test('opens local audio files and sends playback and exact reverb settings to Rust', async (t) => {
  const { page, messages, render, blocked } = await localAudioPage(t);
  const open = page.getByRole('button', { name: 'Open audio files' });
  await render({ track: null, transport: null, error: null });
  await expect(
    page.getByRole('button', { name: 'Play', exact: true }),
  ).toBeHidden();
  await open.click();
  expect((await messages()).at(-1)).toEqual({ type: 'open' });
  await render({ track: null, transport: null, opening: true });
  await expect(open).toBeDisabled();
  await expect(page.getByRole('status')).toHaveText('Opening audio…');

  const track = '<strong>Local mix</strong>.wav';
  const transport = { positionMs: 0, durationMs: 48000, playing: false };
  await render({ track, transport, error: null });
  await expect(page.getByText(track, { exact: true })).toBeVisible();
  const play = page.getByRole('button', { name: 'Play', exact: true });
  await play.click();
  expect((await messages()).at(-1)).toEqual({
    type: 'set_playing',
    playing: true,
  });
  await render({
    track,
    transport: { ...transport, playing: true },
    error: null,
  });
  await expect(
    page.getByRole('button', { name: 'Pause', exact: true }),
  ).toBeFocused();
  await page.getByRole('heading', { name: 'Local audio', exact: true }).click();
  await page.keyboard.press('Space');
  expect((await messages()).at(-1)).toEqual({
    type: 'set_playing',
    playing: false,
  });
  await render({ track, transport });
  const beforeVolumeEdit = (await messages()).length;
  await page.getByRole('slider', { name: 'Volume' }).press('Space');
  expect(await messages()).toHaveLength(beforeVolumeEdit);

  const seek = page.getByRole('slider', { name: 'Playback position' });
  await seek.press('End');
  expect((await messages()).at(-1)).toEqual({
    type: 'seek',
    position_ms: 48000,
  });

  const cutoff = page.getByRole('spinbutton', { name: 'Low-pass (Hz)' });
  await render({
    track,
    transport,
    settings: {
      volume: 0.61,
      speed: 0.92,
      intensity: 0.25,
      highPassHz: 180,
      lowPassHz: 6300,
    },
  });
  await expect(cutoff).toHaveValue('6300');
  await expect(page.getByRole('slider', { name: 'Volume' })).toHaveValue('61');
  await cutoff.fill('6725');
  await cutoff.press('Tab');
  expect((await messages()).at(-1)).toEqual({
    type: 'set_reverb',
    intensity: 0.25,
    high_pass_hz: 180,
    low_pass_hz: 6725,
  });
  const beforeReset = (await messages()).length;
  await page.getByRole('button', { name: 'Reset effects' }).click();
  expect((await messages()).slice(beforeReset)).toEqual([
    { type: 'reset_effects' },
  ]);
  await render({
    track,
    transport,
    settings: {
      volume: 0.61,
      speed: 1,
      intensity: 0,
      highPassHz: 180,
      lowPassHz: 6500,
    },
  });
  await expect(cutoff).toHaveValue('6500');
  await expect(page.getByRole('slider', { name: 'Volume' })).toHaveValue('61');
  await render({
    track,
    transport,
    error: 'Could not open the selected audio file.',
  });
  await expect(page.getByRole('alert')).toContainText(
    'Could not open the selected audio file.',
  );
  await render({
    track,
    transport,
    equalizer: {
      enabled: false,
      layout: 'custom',
      preampDb: 0,
      autoPreamp: true,
      bands: [],
    },
  });
  await page.getByText('Equalizer', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Bands' }).selectOption('bands14');
  expect((await messages()).at(-1).profile.bands).toHaveLength(14);
  await page.getByRole('combobox', { name: 'Bands' }).selectOption('bands20');
  expect((await messages()).at(-1).profile.bands).toHaveLength(20);
  await page.getByRole('combobox', { name: 'Bands' }).selectOption('custom');
  const graph = page.locator('#eq-graph');
  await graph.click({ position: { x: 120, y: 50 } });
  const beforeDrag = (await messages()).at(-1).profile.bands[0];
  const box = await graph.boundingBox();
  await page.mouse.move(box.x + 120, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 36, { steps: 4 });
  await page.mouse.up();
  const dragged = (await messages()).at(-1).profile.bands[0];
  expect(dragged.frequencyHz).toBeGreaterThan(beforeDrag.frequencyHz);
  expect(dragged.gainDb).toBeGreaterThan(beforeDrag.gainDb);
  const q = page.getByRole('spinbutton', { name: 'Q for band 1' });
  await q.fill('1.37');
  await q.press('Tab');
  expect((await messages()).at(-1).profile.bands[0].q).toBe(1.37);
  const ack = (await messages()).at(-1);
  const frequency = page.getByRole('spinbutton', {
    name: 'Frequency for band 1 (Hz)',
  });
  await frequency.fill('250');
  await render({
    track,
    transport,
    equalizer: ack.profile,
    eqRevision: ack.revision,
  });
  await expect(frequency).toHaveValue('250');
  await frequency.press('Tab');
  expect((await messages()).at(-1).profile.bands[0].frequencyHz).toBe(250);
  await render({
    track,
    transport,
    equalizer: ack.profile,
    eqRevision: ack.revision,
  });
  await expect(frequency).toHaveValue('250');
  const name = page.getByRole('textbox', { name: 'Preset name' });
  await name.fill('Studio');
  await name.press('Enter');
  expect((await messages()).at(-1)).toEqual({
    type: 'save_equalizer_preset',
    name: 'Studio',
  });
  await render({ track, transport, presets: ['Studio'] });
  await expect(name).toHaveValue('');
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  expect((await messages()).at(-1)).toMatchObject({
    type: 'load_equalizer_preset',
    name: 'Studio',
  });
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText('Remove “Studio”?')).toBeVisible();
  await page
    .getByRole('button', { name: 'Remove preset', exact: true })
    .click();
  expect((await messages()).at(-1)).toEqual({
    type: 'delete_equalizer_preset',
    name: 'Studio',
  });
  await render({ track, transport, presets: [] });
  await expect(
    page.getByRole('button', { name: 'Load', exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    420,
  );
  expect(blocked).toEqual([]);
});

test('retains the scrollable queue, filename text, and keyboard focus across renders', async (t) => {
  const { page, messages, render, blocked } = await localAudioPage(t, {
    width: 290,
    height: 475,
  });
  const track = 'First.wav';
  const second = '<em>Wide & bright</em>.flac';
  const last = `${'Long'.repeat(50)}.mp3`;
  const transport = { positionMs: 0, durationMs: 48000, playing: false };
  const queue = {
    revision: 17,
    tracks: [
      track,
      second,
      ...Array.from({ length: 10 }, (_, index) => `Track ${index + 3}.wav`),
      last,
    ],
    selected: 0,
  };
  await render({ track, transport, queue });
  const list = page.getByRole('list', { name: 'Queue' });
  const firstRow = list.getByRole('button', { name: track, exact: true });
  const secondRow = list.getByRole('button', { name: second, exact: true });
  const lastRow = list.getByRole('button', { name: last, exact: true });
  await expect(firstRow).toHaveAttribute('aria-current', 'true', {
    timeout: 1000,
  });
  await expect(secondRow).toHaveText(second);
  await expect(list.locator('em')).toHaveCount(0);

  await firstRow.focus();
  await page.keyboard.press('ArrowDown');
  await expect(secondRow).toBeFocused();
  await page.keyboard.press('Enter');
  expect((await messages()).at(-1)).toEqual({
    type: 'select_track',
    revision: 17,
    index: 1,
  });

  await render({ track: second, transport, queue: { ...queue, selected: 1 } });
  await render({
    track: second,
    transport: { ...transport, positionMs: 1200 },
  });
  await expect(secondRow).toBeFocused();
  await expect(secondRow).toHaveAttribute('aria-current', 'true');
  await expect(list.getByRole('listitem')).toHaveCount(queue.tracks.length);
  await secondRow.click();
  expect((await messages()).slice(-2)).toEqual([
    { type: 'select_track', revision: 17, index: 1 },
    { type: 'select_track', revision: 17, index: 1 },
  ]);
  await page.keyboard.press('End');
  await expect(lastRow).toBeFocused();
  expect(await list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    290,
  );
  await render({
    track,
    transport,
    queue: { revision: 18, tracks: [track, second], selected: 0 },
  });
  await expect(firstRow).toBeFocused();
  await secondRow.click();
  expect((await messages()).at(-1)).toEqual({
    type: 'select_track',
    revision: 18,
    index: 1,
  });
  expect(blocked).toEqual([]);
});

test('blocks transport and queue changes while opening and at the queue bounds', async (t) => {
  const { page, messages, render } = await localAudioPage(t);
  const track = 'First.wav';
  const second = 'Second.mp3';
  const transport = { positionMs: 0, durationMs: 48000, playing: false };
  const queue = { revision: 24, tracks: [track, second], selected: 0 };
  await render({ track, transport, queue });
  const previous = page.getByRole('button', { name: 'Previous track' });
  const next = page.getByRole('button', { name: 'Next track' });
  const play = page.getByRole('button', { name: 'Play', exact: true });
  const seek = page.getByRole('slider', { name: 'Playback position' });
  const row = page.getByRole('button', { name: second, exact: true });
  await expect(previous).toBeDisabled({ timeout: 1000 });
  await next.click();
  expect((await messages()).at(-1)).toEqual({
    type: 'select_track',
    revision: 24,
    index: 1,
  });

  await next.focus();
  await render({ track, transport, opening: true });
  await render({ track: null, transport: null, opening: true });
  await expect(next).toBeFocused({ timeout: 1000 });
  await page.getByRole('slider', { name: 'Speed' }).press('ArrowLeft');
  expect((await messages()).at(-1)).toEqual({ type: 'set_speed', speed: 0.99 });
  await render({ track, transport, opening: false });
  await row.focus();
  await render({ track, transport, opening: true });
  await expect(row).toBeFocused();
  const beforeOpeningCommands = (await messages()).length;
  for (const button of [previous, next, play, row]) {
    await expect(button).toBeDisabled();
    await button.dispatchEvent('click');
  }
  await expect(seek).toBeDisabled();
  await seek.dispatchEvent('change');
  await page.getByRole('heading', { name: 'Local audio', exact: true }).click();
  await page.keyboard.press('Space');
  expect(await messages()).toHaveLength(beforeOpeningCommands);

  await render({ track: second, transport, queue: { ...queue, selected: 1 } });
  await expect(next).toBeDisabled();
  await expect(row).toBeEnabled();
  await expect(play).toBeEnabled();
  await expect(seek).toBeEnabled();
  await previous.click();
  expect((await messages()).at(-1)).toEqual({
    type: 'select_track',
    revision: 24,
    index: 0,
  });
});

test('shuffles upcoming tracks and sets repeat mode through the current queue revision', async (t) => {
  const { page, messages, render } = await localAudioPage(t, {
    width: 290,
    height: 475,
  });
  const track = 'Current.wav';
  const transport = { positionMs: 1500, durationMs: 48000, playing: true };
  const queue = {
    revision: 17,
    tracks: [track, 'Second.mp3', 'Third.flac'],
    selected: 0,
    canShuffle: true,
    repeat: 'off',
  };
  const shuffle = page.getByRole('button', { name: 'Shuffle upcoming' });
  const repeat = page.getByRole('combobox', { name: 'Repeat' });
  await expect(shuffle).toBeHidden();
  await expect(repeat).toBeHidden();
  await render({ track, transport, queue });
  await expect(repeat).toHaveValue('off', { timeout: 1000 });
  await shuffle.focus();
  await page.keyboard.press('Enter');
  expect((await messages()).at(-1)).toEqual({
    type: 'shuffle_upcoming',
    revision: 17,
  });
  const shuffled = {
    ...queue,
    revision: 18,
    tracks: [track, 'Third.flac', 'Second.mp3'],
  };
  await render({ track, transport, queue: shuffled });
  await expect(shuffle).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Pause', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('slider', { name: 'Playback position' }),
  ).toHaveValue('1500');
  await repeat.selectOption('track');
  expect((await messages()).at(-1)).toEqual({
    type: 'set_repeat',
    revision: 18,
    mode: 'track',
  });
  await render({ track, transport, queue: { ...shuffled, repeat: 'track' } });
  await render({ track, transport });
  await expect(repeat).toHaveValue('track');
  await repeat.selectOption('queue');
  expect((await messages()).at(-1)).toEqual({
    type: 'set_repeat',
    revision: 18,
    mode: 'queue',
  });

  await render({ track, transport, opening: true });
  await expect(shuffle).toBeDisabled();
  await expect(repeat).toBeDisabled();
  const count = (await messages()).length;
  await shuffle.evaluate((button) => button.click());
  expect(await messages()).toHaveLength(count);
  await render({
    track,
    transport,
    queue: { ...shuffled, selected: 2, canShuffle: false, repeat: 'queue' },
  });
  await expect(shuffle).toBeDisabled();
  await expect(repeat).toBeEnabled();
  await expect(repeat).toHaveValue('queue');
  await expect(page.getByRole('button', { name: 'Next track' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    290,
  );
});

test('clears upcoming tracks against the displayed selection and restores queue focus', async (t) => {
  const { page, messages, render } = await localAudioPage(t, {
    width: 290,
    height: 475,
  });
  const track = 'Current.wav';
  const transport = { positionMs: 1500, durationMs: 48000, playing: true };
  const queue = {
    revision: 17,
    tracks: ['First.wav', track, 'Last.flac'],
    selected: 1,
    canShuffle: false,
    repeat: 'queue',
  };
  const clear = page.getByRole('button', { name: 'Clear upcoming' });
  await render({ track, transport, queue });
  await expect(clear).toBeEnabled({ timeout: 1000 });
  await clear.focus();
  await page.keyboard.press('Enter');
  expect((await messages()).at(-1)).toEqual({
    type: 'clear_upcoming',
    revision: 17,
    selected: 1,
  });

  await render({ track, transport, opening: true });
  await expect(clear).toBeDisabled();
  const currentRow = page.getByRole('button', { name: track });
  await expect(currentRow).toBeFocused();
  const count = (await messages()).length;
  await clear.evaluate((button) => button.click());
  expect(await messages()).toHaveLength(count);

  await render({ track, transport });
  await expect(clear).toBeEnabled();
  await clear.focus();
  await render({
    track,
    transport,
    queue: { ...queue, revision: 18, tracks: ['First.wav', track] },
  });
  await expect(clear).toBeDisabled();
  await expect(currentRow).toBeFocused();
  await expect(
    page.getByRole('list', { name: 'Queue' }).getByRole('listitem'),
  ).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(
    page.getByRole('slider', { name: 'Playback position' }),
  ).toHaveValue('1500');
  await expect(page.getByRole('combobox', { name: 'Repeat' })).toHaveValue(
    'queue',
  );
  await expect(page.getByRole('button', { name: 'Next track' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    290,
  );
});

test('displays local track tags as text and clears them for the next untagged track', async (t) => {
  const { page, render, blocked } = await localAudioPage(t);
  const transport = { positionMs: 0, durationMs: 1000, playing: true };
  await render({
    track: 'Tagged song',
    artist: '<img src=https://outside.test/cover>',
    album: 'Live album',
    transport,
    queue: {
      revision: 1,
      tracks: ['first.mp3', 'second.wav'],
      selected: 0,
      canShuffle: false,
      repeat: 'off',
    },
  });
  await expect(
    page.getByRole('heading', { name: 'Tagged song' }),
  ).toBeVisible();
  await expect(
    page.getByText('<img src=https://outside.test/cover>', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('Live album', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'first.mp3' })).toBeVisible();

  await render({ track: 'second.wav', transport });
  await expect(page.getByRole('heading', { name: 'second.wav' })).toBeVisible();
  await expect(page.getByText('Live album', { exact: false })).toBeHidden();
  expect(blocked).toEqual([]);
});

test('opens a native lyrics picker and follows playback in a collapsible region', async (t) => {
  const { page, messages, render, blocked } = await localAudioPage(t, {
    width: 290,
    height: 475,
  });
  const openLyrics = page.getByRole('button', { name: 'Open lyrics file' });
  await render({ track: null, transport: null });
  await expect(openLyrics).toBeHidden();
  const track = 'Song.wav';
  const transport = { positionMs: 250, durationMs: 8000, playing: true };
  await render({ track, transport });
  await openLyrics.click({ timeout: 1000 });
  expect((await messages()).at(-1)).toEqual({ type: 'open_lyrics' });

  await render({ track, transport, selectingLyrics: true });
  await expect(openLyrics).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeEnabled();
  await render({ track, transport, lyrics: { loading: true } });
  await expect(openLyrics).toBeDisabled();
  await expect(openLyrics).toBeFocused();
  await expect(page.getByRole('status')).toHaveText('Opening lyrics file…');
  await expect(page.getByRole('button', { name: 'Pause' })).toBeEnabled();
  await openLyrics.dispatchEvent('click');
  expect((await messages()).slice(-2)).toEqual([
    { type: 'ready' },
    { type: 'open_lyrics' },
  ]);

  const details = page.locator('#local-lyrics');
  const summary = details.getByText('Lyrics', { exact: true });
  const line = page.locator('#lyrics-line');
  const lyricsAt = (positionMs, line) =>
    render({
      track,
      transport: { ...transport, positionMs },
      lyrics: { available: true, line },
    });
  await lyricsAt(250, null);
  await expect(details).toHaveJSProperty('open', true);
  await expect(line).toBeEmpty();
  const firstLine = '<img src=https://outside.test/cover>';
  await lyricsAt(1100, firstLine);
  await expect(line).toHaveText(firstLine);
  await summary.focus();
  await page.keyboard.press('Space');
  await expect(details).toHaveJSProperty('open', false);
  await lyricsAt(2500, 'Second line');
  await expect(details).toHaveJSProperty('open', false);
  await expect(line).toBeHidden();
  const loaded = { available: true, line: 'Second line' };
  await render({ track, transport, lyrics: loaded, selectingLyrics: true });
  await render({ track, transport, lyrics: loaded });
  await expect(details).toHaveJSProperty('open', false);
  await expect(openLyrics).toBeEnabled();
  await page.keyboard.press('Enter');
  await expect(line).toHaveText('Second line');

  await render({
    track,
    transport,
    lyrics: { available: true, line: firstLine, error: 'Invalid lyrics file.' },
  });
  await expect(page.getByRole('alert')).toHaveText('Invalid lyrics file.');
  await expect(line).toHaveText(firstLine);
  await render({
    track,
    transport,
    queue: { revision: 2, tracks: [track, track], selected: 1, repeat: 'off' },
  });
  await expect(details).toBeHidden();
  await expect(details).toHaveJSProperty('open', false);
  await expect(line).toBeEmpty();
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(openLyrics).toBeFocused();
  expect(blocked).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    290,
  );
});

test('shows a settings save problem alongside a playback problem', async (t) => {
  const { page, render } = await localAudioPage(t);
  const transport = {
    positionMs: 0,
    durationMs: 1000,
    playing: false,
    error: 'Could not read the audio samples.',
  };
  await render({
    track: 'test.wav',
    transport,
    settingsError: 'The Local Audio settings file is busy.',
  });
  await expect(page.getByRole('alert')).toHaveText(
    'Could not read the audio samples. The Local Audio settings file is busy.',
  );
  await render({ track: 'test.wav', transport });
  await expect(page.getByRole('alert')).toHaveText(
    'Could not read the audio samples.',
  );
});
