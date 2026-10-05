import { test, expect } from '@playwright/test';
import { Window } from 'happy-dom';
async function loadController() {
  return import('../src/plugins/compact-sidebar/dom.ts') as Promise<{
    createCompactSidebarController(document: Document): {
      start(): void;
      stop(): void;
    };
  }>;
}

function installNativeSidebarFixture(
  document: Document,
  initiallyCompact: boolean,
) {
  document.body.innerHTML = `
    <ytmusic-app-layout>
      <button id="button">Unrelated button</button>
      <div aria-controls="guide">Unrelated non-control</div>
      <button id="native-navigation-toggle" aria-controls="guide" aria-label="Navigation menu">Toggle navigation</button>
      <div id="mini-guide" ${initiallyCompact ? '' : 'hidden'}>Compact navigation</div>
      <div id="guide" ${initiallyCompact ? 'hidden' : ''}>Expanded navigation</div>
    </ytmusic-app-layout>
  `;
  const toggle = document.querySelector<HTMLButtonElement>(
    '#native-navigation-toggle',
  )!;
  const compact = document.querySelector<HTMLElement>('#mini-guide')!;
  const expanded = document.querySelector<HTMLElement>('#guide')!;
  const setCompact = (value: boolean) => {
    compact.hidden = !value;
    expanded.hidden = value;
  };
  toggle.addEventListener('click', () => setCompact(compact.hidden));
}

test('enforces the native compact state through the explicit navigation control and restores prior state', async () => {
  const dom = new Window();
  const { createCompactSidebarController } = await loadController();
  const { document } = dom;
  installNativeSidebarFixture(document, false);
  const unrelatedButton = document.querySelector<HTMLButtonElement>('#button')!;
  let unrelatedClicks = 0;
  unrelatedButton.addEventListener('click', () => unrelatedClicks++);
  const controller = createCompactSidebarController(document);

  controller.start();
  await dom.happyDOM.whenAsyncComplete();
  expect(document.querySelector<HTMLElement>('#mini-guide')?.hidden).toBe(
    false,
  );
  expect(unrelatedClicks).toBe(0);

  controller.stop();
  expect(document.querySelector<HTMLElement>('#mini-guide')?.hidden).toBe(true);
  expect(document.querySelector<HTMLElement>('#guide')?.hidden).toBe(false);
  await dom.happyDOM.close();
});

test('keeps a sidebar that was already compact when the plugin stops', async () => {
  const dom = new Window();
  const { createCompactSidebarController } = await loadController();
  const { document } = dom;
  installNativeSidebarFixture(document, true);
  const controller = createCompactSidebarController(document);

  controller.start();
  controller.start();
  controller.stop();
  controller.stop();

  expect(document.querySelector<HTMLElement>('#mini-guide')?.hidden).toBe(
    false,
  );
  expect(document.querySelector<HTMLElement>('#guide')?.hidden).toBe(true);
  await dom.happyDOM.close();
});
