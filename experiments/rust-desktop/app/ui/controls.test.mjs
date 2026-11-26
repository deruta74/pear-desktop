import { readFile, access } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';

const first = 'firstVideo_';
const second = 'secondVideo';
const third = 'thirdVideo_';
const origin = 'http://queue.test';
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/style.css', ['style.css', 'text/css']],
  ['/controls.js', ['controls.js', 'text/javascript']],
]);
let browser;

before(async () => {
  const installed = await access(chromium.executablePath()).then(
    () => true,
    () => false,
  );
  browser = await chromium.launch(installed ? {} : { channel: 'chrome' });
});

after(() => browser?.close());

async function panel(t, { withoutObjectHasOwn = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 370, height: 600 } });
  t.after(() => page.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const asset = assets.get(url.pathname);
    if (url.origin !== origin || !asset) return route.abort();

    const [file, contentType] = asset;
    const body = await readFile(new URL(file, import.meta.url)).catch(
      (error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      },
    );
    return route.fulfill({
      status: body ? 200 : 404,
      contentType,
      body: body ?? 'Missing queue panel asset',
      headers: {
        'Content-Security-Policy':
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src https://i.ytimg.com/vi/",
      },
    });
  });
  await page.addInitScript((withoutObjectHasOwn) => {
    if (withoutObjectHasOwn) delete Object.hasOwn;
    window.pearMessages = [];
    window.ipc = {
      postMessage: (message) => window.pearMessages.push(JSON.parse(message)),
    };
  }, withoutObjectHasOwn);
  const response = await page.goto(origin);
  expect(response.status()).toBe(200);
  expect(await messages(page)).toEqual([
    { sequence: 1, command: { type: 'ready' } },
  ]);
  return page;
}

function messages(page) {
  return page.evaluate(() => window.pearMessages);
}

function legalState(overrides = {}) {
  return {
    accepted: false,
    show: true,
    revision: 3,
    problem: null,
    ...overrides,
  };
}

test('requires deliberate agreement before mounting playback or requesting artwork', async (t) => {
  const page = await panel(t);
  const artwork = page.locator('#selection-artwork');
  const queueForm = page.locator('#add-video');
  const heading = page.getByRole('heading', { name: 'Terms & Privacy' });
  const agree = page.getByRole('button', { name: 'Agree and continue' });
  const quit = page.getByRole('button', { name: 'Quit' });
  const url = `https://i.ytimg.com/vi/${first}/hqdefault.jpg`;
  const artworkRequests = [];
  await page.route(url, (route) => {
    artworkRequests.push(route.request().url());
    return route.abort();
  });
  const render = (legal, error = null, sequence) =>
    state(page, [first], first, error, null, sequence, {
      legal,
      metadata: { title: 'Saved video', channel: 'Artist', thumbnailUrl: url },
    });
  await expect(queueForm).toBeHidden();
  await render(legalState({ show: false }));
  await expect(heading).toBeFocused();
  await expect(queueForm).toBeHidden();
  await expect(page.locator('#queue-items').getByRole('listitem')).toHaveCount(
    0,
  );
  await expect(artwork).not.toHaveAttribute('src');
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    window.focusPearAdd();
    document
      .getElementById('add-video')
      .dispatchEvent(new Event('submit', { cancelable: true }));
  });
  await expect(heading).toBeFocused();
  expect(await messages(page)).toHaveLength(1);
  expect(artworkRequests).toEqual([]);

  await agree.press('Enter');
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'accept_legal',
    revision: 3,
  });
  await render(legalState(), null, null);
  await expect(agree).toBeDisabled();
  await render(legalState(), 'Could not save the agreement.');
  await expect(page.getByRole('alert')).toHaveText(
    'Could not save the agreement.',
  );
  await expect(heading).toBeVisible();
  await expect(quit).toBeEnabled();
  await agree.press('Enter');
  await render(legalState({ accepted: true, show: false }));
  await expect(heading).toBeHidden();
  await expect(
    page.getByRole('textbox', { name: 'YouTube link or video ID' }),
  ).toBeFocused();
  await expect(page.locator('#selection-id')).toHaveText('Saved video');
  await expect(page.getByRole('status')).not.toContainText('Loading queue');
  await expect.poll(() => artworkRequests).toEqual([url]);
});

test('reopens Terms & Privacy without losing drafts or navigating the panel to external links', async (t) => {
  const page = await panel(t);
  await page.setViewportSize({ width: 384, height: 520 });
  const accepted = legalState({ accepted: true, show: false });
  const render = (legal, sequence) =>
    state(page, [first], first, null, null, sequence, {
      legal,
      catalog: searchState(),
    });
  await render(accepted);
  const source = page.getByRole('textbox', {
    name: 'YouTube link or video ID',
  });
  await page.getByRole('button', { name: 'Add links' }).click();
  await source.fill('My queue draft');
  await page.getByRole('button', { name: 'Search' }).click();
  const query = page.getByRole('searchbox', { name: 'Search YouTube' });
  await query.fill('My search draft');
  await render({ ...accepted, show: true }, null);
  await expect(
    page.getByRole('heading', { name: 'Terms & Privacy' }),
  ).toBeFocused();
  await expect(query).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Agree and continue' }),
  ).toBeHidden();
  await expect(page.getByRole('button', { name: 'Quit' })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    384,
  );
  const region = page.getByRole('main', { name: 'Terms & Privacy' });
  expect(
    await region.evaluate((node) => node.scrollHeight - node.clientHeight),
  ).toBeGreaterThan(0);

  for (const [label, link] of [
    ['YouTube Terms of Service', 'youtube_terms'],
    ['Google Privacy Policy', 'google_privacy'],
  ]) {
    const button = page.getByRole('button', { name: label });
    await button.press('Enter');
    expect((await messages(page)).at(-1).command).toEqual({
      type: 'open_legal_link',
      link,
    });
    await render({ ...accepted, show: true });
    await expect(button).toBeFocused();
    await expect(button).toBeInViewport();
    expect(page.url()).toBe(`${origin}/`);
  }
  await page.getByRole('button', { name: 'Close' }).press('Enter');
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'close_legal',
  });
  await render(accepted);
  await expect(query).toBeFocused();
  await expect(query).toHaveValue('My search draft');
  await page.getByRole('button', { name: 'Queue' }).click();
  await expect(source).toHaveValue('My queue draft');
});

test('offers Quit before agreement without accepting or dismissing the disclosure', async (t) => {
  const page = await panel(t);
  await state(page, [], null, null, null, 1, { legal: legalState() });
  await page.getByRole('button', { name: 'Quit' }).press('Enter');
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'decline_legal',
  });
  await expect(
    page.getByRole('heading', { name: 'Terms & Privacy' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close' })).toBeHidden();
});

async function state(
  page,
  entries,
  current = null,
  error = null,
  notice = null,
  sequence,
  {
    titles,
    playerProblem,
    metadata,
    metadataProblem,
    catalog,
    browserSearch,
    lyrics,
    lyricsSwitching,
    savedPlaylists,
    preferencesProblem,
    legal,
    publicPlaylist,
  } = {},
) {
  if (sequence === undefined) sequence = (await messages(page)).at(-1).sequence;
  return page.evaluate(
    ({ queueState, error, notice, sequence, playerProblem }) => {
      window.renderPearState(
        queueState,
        error,
        notice,
        sequence,
        playerProblem,
      );
    },
    {
      queueState: {
        entries,
        current,
        titles,
        metadata,
        metadataProblem,
        catalog,
        browserSearch,
        lyrics,
        lyricsSwitching,
        savedPlaylists,
        preferencesProblem,
        legal,
        publicPlaylist,
      },
      error,
      notice,
      sequence,
      playerProblem,
    },
  );
}

function transport(page, snapshot) {
  return page.evaluate(
    (snapshot) => window.renderPearTransport?.(snapshot),
    snapshot,
  );
}

const readyTransport = {
  ready: true,
  hasPlayed: true,
  playing: false,
  position: 15,
  duration: 140,
  blocked: false,
};

test('uses Space for playback only outside editable controls and after the official first play', async (t) => {
  const page = await panel(t);
  await state(page, [first], first);
  const heading = page.getByRole('heading', { name: 'Pear', exact: true });
  await transport(page, { ...readyTransport, hasPlayed: false });
  await heading.click();
  await page.keyboard.press('Space');
  expect(await messages(page)).toHaveLength(1);

  await transport(page, { ...readyTransport, playing: true });
  const link = page.getByRole('textbox', { name: 'YouTube link or video ID' });
  await page.getByRole('button', { name: 'Add links' }).click();
  await link.fill('My link draft');
  await page.keyboard.press('Space');
  await expect(link).toHaveValue('My link draft ');
  expect(await messages(page)).toHaveLength(1);

  await heading.click();
  await page.keyboard.press('Space');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 2,
    command: { type: 'set_playback', playing: false },
  });
});

test('opens a public playlist without catalog access and returns to the saved queue', async (t) => {
  const page = await panel(t);
  const entries = [first, second];
  const url = 'https://music.youtube.com/playlist?list=PLC77007E23FF423C6';
  const play = page.getByRole('button', { name: 'Play video' });
  const returnToQueue = page.getByRole('button', { name: 'Return to queue' });
  const metadataProblem = 'YouTube rejected the configured API key.';
  const queueMetadataProblem = page.locator('#metadata-problem');
  await state(page, entries, first, null, null, 1, { metadataProblem });
  await expect(queueMetadataProblem).toHaveText(metadataProblem);
  await transport(page, readyTransport);
  await expect(play).toBeVisible();
  await page.getByRole('button', { name: 'Add links' }).click();
  await page.locator('#public-playlist > summary').press('Space');
  expect(await messages(page)).toHaveLength(1);
  await page.getByLabel('Public playlist link').fill(url);
  await page.getByRole('button', { name: 'Play playlist in Pear' }).click();
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'play_public_playlist',
    source: url,
  });
  await state(page, entries, first, null, null, 2, {
    publicPlaylist: true,
    metadataProblem,
  });
  await expect(returnToQueue).toBeVisible();
  await expect(queueMetadataProblem).toBeEmpty();
  await expect(play).toBeHidden();
  await transport(page, readyTransport);
  await expect(play).toBeHidden();
  await expect(
    page.getByRole('button', { name: `Select ${first}` }),
  ).toHaveAttribute('aria-current', 'true');
  await returnToQueue.click();
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'return_to_queue',
  });
  await state(page, entries, first, null, null, 3, { metadataProblem });
  await expect(returnToQueue).toBeHidden();
  await expect(queueMetadataProblem).toHaveText(metadataProblem);
  await expect(play).toBeHidden();
  await transport(page, readyTransport);
  await expect(play).toBeVisible();

  await state(page, entries, first, null, null, null, { publicPlaylist: true });
  await page.getByRole('button', { name: `Select ${first}` }).click();
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'select',
    id: first,
  });
  await state(page, entries, first);
  await expect(returnToQueue).toBeHidden();
  await expect(
    page.getByRole('button', { name: `Select ${second}` }),
  ).toBeVisible();
});

