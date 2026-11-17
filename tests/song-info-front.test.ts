import { test, expect } from '@playwright/test';
import { Window } from 'happy-dom';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const requireRoot = createRequire(path.join(root, 'package.json'));

test('playing and pausing at time zero publish playback state', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-song-state-'));
  const dom = new Window();
  const received: unknown[][] = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = new Map(
    [
      'window',
      'document',
      'CustomEvent',
      'HTMLVideoElement',
      'MutationObserver',
    ].map((key) => [key, globals[key]]),
  );
  try {
    const renderer = dom as unknown as Record<string, unknown>;
    renderer.ipcRenderer = {
      on: () => {},
      send: (...args: unknown[]) => received.push(args),
    };
    globals.window = dom;
    globals.document = dom.document;
    globals.CustomEvent = dom.CustomEvent;
    globals.HTMLVideoElement = dom.HTMLVideoElement;
    globals.MutationObserver = dom.MutationObserver;
    dom.document.body.innerHTML = '<video></video>';
    const entry = path.join(directory, 'entry.ts');
    await writeFile(
      entry,
      `export {setupSongInfo} from ${JSON.stringify(path.join(root, 'src/providers/song-info-front.ts'))};`,
    );
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      resolve: { alias: { '@': path.join(root, 'src') } },
      build: {
        ssr: true,
        outDir: directory,
        emptyOutDir: false,
        rollupOptions: {
          input: entry,
          external: ['electron'],
          output: { format: 'cjs', entryFileNames: 'source.cjs' },
        },
      },
    });
    const source = requireRoot(path.join(directory, 'source.cjs'));
    const api = {
      addEventListener: () => {},
      removeEventListener: () => {},
      getVideoData: () => ({}),
      getPlayerResponse: () => ({ videoDetails: {} }),
    };
    source.setupSongInfo(api);
    const video = dom.document.querySelector('video')!;
    video.currentTime = 0;
    video.dispatchEvent(new dom.Event('playing'));
    video.dispatchEvent(new dom.Event('pause'));
    expect(
      received.filter(([channel]) => channel === 'peard:play-or-paused'),
    ).toEqual([
      ['peard:play-or-paused', { isPaused: false, elapsedSeconds: 0 }],
      ['peard:play-or-paused', { isPaused: true, elapsedSeconds: 0 }],
    ]);
  } finally {
    dom.happyDOM.abort();
    for (const [key, value] of saved) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
