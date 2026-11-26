import { readFile, access } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';

const first = 'firstVideo_';
const second = 'secondVideo';
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

async function panel(t) {
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
  await page.addInitScript(() => {
    window.pearMessages = [];
    window.ipc = {
      postMessage: (message) => window.pearMessages.push(JSON.parse(message)),
    };
  });
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
) {
  if (sequence === undefined) sequence = (await messages(page)).at(-1).sequence;
  return page.evaluate(
    ({ entries, current, error, notice, sequence }) => {
      window.renderPearState({ entries, current }, error, notice, sequence);
    },
    { entries, current, error, notice, sequence },
  );
}

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
  await expect(page.getByRole('alert')).toContainText(
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
  await expect(page.getByRole('alert')).toHaveText('');
  await expect(page.getByRole('status')).toContainText('Player is ready.');
  await expect(page.getByRole('status')).toContainText('Added');
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
  await expect(page.getByRole('alert')).toContainText('too long');
  expect(await messages(page)).toHaveLength(1);

  await input.fill(first);
  await input.press('Enter');
  expect((await messages(page)).at(-1)).toEqual({
    sequence: 2,
    command: { type: 'add', source: first },
  });
});