test('makes available audio output controls usable before the first play', async (t) => {
  const page = await panel(t);
  await page.setViewportSize({ width: 384, height: 520 });
  await state(page, [first], first);
  const toggle = page.getByRole('button', { name: 'Volume controls' });
  const volume = page.getByRole('slider', { name: 'Volume' });
  const mute = page.getByRole('button', { name: 'Mute', exact: true });

  await transport(page, { ...readyTransport, volume: null, muted: null });
  await expect(toggle).toBeHidden();
  await transport(page, {
    ...readyTransport,
    hasPlayed: false,
    volume: 42,
    muted: null,
  });
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(volume).toBeEnabled();
  await expect(volume).toHaveValue('42');
  await expect(mute).toBeHidden();

  await transport(page, {
    ...readyTransport,
    hasPlayed: false,
    volume: 42,
    muted: false,
  });
  await expect(mute).toBeEnabled();
  await mute.press('Enter');
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'set_muted',
    muted: true,
  });
  await expect(volume).toBeDisabled();
  await expect(mute).toBeDisabled();
  await state(page, [first], first);
  await transport(page, {
    ...readyTransport,
    hasPlayed: false,
    volume: 42,
    muted: true,
  });
  await expect(mute).toHaveAttribute('aria-pressed', 'true');
  await expect(mute).toBeFocused();

  await transport(page, {
    ...readyTransport,
    blocked: true,
    volume: 42,
    muted: true,
  });
  await expect(volume).toBeDisabled();
  await expect(mute).toBeDisabled();
  await transport(page, { ...readyTransport, volume: 42, muted: true });
  await state(page, [first], first, null, null, null, {
    playerProblem: 'No audio output.',
  });
  await expect(volume).toBeDisabled();
  await expect(mute).toBeDisabled();

  await transport(page, null);
  await expect(toggle).toBeHidden();
  await expect(volume).toBeHidden();
});

test('sends one volume change per drag and reconciles the preview with transport samples', async (t) => {
  const page = await panel(t);
  await state(page, [first], first);
  const sample = (volume) =>
    transport(page, { ...readyTransport, volume, muted: false });
  await sample(32);
  await page.getByRole('button', { name: 'Volume controls' }).click();
  const slider = page.getByRole('slider', { name: 'Volume' });
  const { x, y, width, height } = await slider.boundingBox();
  await page.mouse.move(x + width / 2, y + height / 2);
  await page.mouse.down();
  await page.mouse.move(x + (width * 3) / 4, y + height / 2, { steps: 4 });
  const preview = Number(await slider.inputValue());
  expect(preview).toBeGreaterThan(32);
  await sample(35);
  await expect(slider).toHaveValue(String(preview));
  await expect(slider).toHaveAttribute('aria-valuetext', `${preview}%`);
  expect(await messages(page)).toHaveLength(1);

  await page.mouse.up();
  expect(await messages(page)).toEqual([
    { sequence: 1, command: { type: 'ready' } },
    { sequence: 2, command: { type: 'set_volume', volume: preview } },
  ]);
  await sample(preview - 1);
  await expect(slider).toHaveValue(String(preview));
  await expect(slider).toBeDisabled();
  await state(page, [first], first);
  await expect(slider).toHaveValue(String(preview - 1));
  await expect(slider).toBeEnabled();

  await slider.press('ArrowRight');
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'set_volume',
    volume: preview,
  });
  await state(page, [first], first, 'Could not change volume.');
  await expect(page.getByText('Could not change volume.')).toBeVisible();
  await expect(slider).toHaveValue(String(preview - 1));
  await expect(slider).toBeFocused();
});

test('exposes experimental playback only after the video pane starts playing', async (t) => {
  const page = await panel(t);
  await page.setViewportSize({ width: 384, height: 520 });
  await state(page, [first, second], first);
  const play = page.getByRole('button', { name: 'Play video' });
  const pause = page.getByRole('button', { name: 'Pause video' });
  const timeline = page.getByRole('slider', { name: 'Playback position' });
  await expect(play).toBeHidden();
  await expect(timeline).toBeHidden();

  await transport(page, { ...readyTransport, ready: false, hasPlayed: false });
  await expect(play).toBeVisible();
  await expect(play).toBeDisabled();
  await expect(timeline).toBeHidden();
  await transport(page, { ...readyTransport, hasPlayed: false });
  await expect(play).toBeDisabled();
  await expect(
    page.getByText(/start playback in the video pane/i),
  ).toBeVisible();
  expect(await messages(page)).toHaveLength(1);

  await transport(page, { ...readyTransport, playing: true });
  await expect(pause).toBeEnabled();
  await expect(timeline).toBeVisible();
  const actions = await page
    .locator('.playback-actions button:visible')
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getBoundingClientRect().top),
    );
  expect(new Set(actions).size).toBe(1);
  const { y, height } = await timeline.boundingBox();
  expect(y).toBeGreaterThan(actions[0]);
  expect(y + height).toBeLessThan(520);
  await pause.focus();
  await page.keyboard.press('Space');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 2,
    command: { type: 'set_playback', playing: false },
  });
  await page.keyboard.press('Space');
  expect(await messages(page)).toHaveLength(2);
  await state(page, [first, second], first);
  await transport(page, readyTransport);
  await expect(play).toBeFocused();
  await page.keyboard.press('Enter');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 3,
    command: { type: 'set_playback', playing: true },
  });

  await state(page, [first, second], second);
  await transport(page, { ...readyTransport, hasPlayed: false });
  await expect(timeline).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Open in browser' }),
  ).toBeFocused();
  await transport(page, null);
  await expect(play).toBeHidden();
});

test('previews a timeline drag through position polls and seeks when it is committed', async (t) => {
  const page = await panel(t);
  await state(page, [first], first);
  await transport(page, readyTransport);
  const timeline = page.getByRole('slider', { name: 'Playback position' });
  await expect(timeline).toHaveValue('15');
  await expect(timeline).toHaveAttribute('aria-valuetext', '0:15 of 2:20');
  await expect(page.getByText('2:20', { exact: true })).toBeVisible();

  const { x, y, width, height } = await timeline.boundingBox();
  await page.mouse.move(x + width / 2, y + height / 2);
  await page.mouse.down();
  await page.mouse.move(x + (width * 3) / 4, y + height / 2, { steps: 3 });
  const preview = await timeline.inputValue();
  expect(Number(preview)).toBeGreaterThan(15);
  await transport(page, { ...readyTransport, position: 20 });
  await expect(timeline).toHaveValue(preview);
  expect(await messages(page)).toHaveLength(1);

  await page.mouse.up();
  expect(await messages(page)).toEqual([
    { sequence: 1, command: { type: 'ready' } },
    { sequence: 2, command: { type: 'seek', position: Number(preview) } },
  ]);
  await state(page, [first], first);
  await transport(page, { ...readyTransport, position: Number(preview) });
  await timeline.focus();
  await page.keyboard.press('ArrowRight');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 3,
    command: { type: 'seek', position: Number(preview) + 1 },
  });
  await state(page, [first], first);
  await transport(page, { ...readyTransport, position: Number(preview) + 2 });
  await expect(timeline).toHaveValue(String(Number(preview) + 2));
  await expect(timeline).toBeFocused();
});

test('hides unavailable timeline data and disables transport on a player failure', async (t) => {
  const page = await panel(t);
  await state(page, [first], first);
  const play = page.getByRole('button', { name: 'Play video' });
  const timeline = page.getByRole('slider', { name: 'Playback position' });
  await transport(page, { ...readyTransport, duration: null });
  await expect(play).toBeEnabled();
  await expect(timeline).toBeHidden();

  await transport(page, { ...readyTransport, blocked: true });
  await expect(play).toBeDisabled();
  await expect(timeline).toBeHidden();
  await expect(page.getByText('Playback controls unavailable.')).toBeVisible();

  await transport(page, readyTransport);
  await timeline.focus();
  await state(page, [first], first, null, null, null, {
    playerProblem: 'The video player stopped. Use Reload Player.',
  });
  await expect(play).toBeDisabled();
  await expect(timeline).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Open in browser' }),
  ).toBeFocused();
  await expect(page.getByText('Playback controls unavailable.')).toBeHidden();
});

test('keeps invalid input for correction and clears input after an acknowledged add', async (t) => {
  const page = await panel(t);
  await state(page, []);
  const input = page.getByRole('textbox', { name: 'YouTube link or video ID' });
  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();
  await input.fill('unrecognized link');
  await input.press('Enter');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 2,
    command: { type: 'add', source: 'unrecognized link' },
  });
  await expect(input).toHaveValue('unrecognized link');

  await state(page, [], null, 'Enter a valid YouTube link or video ID.');
  await expect(page.locator('#queue-error')).toContainText(
    'Enter a valid YouTube link or video ID.',
  );
  await expect(input).toHaveValue('unrecognized link');
  await expect(input).toBeFocused();

  await input.fill('https://youtu.be/firstVideo_');
  await input.press('Enter');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 3,
    command: { type: 'add', source: 'https://youtu.be/firstVideo_' },
  });
  await state(page, [first], first, null, 'Loading the player.', null);
  await expect(page.getByRole('status')).toContainText('Loading the player.');
  await expect(input).toHaveValue('https://youtu.be/firstVideo_');
  await state(page, [first], first, null, null, 2);
  await expect(input).toHaveValue('https://youtu.be/firstVideo_');
  await expect(
    page.getByRole('button', { name: 'Add', exact: true }),
  ).toBeDisabled();
  await state(page, [first], first, null, 'Player is ready.');
  await expect(input).toHaveValue('');
  await expect(page.locator('#queue-error')).toHaveText('');
  await expect(page.getByRole('status')).toContainText('Player is ready.');
  await expect(page.getByRole('status')).toContainText('Added');
});

test('submits a multiline paste once and retains it when a line is invalid', async (t) => {
  const page = await panel(t);
  await state(page, [first], first);
  await page.getByRole('button', { name: 'Add links' }).click();
  const input = page.getByRole('textbox', { name: 'YouTube link or video ID' });
  const invalid = `https://youtu.be/${second}\ninvalid`;
  await input.fill(invalid);
  await input.press('Enter');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 2,
    command: { type: 'add', source: invalid },
  });
  await state(
    page,
    [first],
    first,
    'Enter a YouTube video link or ID on line 2.',
  );
  await expect(input).toHaveValue(invalid);
  await expect(page.locator('#queue-error')).toContainText('line 2');

  const corrected = `https://youtu.be/${second}\n${third}`;
  await input.fill(corrected);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 3,
    command: { type: 'add', source: corrected },
  });
  await state(page, [first, second, third], first);
  await expect(input).toHaveValue('');
  await expect(page.getByRole('status')).toHaveText(
    'Added 2 videos to the queue.',
  );
  await expect(page.locator('#position')).toHaveText('1 of 3');
});

