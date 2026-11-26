import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, expect } from '@playwright/test';

test('opens local audio files and sends playback and exact reverb settings to Rust', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 420, height: 475 } });
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
  const open = page.getByRole('button', { name: 'Open audio file' });
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
  await page.getByRole('button', { name: 'Reset effects' }).click();
  await expect(cutoff).toHaveValue('6500');
  expect((await messages()).slice(-2)).toEqual([
    { type: 'set_speed', speed: 1 },
    { type: 'set_reverb', intensity: 0, high_pass_hz: 180, low_pass_hz: 6500 },
  ]);
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
