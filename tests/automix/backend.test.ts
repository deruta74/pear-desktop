import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { expect, test } from '@playwright/test';
import { resolvePlayableAudio } from '../../src/plugins/utils/main/playable-audio';

function fixture() {
  const handlers = new Map<string, (id: string) => Promise<unknown>>();
  let finish: (url: string) => void = () => {};
  let bytes = 1024;
  const yt = {
    session: {},
    getBasicInfo: async (id: string) => ({
      basic_info: { id, is_live: false },
      streaming_data: {
        adaptive_formats: [
          {
            has_audio: true,
            has_video: false,
            is_type_otf: false,
            mime_type: 'audio/webm',
            bitrate: 128000,
            content_length: bytes,
            itag: 251,
            is_original: true,
            decipher: () =>
              new Promise<string>((resolve) => (finish = resolve)),
          },
        ],
      },
    }),
  };
  const source = stripTypeScriptTypes(
    readFileSync(
      new URL('../../src/plugins/automix/backend.ts', import.meta.url),
      'utf8',
    ),
  )
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace('export const backend', 'globalThis.backend');
  const context: any = {
    createBackend: (value: unknown) => value,
    Innertube: { create: async () => yt },
    getNetFetchAsFetch: () => () => {
      throw new Error('No network in fixture');
    },
    setupStreamEvaluator() {},
    resolvePlayableAudio,
    mintVideoProof: async () => 'proof',
    MAX_STREAM_BYTES: 16 * 1024 * 1024,
    AbortController,
    AbortSignal,
  };
  runInNewContext(source, context);
  const ipc = {
    handle: (key: string, fn: any) => handlers.set(key, fn),
    removeHandler: (key: string) => handlers.delete(key),
  };
  return {
    backend: context.backend,
    ipc,
    handlers,
    finish: () => finish('https://r1.googlevideo.com/audio'),
    setBytes: (value: number) => (bytes = value),
  };
}

test('actual AutoMix backend bounds concurrent requests and suppresses late decipher after stop', async () => {
  const f = fixture();
  await f.backend.start({ ipc: f.ipc });
  const invoke = f.handlers.get('peard:automix:audio-url')!;
  const first = invoke('AAAAAAAAAAA');
  expect(await invoke('BBBBBBBBBBB')).toBeNull();
  await new Promise((resolve) => setImmediate(resolve));
  f.backend.stop();
  f.finish();
  expect(await first).toBeNull();
  expect(f.handlers.size).toBe(0);
});

test('actual AutoMix backend rejects oversized shared-helper streams', async () => {
  const f = fixture();
  f.setBytes(17 * 1024 * 1024);
  await f.backend.start({ ipc: f.ipc });
  const request = f.handlers.get('peard:automix:audio-url')!('AAAAAAAAAAA');
  await new Promise((resolve) => setImmediate(resolve));
  f.finish();
  expect(await request).toBeNull();
  f.backend.stop();
});