test('filters by title and ID without changing the active video or controls', async (t) => {
  const page = await panel(t);
  const titles = {
    [first]: 'Piano',
    [second]: 'Evening strings',
    [third]: 'Live piano',
  };
  await state(page, [first, second, third], first, null, null, 1, { titles });
  const filter = page.getByRole('searchbox', { name: 'Filter queue' });
  await filter.fill('PIANO');
  await expect(page.locator('#queue-items > li:visible')).toHaveCount(2);
  await expect(page.locator('#queue-count')).toHaveText('2 of 3 videos');
  await expect(page.locator('#selection-id')).toHaveText('Piano');
  expect(await messages(page)).toHaveLength(1);

  await filter.fill('SECONDVIDEO');
  await expect(
    page.getByRole('button', { name: 'Select Evening strings' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Move Evening strings down' }).click();
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'move_down',
    id: second,
  });
  await state(page, [first, third, second], first, null, null, 2, { titles });
  await expect(
    page.getByRole('button', { name: 'Move Evening strings down' }),
  ).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Move Evening strings down' }),
  ).toBeDisabled();

  await filter.fill('no match');
  await expect(page.getByText('No matching videos.')).toBeVisible();
  await filter.press('Escape');
  await expect(filter).toHaveValue('');
  await expect(page.locator('#queue-items > li:visible')).toHaveCount(3);
  await expect(page.locator('#position')).toHaveText('1 of 3');
});

test('shuffles upcoming via acknowledged IPC without resetting the timeline or keyboard focus', async (t) => {
  const page = await panel(t);
  const shuffle = page.getByRole('button', { name: 'Shuffle upcoming' });
  const timeline = page.getByRole('slider', { name: 'Playback position' });
  const filter = page.getByRole('searchbox', { name: 'Filter queue' });
  const entries = [first, second, third];
  const shuffled = [first, third, second];
  await state(page, entries, second);
  await expect(shuffle).toBeHidden();

  await state(page, entries, first, null, null, null, {
    lyricsSwitching: true,
  });
  await expect(shuffle).toBeDisabled();
  await shuffle.focus();
  await page.keyboard.press('Enter');
  expect(await messages(page)).toHaveLength(1);

  await state(page, entries, first, null, null, null);
  await transport(page, readyTransport);
  await expect(shuffle).toBeEnabled();
  await page.keyboard.press('Enter');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 2,
    command: { type: 'shuffle_upcoming' },
  });
  await expect(shuffle).toBeDisabled();
  await expect(shuffle).toBeFocused();
  await state(page, entries, first, null, null, null);
  await page.keyboard.press('Enter');
  expect(await messages(page)).toHaveLength(2);
  await expect(page.locator('#queue-items > li').nth(1)).toHaveAttribute(
    'data-id',
    second,
  );

  await state(page, shuffled, first);
  await expect(page.locator('#queue-items > li').nth(1)).toHaveAttribute(
    'data-id',
    third,
  );
  await expect(page.getByRole('status')).toHaveText(
    'Shuffled upcoming videos.',
  );
  await expect(timeline).toBeVisible();
  await expect(timeline).toHaveValue('15');
  await expect(shuffle).toBeEnabled();
  await expect(shuffle).toBeFocused();

  await page.keyboard.press('Enter');
  await state(page, shuffled, first, 'Could not save the queue.');
  await expect(page.locator('#queue-error')).toHaveText(
    'Could not save the queue.',
  );
  await expect(shuffle).toBeFocused();

  await state(page, shuffled, third, null, null, null);
  await expect(shuffle).toBeHidden();
  await expect(filter).toBeFocused();
});

test('has room for a queue row at the minimum panel size with a long title and a player error', async (t) => {
  const page = await panel(t);
  await page.setViewportSize({ width: 384, height: 520 });
  const entries = [
    first,
    second,
    third,
    ...Array.from({ length: 7 }, (_, i) => `extraVideo${i}`),
  ];
  await state(page, entries, first, null, null, 1, {
    titles: {
      [first]: 'A video with a long title and many words '
        .repeat(5)
        .slice(0, 180),
    },
    playerProblem:
      'Could not load the video player. Use Reload Player or Open in browser.',
  });
  const list = await page.locator('#queue-items').boundingBox();
  const row = await page.locator('#queue-items > li').first().boundingBox();
  assertVisibleQueueRow(list, row);
  const layout = await page.locator('.queue-toolbar').evaluate((toolbar) => {
    const rect = (selector) =>
      toolbar.querySelector(selector).getBoundingClientRect().toJSON();
    return {
      heading: rect('.queue-heading'),
      shuffle: rect('#shuffle-upcoming'),
      filter: rect('#queue-filter'),
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  await expect(
    page.getByRole('button', { name: 'Shuffle upcoming' }),
  ).toBeVisible();
  expect(layout.shuffle.left).toBeGreaterThanOrEqual(layout.heading.right);
  expect(layout.filter.left).toBeGreaterThanOrEqual(layout.shuffle.right);
  expect(layout.shuffle.top).toBeLessThan(layout.filter.bottom);
  expect(layout.scrollWidth).toBe(layout.width);
});

test('queues an existing track to play next without interrupting playback or losing focus', async (t) => {
  const page = await panel(t);
  await page.setViewportSize({ width: 384, height: 520 });
  const entries = [first, second, third];
  await state(page, entries, first);
  await transport(page, { ...readyTransport, playing: true });
  const queue = page.getByRole('list', { name: 'Queue' });
  const playNext = queue.getByRole('button', { name: `Play ${third} next` });
  await expect(
    queue.getByRole('button', { name: `Play ${first} next` }),
  ).toHaveCount(0);
  await expect(
    queue.getByRole('button', { name: `Play ${second} next` }),
  ).toBeDisabled();
  await playNext.press('Enter');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 2,
    command: { type: 'play_next', id: third },
  });
  await expect(playNext).toBeDisabled();
  await expect(playNext).toBeFocused();
  await playNext.press('Space');
  expect(await messages(page)).toHaveLength(2);

  const reordered = [first, third, second];
  await state(page, reordered, first);
  await expect(queue.getByRole('listitem').nth(1)).toContainText(third);
  await expect(playNext).toBeFocused();
  await expect(playNext).toBeDisabled();
  await expect(page.getByRole('status')).toHaveText('Queued to play next.');
  await expect(
    page.getByRole('button', { name: 'Pause video' }),
  ).toBeInViewport();
  await expect(
    page.getByRole('slider', { name: 'Playback position' }),
  ).toHaveValue('15');
  await state(page, reordered, third, null, null, null);
  await expect(
    queue.getByRole('button', { name: `Select ${third}` }),
  ).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    384,
  );
});

function assertVisibleQueueRow(list, row) {
  expect(list).not.toBeNull();
  expect(row).not.toBeNull();
  expect(list.height).toBeGreaterThanOrEqual(row.height);
  expect(list.y + row.height).toBeLessThanOrEqual(520);
}

test('scrolls to the first results when the filter changes while reusing the rows', async (t) => {
  const page = await panel(t);
  const entries = Array.from(
    { length: 100 },
    (_, i) => `video${String(i).padStart(6, '0')}`,
  );
  const titles = Object.fromEntries(
    entries.map((id, i) => [id, i < 50 ? 'Studio' : 'Live']),
  );
  await state(page, entries, entries[0], null, null, 1, { titles });
  await page.locator('#queue-items').evaluate((list) => {
    list.scrollTop = list.scrollHeight;
    list.lastElementChild.dataset.existingNode = 'true';
  });
  await page.getByRole('searchbox', { name: 'Filter queue' }).fill('Live');
  await expect(page.locator('#queue-items > li:visible')).toHaveCount(50);
  expect(
    await page.locator('#queue-items').evaluate((list) => list.scrollTop),
  ).toBe(0);
  await expect(page.locator('#queue-items > li:last-child')).toHaveAttribute(
    'data-existing-node',
    'true',
  );
});

test('sends queue controls to the host and moves focus after removing a row', async (t) => {
  const page = await panel(t);
  await state(page, [first, second], first);
  const previous = page.getByRole('button', { name: 'Previous video' });
  const next = page.getByRole('button', { name: 'Next video' });
  await expect(previous).toBeDisabled();
  await next.click();
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 2,
    command: { type: 'next' },
  });
  await state(page, [first, second], second);
  await expect(next).toBeDisabled();
  await previous.click();
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 3,
    command: { type: 'previous' },
  });
  await state(page, [first, second], first);

  await page.getByRole('button', { name: `Select ${second}` }).click();
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 4,
    command: { type: 'select', id: second },
  });
  await state(page, [first, second], second);
  await expect(
    page.getByRole('button', { name: `Select ${second}` }),
  ).toHaveAttribute('aria-current', 'true');

  await page.getByRole('button', { name: 'Open in browser' }).click();
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 5,
    command: { type: 'open_browser' },
  });
  await state(page, [first, second], second);

  const remove = page.getByRole('button', { name: `Remove ${second}` });
  await remove.focus();
  await remove.press('Enter');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 6,
    command: { type: 'remove', id: second },
  });
  await state(page, [first], first);
  await expect(remove).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: `Select ${first}` }),
  ).toBeFocused();
});

test('prioritizes adding a link when the queue is empty', async (t) => {
  const page = await panel(t);
  await page.setViewportSize({ width: 1180, height: 640 });
  const playing = page.getByRole('region', { name: 'Now playing' });
  const addLink = page.getByRole('textbox', {
    name: 'YouTube link or video ID',
  });
  await state(page, [], null);
  await expect(playing).toBeHidden();
  await expect(addLink).toBeInViewport();
  await state(page, [first], first);
  await expect(playing).toBeVisible();
  await state(page, [], null);
  await expect(playing).toBeHidden();
  await expect(addLink).toBeInViewport();
});

