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
          "default-src 'none'; script-src 'self'; style-src 'self'",
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

async function state(
  page,
  entries,
  current = null,
  error = null,
  notice = null,
  sequence,
  { titles, playerProblem, metadata, metadataProblem } = {},
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
      queueState: { entries, current, titles, metadata, metadataProblem },
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
    .locator('.playback-actions button')
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
  await expect(page.getByRole('button', { name: 'Add' })).toBeDisabled();
  await state(page, [first], first, null, 'Player is ready.');
  await expect(input).toHaveValue('');
  await expect(page.locator('#queue-error')).toHaveText('');
  await expect(page.getByRole('status')).toContainText('Player is ready.');
  await expect(page.getByRole('status')).toContainText('Added');
});

test('submits a multiline paste once and retains it when a line is invalid', async (t) => {
  const page = await panel(t);
  await state(page, [first], first);
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
  await page.getByRole('button', { name: 'Add' }).click();
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
  await expect(page.locator('img')).toHaveCount(0);
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
    .getByRole('region', { name: 'Current video' })
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

test('fits a queue row at the minimum panel size while displaying long YouTube metadata', async (t) => {
  const page = await panel(t);
  await page.setViewportSize({ width: 384, height: 520 });
  const entries = [first, second, third];
  await state(page, entries, first, null, null, 1, {
    metadata: {
      title: 'A long video title that takes multiple lines '.repeat(5),
      channel: 'A channel with a long display name '.repeat(8),
    },
  });
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

test('updates the player alert independently from queue acknowledgements and validation', async (t) => {
  const page = await panel(t);
  const playerProblem = 'The video player stopped. Use Reload Player.';
  const validation = 'Enter a valid YouTube link or video ID.';
  const playerAlert = page
    .getByRole('region', { name: 'Current video' })
    .getByRole('alert');
  const queueError = page.locator('#queue-error');
  const input = page.getByRole('textbox', { name: 'YouTube link or video ID' });

  await state(page, [first], first, null, null, 1, { playerProblem });
  await expect(playerAlert).toHaveText(playerProblem);
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