test('opens and closes Add links from the keyboard while keeping the queue and its draft', async (t) => {
  const page = await panel(t);
  await page.setViewportSize({ width: 384, height: 520 });
  const entries = Array.from(
    { length: 12 },
    (_, i) => `video${String(i).padStart(6, '0')}`,
  );
  await state(page, entries, entries[0], null, null, 1, {
    catalog: searchState(),
  });
  await transport(page, readyTransport);
  const composer = page.getByRole('button', { name: 'Add links' });
  const input = page.getByRole('textbox', { name: 'YouTube link or video ID' });
  const filter = page.getByRole('searchbox', { name: 'Filter queue' });
  const queue = page.getByRole('list', { name: 'Queue' });
  const timeline = page.getByRole('slider', { name: 'Playback position' });

  await expect(composer).toHaveAttribute('aria-expanded', 'false');
  await expect(input).toBeHidden();
  await expect(queue.getByRole('listitem').nth(2)).toBeInViewport();
  await queue.getByRole('button', { name: `Select ${entries.at(-1)}` }).focus();
  expect(await queue.evaluate((list) => list.scrollTop)).toBeGreaterThan(0);
  await expect(timeline).toBeInViewport();

  await composer.press('Space');
  await expect(composer).toHaveAttribute('aria-expanded', 'true');
  await expect(input).toBeFocused();
  await input.fill(second);
  await input.press('Escape');
  await expect(composer).toBeFocused();
  await expect(input).toBeHidden();

  await page.getByRole('button', { name: 'Search' }).press('Enter');
  await page.getByRole('button', { name: 'Queue' }).press('Enter');
  await expect(filter).toBeFocused();
  await expect(input).toBeHidden();
  await expect(timeline).toBeInViewport();

  await composer.press('Enter');
  await expect(input).toHaveValue(second);
  await input.press('Enter');
  await input.press('Escape');
  await state(page, entries, entries[0], 'Could not save the queue.', null, 2, {
    catalog: searchState(),
  });
  await expect(
    page.getByRole('alert').filter({ hasText: 'Could not save the queue.' }),
  ).toBeVisible();
  await expect(composer).toBeFocused();
  await composer.press('Enter');
  await expect(input).toHaveValue(second);
  await page.setViewportSize({ width: 320, height: 520 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
});

test('rejects oversized UTF-8 envelopes without getting stuck waiting for the host', async (t) => {
  const page = await panel(t);
  await state(page, []);
  const input = page.getByRole('textbox', { name: 'YouTube link or video ID' });
  await input.fill('界'.repeat(1500));
  await input.press('Enter');
  await expect(page.locator('#queue-error')).toContainText('too long');
  expect(await messages(page)).toHaveLength(1);

  await input.fill(first);
  await input.press('Enter');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 2,
    command: { type: 'add', source: first },
  });
});

test('renders literal titles and ID fallbacks without Object.hasOwn', async (t) => {
  const page = await panel(t, { withoutObjectHasOwn: true });
  expect(await page.evaluate(() => typeof Object.hasOwn)).toBe('undefined');
  await state(page, [first, second], first);
  await page.getByRole('button', { name: `Select ${first}` }).focus();

  const title = '<img src="https://example.invalid/title"> Piano & strings';
  await state(page, [first, second], first, null, null, null, {
    titles: { [first]: title, [second]: '   ' },
  });
  await expect(page.locator('#selection-id')).toHaveText(title);
  await expect(page.locator('#position')).toHaveText('1 of 2');
  const selected = page.getByRole('button', { name: `Select ${title}` });
  await expect(selected).toHaveText(title);
  await expect(selected).toBeFocused();
  await expect(page.locator('img:not(#selection-artwork)')).toHaveCount(0);
  expect(
    await page.locator('#selection-artwork').getAttribute('src'),
  ).toBeNull();
  await expect(
    page.getByRole('button', { name: `Select ${second}` }),
  ).toBeVisible();
});

test('renders selected YouTube metadata as searchable literal text and clears it with the selection', async (t) => {
  const page = await panel(t);
  const entries = [first, second];
  const titles = { [first]: 'Saved title' };
  const metadata = {
    title: '<b>Official piano & strings</b>',
    channel: '<i>Artist & friends</i>',
  };
  const currentTitle = page.locator('#selection-id');
  const attribution = page.getByText('YouTube · <i>Artist & friends</i>', {
    exact: true,
  });
  const filter = page.getByRole('searchbox', { name: 'Filter queue' });
  const officialRow = page.getByRole('button', {
    name: 'Select <b>Official piano & strings</b>',
  });

  await state(page, entries, first, null, null, 1, { titles, metadata });
  await expect(currentTitle).toHaveText('<b>Official piano & strings</b>');
  await expect(officialRow).toHaveText('<b>Official piano & strings</b>');
  await expect(attribution).toBeVisible();
  await expect(page.locator('.selection b, .selection i')).toHaveCount(0);
  await filter.fill('official piano');
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await expect(officialRow).toBeVisible();

  await state(page, entries, second, null, null, null, { titles });
  await expect(currentTitle).toHaveText(second);
  await expect(page.locator('.selection-attribution')).toHaveCount(0);
  await expect(page.getByText('No matching videos.')).toBeVisible();
  await filter.fill('saved title');
  await expect(
    page.getByRole('button', { name: 'Select Saved title' }),
  ).toBeVisible();

  await state(page, entries, first, null, null, null, { titles, metadata });
  await state(page, entries, first, null, null, null, {
    titles,
    metadata: null,
  });
  await expect(currentTitle).toHaveText('Saved title');
  await expect(page.locator('.selection-attribution')).toHaveCount(0);
});

test('shows a supplied metadata problem independently of playback and queue feedback', async (t) => {
  const page = await panel(t);
  const metadataProblem = 'YouTube video details are unavailable.';
  const problemText = page.getByText(metadataProblem, { exact: true });
  const playerAlert = page
    .getByRole('region', { name: 'Now playing' })
    .getByRole('alert');
  const queueStatus = page.getByRole('status');

  await state(page, [first], first);
  await transport(page, readyTransport);
  await expect(problemText).toHaveCount(0);

  await state(page, [first], first, null, 'Queue loaded.', null, {
    metadataProblem,
  });
  await expect(problemText).toBeVisible();
  await expect(problemText).toHaveAttribute('aria-live', 'polite');
  await expect(playerAlert).toBeEmpty();
  await expect(queueStatus).toHaveText('Queue loaded.');
  await expect(page.getByRole('button', { name: 'Play video' })).toBeEnabled();

  await state(page, [first], first, null, null, null, {
    metadataProblem: null,
  });
  await expect(problemText).toHaveCount(0);
});

test('keeps failed playback preference feedback visible outside the Queue view', async (t) => {
  const page = await panel(t);
  const saved = savedPlaylists();
  await state(page, [first], first, null, null, 1, { savedPlaylists: saved });
  await page.getByRole('button', { name: 'Library' }).click();
  const warning =
    'Playback mode changed for this session. The preference could not be saved.';
  await state(page, [first], first, null, null, undefined, {
    savedPlaylists: saved,
    preferencesProblem: warning,
  });
  await expect(page.getByText(warning)).toBeVisible();
  await state(page, [first], first, null, null, undefined, {
    savedPlaylists: saved,
  });
  await expect(page.getByText(warning)).toHaveCount(0);
});

test('loads only artwork matching the current video and clears it on selection change', async (t) => {
  const page = await panel(t);
  const cover = page.locator('#selection-artwork');
  const url = `https://i.ytimg.com/vi/${first}/hqdefault.jpg`;
  let requested = 0;
  await page.route(url, (route) => {
    requested += 1;
    return route.fulfill({
      contentType: 'image/gif',
      body: Buffer.from(
        'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        'base64',
      ),
    });
  });
  const metadata = { title: 'Track', channel: 'Band' };
  for (const thumbnailUrl of [
    `https://i.ytimg.com/vi/${second}/hqdefault.jpg`,
    `${url}?other=1`,
  ]) {
    await state(page, [first, second], first, null, null, undefined, {
      metadata: { ...metadata, thumbnailUrl },
    });
    expect(await cover.getAttribute('src')).toBeNull();
  }
  await state(page, [first, second], first, null, null, undefined, {
    metadata: { ...metadata, thumbnailUrl: url },
  });
  await expect(cover).toBeVisible();
  await expect(cover).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect
    .poll(() => cover.evaluate((image) => image.naturalWidth))
    .toBe(1);
  expect(requested).toBe(1);
  await state(page, [first, second], second);
  await expect(cover).toBeHidden();
  expect(await cover.getAttribute('src')).toBeNull();
});

test('fits a queue row at the minimum panel size while displaying long YouTube metadata', async (t) => {
  const page = await panel(t);
  await page.setViewportSize({ width: 384, height: 520 });
  const entries = [first, second, third];
  await state(page, entries, first, null, null, 1, {
    metadata: {
      title: 'A long video title that takes multiple lines '.repeat(5),
      channel: 'A channel with a long display name '.repeat(8),
    },
    catalog: searchState(),
    lyrics: lyricsState(),
    savedPlaylists: savedPlaylists(),
  });
  await expect(page.getByRole('navigation').getByRole('button')).toHaveCount(4);
  await transport(page, readyTransport);
  const attribution = page.getByText(/^YouTube · A channel/);
  await expect(attribution).toBeVisible();
  expect(
    await attribution.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  const list = await page.locator('#queue-items').boundingBox();
  const row = await page.locator('#queue-items > li').first().boundingBox();
  assertVisibleQueueRow(list, row);
});

function searchState(overrides = {}) {
  return {
    query: '',
    pending: false,
    results: [],
    problem: null,
    ...overrides,
  };
}

function publicPlaylistState(overrides = {}) {
  return {
    hasMore: true,
    unavailable: 0,
    revision: 7,
    pending: false,
    truncated: false,
    problem: null,
    ...overrides,
  };
}

const pianoResult = {
  id: second,
  title: '<b>Studio piano & strings</b>',
  channel: '<i>Artist & friends</i>',
};

test('shows public playlist limitations and hands off a selected row without adding to the queue', async (t) => {
  const page = await panel(t);
  await page.setViewportSize({ width: 384, height: 520 });
  const link = 'https://music.youtube.com/playlist?list=PL_1234567890';
  const render = (catalog, error = null, sequence) =>
    state(page, [first], first, error, null, sequence, { catalog });
  await render(searchState());
  await page.getByRole('button', { name: 'Search' }).click();
  const input = page.getByRole('searchbox', { name: 'Search YouTube' });
  await input.fill(link);
  await input.press('Enter');
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'search',
    query: link,
  });
  const playlist = publicPlaylistState({ unavailable: 2 });
  await render(
    searchState({ query: 'PL_1234567890', playlist, pending: true }),
    null,
    2,
  );
  await expect(page.getByText('Loading the YouTube playlist…')).toBeVisible();
  const loaded = searchState({
    query: 'PL_1234567890',
    playlist,
    results: [pianoResult, pianoResult],
  });
  await render(loaded, null, null);
  await expect(page.getByText('2 videos loaded · 2 unavailable')).toBeVisible();
  const rows = page.getByRole('list', { name: 'YouTube playlist videos' });
  const actions = rows.getByRole('button', {
    name: /Open .* in YouTube Music/,
  });
  await expect(actions).toHaveCount(2);
  await expect(rows.getByRole('button', { name: /play .* next/i })).toHaveCount(
    0,
  );
  await actions.first().click();
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'open_playlist_video',
    id: second,
  });
  await expect(page.getByRole('button', { name: 'Load more' })).toBeDisabled();
  await render(loaded, 'Could not open YouTube Music.', 3);
  await expect(page.getByText('Could not open YouTube Music.')).toBeVisible();
  await expect(page.getByText('1 of 1')).toBeVisible();
  await render(searchState(), null, null);
  await expect(input).toHaveValue(link);
  await expect(rows).toBeHidden();
  await expect(page.getByText('Could not open YouTube Music.')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Load more' })).toBeHidden();
});

test('loads more playlist rows explicitly and preserves repeated rows, scroll, and focus through a retry', async (t) => {
  const page = await panel(t);
  await page.setViewportSize({ width: 384, height: 520 });
  const initial = Array.from({ length: 12 }, (_, index) => ({
    id: second,
    title: `Track ${index + 1}`,
    channel: 'Artist',
  }));
  const render = (playlist, results = initial, sequence = null, error = null) =>
    state(page, [first], first, error, null, sequence, {
      catalog: searchState({ query: 'PL_1234567890', results, playlist }),
    });
  await render(publicPlaylistState(), initial, 1);
  await transport(page, readyTransport);
  await page.getByRole('button', { name: 'Search' }).press('Enter');
  const more = page.getByRole('button', { name: 'Load more' });
  const rows = page.getByRole('list', { name: 'YouTube playlist videos' });
  const items = rows.getByRole('listitem');
  await expect(more).toBeInViewport();
  await expect(items).toHaveCount(initial.length);
  expect(await messages(page)).toHaveLength(1);
  const scroll = await rows.evaluate((list) => {
    list.scrollTop = 180;
    window.originalPlaylistRows = Array.from(list.children);
    return list.scrollTop;
  });
  expect(scroll).toBeGreaterThan(0);

  await more.press('Enter');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 2,
    command: { type: 'load_more_playlist', revision: 7 },
  });
  await expect(more).toBeDisabled();
  await more.press('Enter');
  expect(await messages(page)).toHaveLength(2);
  await render(publicPlaylistState({ pending: true }), initial, 2);
  await expect(page.getByText('Loading more videos…')).toBeVisible();
  await expect(more).toBeFocused();
  await expect(more).toBeDisabled();
  await expect(items).toHaveCount(initial.length);
  expect(await rows.evaluate((list) => list.scrollTop)).toBe(scroll);

  const problem = 'YouTube did not respond. Try again.';
  await render(publicPlaylistState({ problem }));
  await expect(page.getByText(problem)).toBeVisible();
  await expect(more).toBeEnabled();
  await expect(more).toBeFocused();
  expect(await rows.evaluate((list) => list.scrollTop)).toBe(scroll);

  await more.press('Enter');
  await render(
    publicPlaylistState(),
    initial,
    3,
    'Could not request the next page.',
  );
  await expect(
    page.getByText('Could not request the next page.'),
  ).toBeVisible();
  await expect(more).toBeFocused();
  await expect(more).toBeEnabled();

  await more.press('Enter');
  await render(publicPlaylistState({ pending: true }), initial, 4);
  const additional = [initial[0], { ...pianoResult, id: third }];
  await render(publicPlaylistState({ unavailable: 3 }), [
    ...initial,
    ...additional,
  ]);
  await expect(items).toHaveCount(initial.length + additional.length);
  await expect(items.nth(initial.length)).toContainText('Track 1');
  await expect(items.last()).toContainText(pianoResult.title);
  await expect(
    page.getByText('14 videos loaded · 3 unavailable'),
  ).toBeVisible();
  await expect(page.getByText(problem)).toBeHidden();
  await expect(more).toBeFocused();
  expect(await rows.evaluate((list) => list.scrollTop)).toBe(scroll);
  expect(
    await rows.evaluate((list) =>
      window.originalPlaylistRows.every(
        (row, index) => list.children[index] === row,
      ),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    384,
  );

  await more.press('Enter');
  await render(
    publicPlaylistState({ hasMore: false, truncated: true }),
    [...initial, ...additional],
    5,
  );
  await expect(more).toBeHidden();
  await expect(rows).toBeFocused();
  await expect(
    page.getByText('Reached the playlist preview limit.'),
  ).toBeVisible();
  expect(await rows.evaluate((list) => list.scrollTop)).toBe(scroll);
  await page.keyboard.press('Space');
  expect(await messages(page)).toHaveLength(5);

  await render(publicPlaylistState({ revision: 8 }), [initial[0]]);
  await expect(items).toHaveCount(1);
  expect(
    await items
      .first()
      .evaluate((row) => row === window.originalPlaylistRows[0]),
  ).toBe(false);
  await more.press('Enter');
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'load_more_playlist',
    revision: 8,
  });
});

test('opens browser search only when submitted and keeps its draft and acknowledgement in Search', async (t) => {
  const page = await panel(t);
  await page.setViewportSize({ width: 384, height: 520 });
  const remoteRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== origin)
      remoteRequests.push(request.url());
  });
  const render = (error = null, sequence, catalog) =>
    state(page, [first], first, error, null, sequence, {
      browserSearch: true,
      catalog,
    });
  await render();
  const navigation = page.getByRole('navigation', { name: 'Queue and search' });
  await navigation.getByRole('button', { name: 'Search' }).click();
  const form = page.locator('#catalog-form');
  const query = form.getByRole('searchbox', { name: 'Search YouTube Music' });
  const submit = form.getByRole('button', {
    name: 'Open in browser',
    exact: true,
  });
  await expect(query).toBeFocused();
  await expect(submit).toBeInViewport();
  expect((await query.boundingBox()).width).toBeGreaterThanOrEqual(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    384,
  );
  await query.fill(' '.repeat(3));
  await query.press('Enter');
  await expect(form.getByText('Enter a search term.')).toBeVisible();
  await query.fill('🌿'.repeat(161));
  await query.press('Enter');
  await expect(
    form.getByText('Enter a search of up to 160 characters.'),
  ).toBeVisible();

  const draft = '  Björk & Co  ';
  await query.fill(draft);
  expect(await messages(page)).toHaveLength(1);
  await query.press('Enter');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 2,
    command: { type: 'open_music_search', query: 'Björk & Co' },
  });
  await render(null, null);
  await expect(submit).toBeDisabled();
  await expect(query).toHaveValue(draft);
  await expect(query).toBeFocused();

  const problem = 'Could not open YouTube Music in your browser.';
  await render(problem, 2);
  await expect(form.getByText(problem)).toBeVisible();
  await expect(submit).toBeEnabled();
  await expect(page.locator('#queue-error')).toBeEmpty();
  await navigation.getByRole('button', { name: 'Queue' }).click();
  await navigation.getByRole('button', { name: 'Search' }).click();
  await expect(query).toHaveValue(draft);
  await query.press('Enter');
  await render(null, 3);
  await expect(form.getByText(problem)).toHaveCount(0);
  await expect(query).toHaveValue(draft);
  await expect(
    page.getByRole('list', { name: 'YouTube results' }),
  ).toBeHidden();
  expect(page.url()).toBe(`${origin}/`);
  expect(remoteRequests).toEqual([]);

  await render(null, null, searchState());
  await expect(
    form.getByRole('searchbox', { name: 'Search YouTube', exact: true }),
  ).toHaveValue(draft);
  await expect(form.getByRole('button', { name: 'Search' })).toBeVisible();
  expect(await messages(page)).toHaveLength(3);
});

test('keeps queue confirmations when a playlist page finishes loading', async (t) => {
  const page = await panel(t);
  const render = (entries, playlist, results, sequence) =>
    state(page, entries, first, null, null, sequence, {
      catalog: searchState({ query: 'PL_1234567890', playlist, results }),
    });
  const initial = [{ ...pianoResult, id: second }];
  await render([first], publicPlaylistState(), initial, 1);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Load more' }).click();
  await render([first], publicPlaylistState({ pending: true }), initial, 2);

  await page.getByRole('button', { name: 'Queue' }).click();
  await page.getByRole('button', { name: 'Add links' }).click();
  const input = page.getByRole('textbox', { name: 'YouTube link or video ID' });
  await input.fill(third);
  await input.press('Enter');
  await render(
    [first, third],
    publicPlaylistState({ pending: true }),
    initial,
    3,
  );
  const status = page.locator('#queue-status');
  await expect(status).toHaveText('Added to the queue.');

  await render(
    [first, third],
    publicPlaylistState(),
    [...initial, ...initial],
    null,
  );
  await expect(status).toHaveText('Added to the queue.');
});

test('makes the Search view available only with an active catalog and keeps playback accessible', async (t) => {
  const page = await panel(t);
  const navigation = page.getByRole('navigation', { name: 'Queue and search' });
  const query = page.getByRole('searchbox', { name: 'Search YouTube' });
  const source = page.getByRole('textbox', {
    name: 'YouTube link or video ID',
  });
  const filter = page.getByRole('searchbox', { name: 'Filter queue' });

  await state(page, [first], first);
  await expect(navigation).toHaveCount(0);
  await expect(query).toHaveCount(0);
  await expect(source).toBeHidden();
  await expect(filter).toBeVisible();

  await state(page, [first], first, null, null, null, {
    catalog: searchState(),
  });
  await transport(page, readyTransport);
  const showSearch = navigation.getByRole('button', { name: 'Search' });
  await expect(showSearch).toBeVisible();
  await showSearch.press('Enter');
  await expect(showSearch).toHaveAttribute('aria-pressed', 'true');
  await expect(query).toBeFocused();
  await expect(source).toBeHidden();
  await expect(page.locator('#selection-id')).toHaveText(first);
  await expect(
    page.getByRole('slider', { name: 'Playback position' }),
  ).toBeVisible();
  await navigation.getByRole('button', { name: 'Queue' }).press('Space');
  await expect(filter).toBeFocused();
  await showSearch.press('Enter');
  await state(page, [first], first, null, null, null, { catalog: null });
  await expect(navigation).toHaveCount(0);
  await expect(query).toHaveCount(0);
  await expect(filter).toBeFocused();
});

test('opens Queue and focuses its add field from the native shortcut while preserving both drafts', async (t) => {
  const page = await panel(t);
  const source = page.getByRole('textbox', {
    name: 'YouTube link or video ID',
  });
  const query = page.getByRole('searchbox', { name: 'Search YouTube' });
  const view = page.getByRole('navigation', { name: 'Queue and search' });

  await page.evaluate(() => window.focusPearAdd?.());
  await state(page, [first], first, null, null, 1, { catalog: searchState() });
  await expect(source).toBeFocused();
  await source.fill(second);
  await view.getByRole('button', { name: 'Search' }).click();
  await query.fill('unsubmitted search');
  await page.evaluate(() => window.focusPearAdd?.());
  await expect(view.getByRole('button', { name: 'Queue' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(source).toBeFocused();
  await expect(source).toHaveValue(second);
  await view.getByRole('button', { name: 'Search' }).click();
  await expect(query).toHaveValue('unsubmitted search');
  expect(await messages(page)).toHaveLength(1);
});

test('reports Search progress and provider results after an acknowledgement with a playback notice', async (t) => {
  const page = await panel(t);
  const view = page.getByRole('navigation', { name: 'Queue and search' });
  const query = page.getByRole('searchbox', { name: 'Search YouTube' });
  const notice = 'Opening the YouTube player…';
  await state(page, [first], first, null, null, 1, { catalog: searchState() });
  await view.getByRole('button', { name: 'Search' }).click();
  await query.fill('piano');
  await query.press('Enter');
  await state(page, [first], first, null, notice, 2, {
    catalog: searchState({ query: 'piano', pending: true }),
  });
  await expect(page.getByText('Searching YouTube…')).toBeVisible();
  await expect(page.locator('#catalog-form')).not.toContainText(notice);
  const providerError = 'YouTube search is temporarily unavailable.';
  await state(page, [first], first, null, notice, null, {
    catalog: searchState({ query: 'piano', problem: providerError }),
  });
  await expect(page.getByText(providerError)).toBeVisible();
  await state(page, [first], first, null, null, null, {
    catalog: searchState({ query: 'piano' }),
  });
  await expect(
    page.getByText('No videos found. Try a different search.'),
  ).toBeVisible();
});

test('keeps Search actions unavailable until a pending playback command is acknowledged', async (t) => {
  const page = await panel(t);
  const catalog = searchState({ query: 'piano', results: [pianoResult] });
  await state(page, [first], first, null, null, 1, { catalog });
  await page
    .getByRole('navigation', { name: 'Queue and search' })
    .getByRole('button', { name: 'Search' })
    .click();
  const submit = page
    .locator('#catalog-form')
    .getByRole('button', { name: 'Search' });
  const addResult = page.getByRole('button', {
    name: 'Add <b>Studio piano & strings</b> to queue',
  });
  await page.getByRole('button', { name: 'Open in browser' }).click();
  await expect(submit).toBeDisabled();
  await expect(addResult).toBeDisabled();
  await page.getByRole('searchbox', { name: 'Search YouTube' }).press('Enter');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 2,
    command: { type: 'open_browser' },
  });
  await state(page, [first], first, null, null, 2, { catalog });
  await expect(submit).toBeEnabled();
  await expect(addResult).toBeEnabled();
});

test('submits only explicit YouTube searches, replacing old results while the next query loads', async (t) => {
  const page = await panel(t);
  const view = page.getByRole('navigation', { name: 'Queue and search' });
  const query = page.getByRole('searchbox', { name: 'Search YouTube' });
  const previousResult = page.getByText('<b>Studio piano & strings</b>', {
    exact: true,
  });
  await state(page, [first], first, null, null, 1, {
    catalog: searchState({ query: 'piano', results: [pianoResult] }),
  });
  await expect(view).toBeVisible();
  await view.getByRole('button', { name: 'Search' }).click();
  await expect(query).toHaveValue('piano');
  await expect(previousResult).toBeVisible();
  await expect(
    page.getByText('YouTube · <i>Artist & friends</i>', { exact: true }),
  ).toBeVisible();
  await query.fill('  live music  ');
  expect(await messages(page)).toHaveLength(1);
  await expect(previousResult).toBeVisible();
  await query.press('Enter');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 2,
    command: { type: 'search', query: 'live music' },
  });
  await expect(previousResult).toHaveCount(0);
  await expect(page.getByText('Searching YouTube…')).toBeVisible();
  await expect(query).toBeFocused();

  await state(page, [first], first, null, null, 2, {
    catalog: searchState({ query: 'live music', pending: true }),
  });
  await expect(page.getByText('Searching YouTube…')).toBeVisible();
  await query.fill('cello music');
  await query.press('Enter');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 3,
    command: { type: 'search', query: 'cello music' },
  });
  await state(page, [first], first, null, null, 3, {
    catalog: searchState({
      query: 'cello music',
      problem: 'YouTube search is temporarily unavailable.',
    }),
  });
  const problem = page.getByText('YouTube search is temporarily unavailable.');
  await expect(problem).toHaveAttribute('aria-live', 'polite');
  await state(page, [first], first, null, null, null, {
    catalog: searchState({ query: 'cello music' }),
  });
  await expect(
    page.getByText('No videos found. Try a different search.'),
  ).toBeVisible();
  await expect(problem).toHaveCount(0);
  await expect(query).toHaveValue('cello music');
});

test('adds a YouTube search result by keyboard without clearing the queue draft', async (t) => {
  const page = await panel(t);
  const catalog = searchState({ query: 'piano', results: [pianoResult] });
  await state(page, [first], first, null, null, 1, { catalog });
  const source = page.getByRole('textbox', {
    name: 'YouTube link or video ID',
  });
  await page.getByRole('button', { name: 'Add links' }).click();
  await source.fill(second);
  const view = page.getByRole('navigation', { name: 'Queue and search' });
  await expect(view).toBeVisible();
  await view.getByRole('button', { name: 'Search' }).click();
  const addResult = page.getByRole('button', {
    name: 'Add <b>Studio piano & strings</b> to queue',
  });
  await addResult.press('Enter');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 2,
    command: { type: 'add', source: second },
  });
  const addProblem = 'The queue is full.';
  await state(page, [first], first, addProblem, null, 2, { catalog });
  await expect(page.getByText(addProblem, { exact: true })).toBeVisible();
  await expect(page.getByText('1 video found.', { exact: true })).toBeVisible();
  await expect(addResult).toBeFocused();
  await addResult.press('Enter');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 3,
    command: { type: 'add', source: second },
  });
  await state(page, [first, second], first, null, null, 3, { catalog });
  await expect(page.getByText(addProblem, { exact: true })).toHaveCount(0);
  await expect(
    page.getByText('Added to the queue.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('1 video found.', { exact: true })).toBeVisible();
  await expect(addResult).toBeFocused();
  await view.getByRole('button', { name: 'Queue' }).click();
  await expect(source).toHaveValue(second);
  await expect(page.getByRole('status')).toBeEmpty();
});

test('queues a search result to play next and keeps feedback and focus in Search', async (t) => {
  const page = await panel(t);
  await page.setViewportSize({ width: 384, height: 520 });
  const catalog = searchState({ query: 'piano', results: [pianoResult] });
  await state(page, [first, third], first, null, null, 1, { catalog });
  await transport(page, readyTransport);
  await page.getByRole('button', { name: 'Search' }).press('Enter');
  const list = page.getByRole('list', { name: 'YouTube results' });
  const action = list.getByRole('button', {
    name: `Play ${pianoResult.title} next`,
  });
  await action.press('Enter');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 2,
    command: { type: 'play_next', id: second },
  });
  await expect(action).toBeDisabled();
  await state(
    page,
    [first, third],
    first,
    'Could not save the queue.',
    null,
    2,
    { catalog },
  );
  await expect(page.getByText('Could not save the queue.')).toBeVisible();
  await expect(action).toBeFocused();
  await expect(action).toBeEnabled();
  await action.press('Enter');
  await state(page, [first, second, third], first, null, null, 3, { catalog });
  await expect(
    page.getByText('Queued to play next.', { exact: true }),
  ).toBeVisible();
  await expect(action).toBeFocused();
  await expect(action).toBeDisabled();
  await expect(
    page.getByRole('slider', { name: 'Playback position' }),
  ).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    384,
  );
});

test('fits Queue and Search rows at the minimum panel size alongside playback controls', async (t) => {
  const page = await panel(t);
  await page.setViewportSize({ width: 384, height: 520 });
  const catalog = searchState({
    query: 'music',
    results: [
      {
        id: second,
        title: 'Long search result title '.repeat(10),
        channel: 'LongChannel'.repeat(18),
      },
    ],
  });
  await state(page, [first], first, null, null, 1, {
    metadata: {
      title: 'Current video with a long title and multiple lines '.repeat(8),
      channel: 'Current channel with a long display name '.repeat(8),
    },
    catalog,
  });
  await transport(page, { ...readyTransport, volume: 42, muted: false });
  await page.getByRole('button', { name: 'Volume controls' }).press('Enter');
  const queueList = page.getByRole('list', { name: 'Queue' });
  assertVisibleQueueRow(
    await queueList.boundingBox(),
    await queueList.getByRole('listitem').first().boundingBox(),
  );
  const view = page.getByRole('navigation', { name: 'Queue and search' });
  await expect(view).toBeVisible();
  await view.getByRole('button', { name: 'Search' }).click();
  const list = page.getByRole('list', { name: 'YouTube results' });
  const row = list.getByRole('listitem').first();
  assertVisibleQueueRow(await list.boundingBox(), await row.boundingBox());
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    384,
  );
});

function lyricsState(overrides = {}) {
  return {
    track: 'Original track',
    artist: 'Original artist',
    duration: 180,
    pending: false,
    problem: null,
    result: null,
    ...overrides,
  };
}

test('suspends previous lyrics during an automatic video transition and restores them if canceled', async (t) => {
  const page = await panel(t);
  const lyrics = lyricsState({
    result: { kind: 'plain', lines: ['Current recording'] },
  });
  const render = (lyricsSwitching) =>
    state(page, [first, second], first, null, null, undefined, {
      lyrics,
      lyricsSwitching,
    });
  await render(false);
  const tab = page.getByRole('button', { name: 'Lyrics', exact: true });
  await tab.click();
  await expect(page.getByText('Current recording')).toBeVisible();
  await render(true);
  await expect(page.getByText('Current recording')).toHaveCount(0);
  await expect(page.getByText('Opening the next video…')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Find lyrics' }),
  ).toBeDisabled();
  await render(false);
  await expect(page.getByText('Current recording')).toBeVisible();
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
});

test('only looks up explicitly submitted Lyrics and clears old drafts and results on selection change', async (t) => {
  const page = await panel(t);
  const navigation = page.getByRole('navigation');
  const tab = navigation.getByRole('button', { name: 'Lyrics' });
  const track = page.getByRole('textbox', { name: 'Track' });
  const artist = page.getByRole('textbox', { name: 'Artist' });
  const lookup = page.getByRole('button', { name: 'Find lyrics' });
  const entries = [first, second];
  const catalog = searchState();
  await state(page, entries, first, null, null, 1, { catalog });
  await expect(tab).toHaveCount(0);

  const result = { kind: 'plain', lines: ['<em>Original words</em>'] };
  await state(page, entries, first, null, null, null, {
    catalog,
    lyrics: lyricsState({ duration: null, result }),
  });
  await expect(tab).toBeVisible();
  await tab.press('Enter');
  await expect(track).toBeFocused();
  await expect(track).toHaveValue('Original track');
  await expect(artist).toHaveValue('Original artist');
  await expect(lookup).toBeDisabled();
  await expect(page.getByText('Waiting for video duration…')).toBeVisible();
  await track.fill('  Edited track  ');
  await state(page, entries, first, null, null, null, {
    catalog,
    lyrics: lyricsState({ artist: 'Updated artist', result }),
  });
  await expect(track).toHaveValue('  Edited track  ');
  await expect(artist).toHaveValue('Updated artist');
  await expect(
    page.getByText('<em>Original words</em>', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Lyrics from LRCLIB', { exact: true }),
  ).toBeVisible();
  await artist.fill('  Edited artist  ');
  expect(await messages(page)).toHaveLength(1);
  await artist.press('Enter');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 2,
    command: {
      type: 'find_lyrics',
      title: 'Edited track',
      artist: 'Edited artist',
    },
  });
  await expect(
    page.getByText('<em>Original words</em>', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText('Finding lyrics…')).toBeVisible();

  await state(page, entries, second, null, null, 2, {
    catalog,
    lyrics: lyricsState({ track: 'Next track', artist: 'Next artist' }),
  });
  await expect(track).toHaveValue('Next track');
  await expect(artist).toHaveValue('Next artist');
  await expect(page.getByText('Finding lyrics…')).toHaveCount(0);
  await expect(page.locator('#selection-id')).toHaveText(second);
  await state(page, entries, second, null, null, null, {
    catalog,
    lyrics: null,
  });
  await expect(tab).toHaveCount(0);
  await expect(
    page.getByRole('searchbox', { name: 'Filter queue' }),
  ).toBeFocused();
});

test('uses sampled lyric timing for one active line, word or instrumental gap', async (t) => {
  const page = await panel(t);
  const result = {
    kind: 'synced',
    lines: [
      { timeMs: 0, text: '', words: [] },
      {
        timeMs: 1000,
        text: '<b>Words</b> here',
        words: [
          { timeMs: 1000, text: '<b>Words</b> ' },
          { timeMs: 1500, text: 'here' },
        ],
      },
      { timeMs: 2400, text: '', words: [] },
      {
        timeMs: 3500,
        text: 'Plain fallback',
        words: [{ timeMs: 3500, text: 'Other words' }],
      },
    ],
  };
  const sample = (positionMs, clockRunning) =>
    transport(page, { ...readyTransport, positionMs, clockRunning });
  await state(page, [first], first, null, null, 1, {
    lyrics: lyricsState({ result }),
  });
  const tab = page
    .getByRole('navigation')
    .getByRole('button', { name: 'Lyrics' });
  await expect(tab).toBeVisible();
  await tab.click();
  const list = page.getByRole('list', { name: 'Lyrics' });
  const lines = list.getByRole('listitem');
  const gap = list.getByRole('img', { name: 'Instrumental break' });
  await sample(400, true);
  await expect(gap).toHaveCount(1);
  await expect(gap.locator('span')).toHaveCount(3);
  await expect(lines.nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(gap).toHaveAttribute('data-running', '');
  await sample(1100, true);
  await expect(gap).toHaveCount(0);
  await expect(lines.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(lines.nth(1)).toHaveText('<b>Words</b> here');
  await expect(lines.nth(1).locator('b')).toHaveCount(0);
  await expect(list.locator('[data-active-word]')).toHaveText('<b>Words</b>');
  await sample(1500, false);
  await expect(list.locator('[data-active-word]')).toHaveText('here');
  await sample(2600, false);
  await expect(gap).toHaveCount(1);
  await expect(gap).not.toHaveAttribute('data-running', '');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await sample(2600, true);
  await expect(gap).toHaveCSS('animation-name', 'none');
  await sample(3600, true);
  await expect(lines.nth(3)).toHaveAttribute('aria-current', 'true');
  await expect(lines.nth(3)).toHaveText('Plain fallback');
  await expect(list.locator('[data-active-word]')).toHaveCount(0);
  await sample(null, false);
  await expect(list.locator('[aria-current]')).toHaveCount(0);

  await state(page, [first], first, null, null, null, {
    lyrics: lyricsState({ result: { kind: 'instrumental' } }),
  });
  await expect(page.getByText('Instrumental track.')).toBeVisible();
  await expect(gap).toHaveCount(0);
});

async function timedLyricsPane(t) {
  const page = await panel(t);
  const result = {
    kind: 'synced',
    lines: [
      {
        timeMs: 1000,
        text: 'One two',
        words: [
          { timeMs: 1000, text: 'One ' },
          { timeMs: 1200, text: 'two' },
        ],
      },
      { timeMs: 1500, text: 'Second line', words: [] },
      { timeMs: 1900, text: 'Last line in this sample', words: [] },
      { timeMs: 2150, text: 'Beyond the first sample', words: [] },
      { timeMs: 3100, text: 'Beyond duration', words: [] },
    ],
  };
  const lyrics = lyricsState({ result });
  const entries = [first, second];
  await state(page, entries, first, null, null, 1, { lyrics });
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Lyrics' })
    .click();
  const time = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(new Date(time.getTime() + 1000));
  return {
    page,
    lyrics,
    entries,
    activeLine: page.locator('#lyrics-lines [aria-current]'),
    activeWord: page.locator('#lyrics-lines [data-active-word]'),
    sample: (positionMs, options = {}) =>
      transport(page, {
        ...readyTransport,
        position: Math.floor(positionMs / 1000),
        duration: 3,
        positionMs,
        clockRunning: true,
        ...options,
      }),
  };
}

test('volume and mute commands keep the current lyric clock advancing', async (t) => {
  const { page, lyrics, entries, activeLine, activeWord, sample } =
    await timedLyricsPane(t);
  await sample(1000, { volume: 40, muted: false });
  await expect(activeWord).toHaveText('One');
  await page.getByRole('button', { name: 'Volume controls' }).press('Enter');
  await page.getByRole('button', { name: 'Mute', exact: true }).press('Enter');
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'set_muted',
    muted: true,
  });
  await page.clock.runFor(225);
  await expect(activeWord).toHaveText('two');
  await state(page, entries, first, null, null, null, { lyrics });
  await expect(page.getByRole('slider', { name: 'Volume' })).toBeDisabled();
  await state(page, entries, first, null, null, undefined, { lyrics });
  await page.getByRole('slider', { name: 'Volume' }).press('ArrowRight');
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'set_volume',
    volume: 41,
  });
  await page.clock.runFor(300);
  await expect(activeLine).toHaveText('Second line');
});

test('advances subsecond lyric cues from one sample and stops at the clock and duration bounds', async (t) => {
  const { page, lyrics, entries, activeLine, activeWord, sample } =
    await timedLyricsPane(t);
  await sample(1000);
  await expect(activeWord).toHaveText('One');
  await page.clock.runFor(225);
  await expect(activeWord).toHaveText('two');
  await state(page, entries, first, null, null, null, { lyrics });
  await sample(1000);
  await page.clock.runFor(325);
  await expect(activeLine).toHaveText('Second line');
  await page.clock.runFor(1600);
  await expect(activeLine).toHaveText('Last line in this sample');

  await sample(1800, { playbackRate: 2 });
  await page.clock.runFor(85);
  await expect(activeLine).toHaveText('Last line in this sample');
  await page.clock.runFor(145);
  await expect(activeLine).toHaveText('Beyond the first sample');
  await page.clock.runFor(750);
  await expect(activeLine).toHaveText('Beyond the first sample');
});

test('cancels lyric cue timers during pause, seek and panel or document hide', async (t) => {
  const { page, activeLine, activeWord, sample } = await timedLyricsPane(t);
  await sample(1000);
  await page.clock.runFor(80);
  await sample(1080, { clockRunning: false });
  await page.clock.runFor(700);
  await expect(activeWord).toHaveText('One');

  await sample(1020);
  const seek = page.getByRole('slider', { name: 'Playback position' });
  await seek.dispatchEvent('pointerdown');
  await page.clock.runFor(700);
  await expect(activeWord).toHaveText('One');
  await seek.dispatchEvent('pointercancel');

  await sample(1030);
  const navigation = page.getByRole('navigation');
  await navigation.getByRole('button', { name: 'Queue' }).press('Enter');
  await page.clock.runFor(700);
  await navigation.getByRole('button', { name: 'Lyrics' }).press('Enter');
  await expect(activeWord).toHaveText('One');

  await sample(1040);
  await page.evaluate(() => window.setPearPanelVisible?.(false));
  await page.clock.runFor(700);
  await expect(activeWord).toHaveText('One');
  await page.evaluate(() => window.setPearPanelVisible?.(true));
  await sample(1060);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(700);
  await expect(activeWord).toHaveText('One');
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await sample(1065);
  await sample(1080, { playing: true, clockRunning: false });
  await page.clock.runFor(700);
  await expect(activeWord).toHaveText('One');

  await sample(1070);
  await page.getByRole('button', { name: 'Next video' }).press('Enter');
  await page.clock.runFor(700);
  await expect(activeLine).toHaveText('One two');
  await expect(activeWord).toHaveText('One');
});

test('fits a complete lyric line at the minimum panel size with all views and long playing metadata', async (t) => {
  const page = await panel(t);
  await page.setViewportSize({ width: 384, height: 520 });
  await state(page, [first], first, null, null, 1, {
    catalog: searchState(),
    metadata: {
      title: 'Current video with a long title and multiple lines '.repeat(8),
      channel: 'Current channel with a long display name '.repeat(8),
    },
    lyrics: lyricsState({
      result: {
        kind: 'plain',
        lines: ['A long lyric line that still wraps safely. '.repeat(5)],
      },
    }),
  });
  await transport(page, {
    ...readyTransport,
    positionMs: 9000,
    clockRunning: true,
    volume: 42,
    muted: false,
  });
  const tab = page
    .getByRole('navigation')
    .getByRole('button', { name: 'Lyrics' });
  await expect(tab).toBeVisible();
  await tab.click();
  await page.getByRole('button', { name: 'Volume controls' }).press('Enter');
  await expect(page.getByRole('slider', { name: 'Volume' })).toBeVisible();
  const list = page.getByRole('list', { name: 'Lyrics' });
  assertVisibleQueueRow(
    await list.boundingBox(),
    await list.getByRole('listitem').first().boundingBox(),
  );
  await expect(
    page.getByRole('slider', { name: 'Playback position' }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    384,
  );
});

function savedPlaylists(overrides = {}) {
  return {
    lists: [],
    selected: null,
    problem: null,
    canSave: true,
    ...overrides,
  };
}

test('saves the queue with a validated playlist name and preserves a draft on an unrelated update', async (t) => {
  const page = await panel(t);
  const library = page.getByRole('button', { name: 'Library' });
  await state(page, [first], first);
  await expect(library).toHaveCount(0);
  const render = (snapshot, sequence) =>
    state(page, [first], first, null, null, sequence, {
      savedPlaylists: snapshot,
    });
  await render(
    savedPlaylists({ problem: 'Playlists are unavailable.', canSave: false }),
    null,
  );
  await library.click();
  await expect(page.getByText('Playlists are unavailable.')).toBeVisible();
  const save = page.getByRole('button', { name: 'Save queue' });
  await expect(save).toBeDisabled();
  expect(await save.getAttribute('aria-disabled')).toBeNull();

  await render(savedPlaylists(), null);
  const name = page.getByRole('textbox', { name: 'Playlist name' });
  await name.fill('🌿'.repeat(81));
  await name.press('Enter');
  await expect(page.getByText(/80 characters/)).toBeVisible();
  expect(await messages(page)).toHaveLength(1);

  const playlistName = '🌿'.repeat(80);
  await name.fill(playlistName);
  await name.press('Enter');
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'save_playlist',
    name: playlistName,
  });
  await render(savedPlaylists(), null);
  await expect(name).toHaveValue(playlistName);
  await expect(name).toBeFocused();
  await render(
    savedPlaylists({ lists: [{ id: 1, name: playlistName, count: 1 }] }),
  );
  await expect(name).toHaveValue('');
  await expect(page.getByRole('button', { name: playlistName })).toBeVisible();
  await expect(page.locator('#selection-id')).toHaveText(first);
});

test('browses and edits a playlist, with separate queue and playback commands', async (t) => {
  const page = await panel(t);
  const id = 1;
  const name = '<b>Morning</b>';
  const title = '<em>Track & more</em>';
  const selected = { id, name, entries: [second], titles: { [second]: title } };
  const lists = [{ id, name, count: 1 }];
  const render = ({
    entries = [first],
    current = first,
    snapshot = savedPlaylists({ lists }),
    error = null,
    sequence,
  } = {}) =>
    state(page, entries, current, error, null, sequence, {
      savedPlaylists: snapshot,
    });
  await render();
  await page.getByRole('button', { name: 'Library' }).click();
  const playlist = page.getByRole('button', { name });
  await playlist.press('Enter');
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'open_playlist',
    id,
  });
  await render({ snapshot: savedPlaylists({ lists, selected }) });
  const heading = page.getByRole('heading', { name });
  await expect(heading).toBeFocused();
  await expect(heading.locator('b')).toHaveCount(0);

  await page.getByRole('button', { name: 'Add to queue' }).click();
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'append_playlist',
    id,
  });
  await render({
    entries: [first, second],
    snapshot: savedPlaylists({ lists, selected }),
  });
  await expect(page.locator('#selection-id')).toHaveText(first);
  await page.getByRole('button', { name: `Select ${title}` }).press('Enter');
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'select_playlist_track',
    id,
    video: second,
  });
  await render({
    entries: [first, second],
    current: second,
    snapshot: savedPlaylists({ lists, selected }),
  });
  await expect(page.locator('#selection-id')).toHaveText(second);

  await page.getByRole('button', { name: 'Rename' }).click();
  const rename = page.getByRole('textbox', { name: 'Playlist name' });
  await expect(rename).toBeFocused();
  await rename.fill('Evening');
  await rename.press('Enter');
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'rename_playlist',
    id,
    name: 'Evening',
  });
  await render({
    snapshot: savedPlaylists({ lists, selected }),
    error: 'Could not update playlist.',
  });
  await expect(rename).toHaveValue('Evening');
  await expect(page.getByText('Could not update playlist.')).toBeVisible();
  await rename.press('Enter');
  await rename.fill('Midnight');
  await render({
    snapshot: savedPlaylists({
      lists: [{ id, name: 'Evening', count: 1 }],
      selected: { ...selected, name: 'Evening' },
    }),
  });
  await expect(rename).toBeVisible();
  await expect(rename).toHaveValue('Midnight');
  await expect(rename).toBeFocused();
  await rename.press('Enter');
  const renamed = { ...selected, name: 'Midnight' };
  const updated = [{ id, name: renamed.name, count: 1 }];
  await render({
    snapshot: savedPlaylists({ lists: updated, selected: renamed }),
  });
  await expect(page.getByRole('heading', { name: 'Midnight' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rename' })).toBeFocused();

  await page.getByRole('button', { name: 'Back to playlists' }).press('Enter');
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'close_playlist',
  });
  await render({ snapshot: savedPlaylists({ lists: updated }) });
  const renamedRow = page.getByRole('button', { name: 'Midnight' });
  await expect(renamedRow).toBeFocused();
  await renamedRow.press('Enter');
  await render({
    snapshot: savedPlaylists({ lists: updated, selected: renamed }),
  });

  const sent = (await messages(page)).length;
  await page
    .getByRole('button', { name: 'Remove', exact: true })
    .press('Enter');
  await expect(page.getByText('Remove this playlist?')).toBeVisible();
  expect(await messages(page)).toHaveLength(sent);
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.getByRole('button', { name: 'Remove playlist' }).press('Enter');
  expect((await messages(page)).at(-1).command).toEqual({
    type: 'remove_playlist',
    id,
  });
  await render({ snapshot: savedPlaylists() });
  await expect(
    page.getByRole('textbox', { name: 'Playlist name' }),
  ).toBeFocused();
});

test('keeps Library rows scrollable and preserves focus on unrelated updates at 384×520', async (t) => {
  const page = await panel(t);
  await page.setViewportSize({ width: 384, height: 520 });
  const long = 'A long name that still fits at minimum width '.repeat(7);
  const lists = Array.from({ length: 24 }, (_, i) => ({
    id: i + 1,
    name: `Playlist ${i}`,
    count: 1,
  }));
  const snapshot = savedPlaylists({ lists });
  const render = (savedPlaylists, sequence) =>
    state(page, [first], first, null, null, sequence, {
      savedPlaylists,
      catalog: searchState(),
      lyrics: lyricsState(),
      metadata: { title: long, channel: long },
    });
  await render(snapshot);
  await transport(page, { ...readyTransport, volume: 42, muted: false });
  await page.getByRole('button', { name: 'Volume controls' }).press('Enter');
  await page.getByRole('button', { name: 'Library' }).click();
  const list = page.getByRole('list', { name: 'Saved playlists' });
  const row = list.getByRole('button', { name: 'Playlist 9', exact: true });
  await row.focus();
  const scroll = await list.evaluate((element) => element.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await row.evaluate((element) => {
    window.savedPlaylistRow = element;
  });
  await render(snapshot, null);
  await expect(row).toBeFocused();
  expect(
    await row.evaluate((element) => element === window.savedPlaylistRow),
  ).toBe(true);
  expect(await list.evaluate((element) => element.scrollTop)).toBe(scroll);
  await row.press('Enter');
  await render(
    savedPlaylists({
      lists,
      selected: {
        id: 10,
        name: long,
        entries: [second],
        titles: { [second]: long },
      },
    }),
  );
  const tracks = page.getByRole('list', { name: 'Playlist tracks' });
  assertVisibleQueueRow(
    await tracks.boundingBox(),
    await tracks.getByRole('listitem').first().boundingBox(),
  );
  await page.getByRole('button', { name: 'Back to playlists' }).press('Enter');
  await render(snapshot);
  await expect(row).toBeFocused();
  expect(await list.evaluate((element) => element.scrollTop)).toBe(scroll);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    384,
  );
});

test('updates the player alert independently from queue acknowledgements and validation', async (t) => {
  const page = await panel(t);
  const playerProblem = 'The video player stopped. Use Reload Player.';
  const validation = 'Enter a valid YouTube link or video ID.';
  const playerAlert = page
    .getByRole('region', { name: 'Now playing' })
    .getByRole('alert');
  const queueError = page.locator('#queue-error');
  const input = page.getByRole('textbox', { name: 'YouTube link or video ID' });

  await state(page, [first], first, null, null, 1, { playerProblem });
  await expect(playerAlert).toHaveText(playerProblem);
  await page.getByRole('button', { name: 'Add links' }).click();
  await input.fill(second);
  await input.press('Enter');
  await state(page, [first, second], first, null, null, null, {
    playerProblem,
  });
  await expect(input).toHaveValue(second);
  await state(page, [first, second], first, null, null, 2, { playerProblem });
  await expect(input).toHaveValue('');
  await expect(page.getByRole('status')).toHaveText('Added to the queue.');
  await expect(playerAlert).toHaveText(playerProblem);

  await input.fill('invalid');
  await input.press('Enter');
  await state(page, [first, second], first, validation, null, 3, {
    playerProblem,
  });
  await expect(queueError).toHaveText(validation);
  await state(page, [first, second], first, null, null, null, {
    playerProblem: null,
  });
  await expect(playerAlert).toHaveText('');
  await expect(queueError).toHaveText(validation);
  await expect(input).toHaveValue('invalid');
});

test('moves a row by keyboard and click and keeps focus at a queue boundary', async (t) => {
  const page = await panel(t);
  await state(page, [first, second, third], second);

  const up = page.getByRole('button', { name: `Move ${second} up` });
  const down = page.getByRole('button', { name: `Move ${second} down` });
  await expect(
    page.getByRole('button', { name: `Move ${first} up` }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: `Move ${third} down` }),
  ).toBeDisabled();
  await up.focus();
  await page.keyboard.press('Space');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 2,
    command: { type: 'move_up', id: second },
  });
  await state(page, [second, first, third], second);
  await expect(page.locator('#position')).toHaveText('1 of 3');
  await expect(up).toBeDisabled();
  await expect(up).toBeFocused();
  await expect(page.getByRole('status')).toContainText(
    'Moved to position 1 of 3',
  );
  await page.keyboard.press('Enter');
  expect(await messages(page)).toHaveLength(2);

  await down.click();
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 3,
    command: { type: 'move_down', id: second },
  });
  await state(page, [first, second, third], second);
  await expect(page.locator('#position')).toHaveText('2 of 3');
  await expect(down).toBeFocused();
});
