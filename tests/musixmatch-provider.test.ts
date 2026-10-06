import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const requireVite = createRequire(requireRoot.resolve('vite'));
const cacheKey = 'ytm:synced-lyrics:mxm:token';
const song = {
  videoId: 'public-fixture',
  title: 'Yellow',
  artist: 'Coldplay',
  songDuration: 269,
};
let directory: string;
let code: Buffer;
let fixtureIndex = 0;

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'pear-mxm-provider-test-'));
  const entry = path.join(directory, 'entry.ts');
  await writeFile(
    entry,
    `export {MusixMatch} from ${JSON.stringify(path.join(root, 'src/plugins/synced-lyrics/providers/MusixMatch.ts'))};`,
  );
  const { rolldown } = await import(
    pathToFileURL(requireVite.resolve('rolldown')).href
  );
  const build = await rolldown({
    input: entry,
    platform: 'node',
    plugins: [
      {
        name: 'only-owned-transport-boundary',
        resolveId(id: string, importer?: string) {
          if (
            id === '../renderer' &&
            importer?.replaceAll('\\', '/').endsWith('/providers/MusixMatch.ts')
          )
            return '\0transport';
          if (
            !id.startsWith('.') &&
            !path.isAbsolute(id) &&
            !id.startsWith('\0')
          )
            return {
              id: requireRoot.resolve(id).replaceAll('\\', '/'),
              external: true,
            };
        },
        load(id: string) {
          if (id === '\0transport')
            return 'export const netFetch=(...args)=>globalThis.mxmTestTransport(...args);';
        },
      },
    ],
  });
  const output = path.join(directory, 'source.cjs');
  await build.write({ file: output, format: 'cjs' });
  await build.close();
  code = await readFile(output);
});

test.afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

type Call = {
  endpoint: string;
  url: URL;
  headers: Headers;
  index: number;
};
type Reply = { status?: number; value?: unknown; raw?: string };

function macro(
  track: Record<string, unknown> = {},
  { lrc, modern = false }: { lrc?: string; modern?: boolean } = {},
) {
  return {
    message: {
      header: { status_code: 200 },
      body: {
        macro_calls: {
          'matcher.track.get': {
            message: {
              header: { status_code: 200 },
              body: {
                track: {
                  track_id: 461806032,
                  track_name: 'Yellow',
                  artist_name: 'Coldplay',
                  track_length: 267,
                  ...track,
                },
              },
            },
          },
          'track.lyrics.get': {
            message: {
              header: { status_code: 200 },
              body: {
                lyrics: {
                  lyrics_body: 'yellow verse',
                  ...(modern
                    ? {}
                    : {
                        instrumental: 0,
                        lyrics_language: 'en',
                        lyrics_language_description: 'English',
                      }),
                },
              },
            },
          },
          'track.subtitles.get': {
            message: {
              header: { status_code: lrc ? 200 : 404 },
              body: lrc
                ? {
                    subtitle_list: [
                      {
                        subtitle: {
                          subtitle_body: lrc,
                          ...(modern
                            ? {}
                            : {
                                subtitle_length: 269,
                                subtitle_language: 'en',
                              }),
                        },
                      },
                    ],
                  }
                : [],
            },
          },
        },
      },
    },
  };
}

const unauthorized = {
  message: { header: { status_code: 401 }, body: [] },
};

async function fixture(
  handler: (
    call: Call,
  ) => Reply | Promise<Reply | undefined> | undefined = () => undefined,
  stored?: string,
) {
  const globals = globalThis as unknown as Record<string, unknown>;
  const storageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'localStorage',
  );
  const values = new Map(stored === undefined ? [] : [[cacheKey, stored]]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  const oldTransport = globals.mxmTestTransport;
  const oldError = console.error;
  const diagnostics: unknown[][] = [];
  console.error = (...args: unknown[]) => diagnostics.push(args);
  const calls: Call[] = [];
  let tokens = 0;
  globals.mxmTestTransport = async (
    address: string,
    init: RequestInit = {},
  ) => {
    if (calls.length >= 12) throw new Error('Fixture request budget exceeded');
    const url = new URL(address);
    const call = {
      endpoint: url.pathname.split('/').at(-1)!,
      url,
      headers: new Headers(init.headers),
      index: calls.length,
    };
    calls.push(call);
    const reply = (await handler(call)) ?? {
      value:
        call.endpoint === 'token.get'
          ? {
              message: {
                header: { status_code: 200 },
                body: { user_token: `fixture-token-${++tokens}` },
              },
            }
          : macro(),
    };
    return [reply.status ?? 200, reply.raw ?? JSON.stringify(reply.value), {}];
  };
  const modulePath = path.join(directory, `fixture-${fixtureIndex++}.cjs`);
  await writeFile(modulePath, code);
  const { MusixMatch } = requireRoot(modulePath);
  const provider = new MusixMatch();
  return {
    provider,
    calls,
    diagnostics,
    count: (endpoint: string) =>
      calls.filter((call) => call.endpoint === endpoint).length,
    close: () => {
      console.error = oldError;
      globals.mxmTestTransport = oldTransport;
      if (storageDescriptor)
        Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
      else delete globals.localStorage;
      delete requireRoot.cache[modulePath];
    },
  };
}

test('actual provider uses the public mobile client contract and returns correct plain lyrics', async () => {
  const f = await fixture();
  try {
    const result = await f.provider.search(song);
    expect(result).toMatchObject({
      title: 'Yellow',
      artists: ['Coldplay'],
      lyrics: 'yellow verse',
    });
    for (const call of f.calls) {
      expect(call.url.hostname).toBe('apic-appmobile.musixmatch.com');
      expect(call.url.searchParams.get('app_id')).toBe('mac-ios-v2.0');
      expect(call.headers.get('x-cookie')).toBe('x-mxm-token-guid=');
      expect(call.headers.get('x-mxm-app-version')).toBe('10.1.1');
    }
  } finally {
    f.close();
  }
});

test('actual provider rejects the live wrong-popular-track response for Yellow', async () => {
  const f = await fixture((call) =>
    call.endpoint === 'macro.subtitles.get'
      ? {
          value: macro({
            track_id: 226291677,
            track_name: 'NOKIA',
            artist_name: 'Drake',
          }),
        }
      : undefined,
  );
  try {
    expect(await f.provider.search(song)).toBeNull();
  } finally {
    f.close();
  }
});

for (const track of [
  { track_name: 'Paradise', artist_name: 'Coldplay' },
  { track_name: 'Yellow', artist_name: 'Drake' },
  { track_name: 'Yellow (Live)', artist_name: 'Coldplay' },
  { track_name: 'Yellow', artist_name: 'Coldplay', track_length: 400 },
])
  test(`rejects unrelated title/artist/version/duration ${JSON.stringify(track)}`, async () => {
    const f = await fixture((call) =>
      call.endpoint === 'macro.subtitles.get'
        ? { value: macro(track) }
        : undefined,
    );
    try {
      expect(await f.provider.search(song)).toBeNull();
    } finally {
      f.close();
    }
  });

test('legitimate Paradise is not rejected by an obsolete one-track blacklist', async () => {
  const f = await fixture((call) =>
    call.endpoint === 'macro.subtitles.get'
      ? {
          value: macro({
            track_id: 115264642,
            track_name: 'Paradise',
            track_length: 269,
          }),
        }
      : undefined,
  );
  try {
    expect(
      await f.provider.search({ ...song, title: 'Paradise' }),
    ).toMatchObject({
      title: 'Paradise',
      artists: ['Coldplay'],
    });
  } finally {
    f.close();
  }
});

test('modern optional lyric/subtitle metadata preserves actual LRC output compatibility', async () => {
  const f = await fixture((call) =>
    call.endpoint === 'macro.subtitles.get'
      ? {
          value: macro(
            {},
            { modern: true, lrc: '[00:01.00]first\n[00:02.00]second' },
          ),
        }
      : undefined,
  );
  try {
    const result = await f.provider.search(song);
    expect(result.lyrics).toBe('yellow verse');
    expect(result.lines.map((line: any) => [line.timeInMs, line.text])).toEqual(
      [
        [0, ''],
        [1000, 'first'],
        [2000, 'second'],
      ],
    );
    expect(result.lines.every((line: any) => line.status === 'upcoming')).toBe(
      true,
    );
  } finally {
    f.close();
  }
});

test('presentation noise and alternative title are accepted without stripping real versions', async () => {
  const f = await fixture();
  try {
    expect(
      await f.provider.search({
        ...song,
        title: 'Different localized title',
        alternativeTitle: 'Coldplay - Yellow (Official Music Video) [HD]',
        artist: 'Coldplay - Topic',
      }),
    ).toMatchObject({ title: 'Yellow', artists: ['Coldplay'] });
  } finally {
    f.close();
  }
});

test('featuring and feat collaboration separators preserve the same complete artist identity', async () => {
  const f = await fixture((call) =>
    call.endpoint === 'macro.subtitles.get'
      ? { value: macro({ artist_name: 'A feat. B' }) }
      : undefined,
  );
  try {
    expect(
      await f.provider.search({ ...song, artist: 'A featuring B' }),
    ).toMatchObject({
      title: 'Yellow',
      artists: ['A feat. B'],
    });
  } finally {
    f.close();
  }
});

test('Feather cannot match Her through an unbounded feat prefix', async () => {
  const f = await fixture((call) =>
    call.endpoint === 'macro.subtitles.get'
      ? { value: macro({ artist_name: 'Her' }) }
      : undefined,
  );
  try {
    expect(await f.provider.search({ ...song, artist: 'Feather' })).toBeNull();
  } finally {
    f.close();
  }
});

test('an authoritative exact title Official Audio is not erased as presentation noise', async () => {
  const f = await fixture((call) =>
    call.endpoint === 'macro.subtitles.get'
      ? { value: macro({ track_name: 'Official Audio' }) }
      : undefined,
  );
  try {
    expect(
      await f.provider.search({ ...song, title: 'Official Audio' }),
    ).toMatchObject({
      title: 'Official Audio',
      artists: ['Coldplay'],
    });
  } finally {
    f.close();
  }
});

test('zero track duration remains unknown for an otherwise matching identity', async () => {
  const f = await fixture((call) =>
    call.endpoint === 'macro.subtitles.get'
      ? { value: macro({ track_length: 0 }) }
      : undefined,
  );
  try {
    expect(await f.provider.search(song)).toMatchObject({
      title: 'Yellow',
      artists: ['Coldplay'],
    });
  } finally {
    f.close();
  }
});

test('zero track duration never bypasses a wrong identity', async () => {
  const f = await fixture((call) =>
    call.endpoint === 'macro.subtitles.get'
      ? {
          value: macro({
            track_name: 'NOKIA',
            artist_name: 'Drake',
            track_length: 0,
          }),
        }
      : undefined,
  );
  try {
    expect(await f.provider.search(song)).toBeNull();
  } finally {
    f.close();
  }
});

test('a primary Live recording cannot use an unversioned alternative to accept studio lyrics', async () => {
  const f = await fixture();
  try {
    expect(
      await f.provider.search({
        ...song,
        title: 'Yellow (Live)',
        alternativeTitle: 'Yellow',
      }),
    ).toBeNull();
  } finally {
    f.close();
  }
});

test('a decorative Official Video title and alias can still match the service title', async () => {
  const f = await fixture();
  try {
    expect(
      await f.provider.search({
        ...song,
        title: 'Yellow (Official Video)',
        alternativeTitle: 'Yellow',
      }),
    ).toMatchObject({
      title: 'Yellow',
      artists: ['Coldplay'],
    });
  } finally {
    f.close();
  }
});

for (const [artist, title, alternativeTitle] of [
  ['Live', 'Live - Different localized title', 'Lightning Crashes'],
  ['Oasis', 'Live Forever', 'Vivir por Siempre'],
  ['Anitta', 'Version of Me', 'Versão de Mim'],
])
  test(`bare artist/title words are not explicit recording versions: ${title}`, async () => {
    const f = await fixture((call) =>
      call.endpoint === 'macro.subtitles.get'
        ? {
            value: macro({ track_name: alternativeTitle, artist_name: artist }),
          }
        : undefined,
    );
    try {
      expect(
        await f.provider.search({ ...song, artist, title, alternativeTitle }),
      ).toMatchObject({
        title: alternativeTitle,
        artists: [artist],
      });
    } finally {
      f.close();
    }
  });

for (const title of ['Yellow [Live]', 'Coldplay - Yellow - Live'])
  test(`explicit bracket/dash version still cannot accept a studio alias: ${title}`, async () => {
    const f = await fixture();
    try {
      expect(
        await f.provider.search({ ...song, title, alternativeTitle: 'Yellow' }),
      ).toBeNull();
    } finally {
      f.close();
    }
  });

test('fullwidth Live parentheses cannot use a studio alias', async () => {
  const f = await fixture();
  try {
    expect(
      await f.provider.search({
        ...song,
        title: 'Yellow（Live）',
        alternativeTitle: 'Yellow',
      }),
    ).toBeNull();
  } finally {
    f.close();
  }
});

test('fullwidth matching artist prefix preserves a legitimate Live recording', async () => {
  const f = await fixture((call) =>
    call.endpoint === 'macro.subtitles.get'
      ? { value: macro({ track_name: 'Yellow (Live)' }) }
      : undefined,
  );
  try {
    expect(
      await f.provider.search({
        ...song,
        title: 'Ｃｏｌｄｐｌａｙ － Ｙｅｌｌｏｗ（Ｌｉｖｅ）',
        alternativeTitle: 'Yellow',
      }),
    ).toMatchObject({ title: 'Yellow (Live)', artists: ['Coldplay'] });
  } finally {
    f.close();
  }
});

for (const stored of [
  '{bad',
  '{"token":42}',
  'null',
  '{"token":"old-desktop","expires":9999999999999}',
])
  test(`corrupt or old-client token cache recovers ${stored}`, async () => {
    const f = await fixture(undefined, stored);
    try {
      expect(await f.provider.search(song)).toMatchObject({ title: 'Yellow' });
      expect(f.count('token.get')).toBe(1);
    } finally {
      f.close();
    }
  });

test('valid tagged token is reused while an expired tagged token refreshes', async () => {
  for (const [expires, requests] of [
    [Date.now() + 60000, 0],
    [0, 1],
  ]) {
    const f = await fixture(
      undefined,
      JSON.stringify({
        token: 'cached-mobile',
        expires,
        client: 'mac-ios-v2.0',
      }),
    );
    try {
      expect(await f.provider.search(song)).toMatchObject({ title: 'Yellow' });
      expect(f.count('token.get')).toBe(requests);
    } finally {
      f.close();
    }
  }
});

test('401 refreshes once and retries using the new token', async () => {
  const f = await fixture((call) =>
    call.endpoint === 'macro.subtitles.get' &&
    call.url.searchParams.get('usertoken') === 'fixture-token-1'
      ? { value: unauthorized }
      : undefined,
  );
  try {
    expect(await f.provider.search(song)).toMatchObject({ title: 'Yellow' });
    expect(f.count('token.get')).toBe(2);
    expect(f.count('macro.subtitles.get')).toBe(2);
  } finally {
    f.close();
  }
});

test('persistent authentication failure terminates after one refresh', async () => {
  const f = await fixture((call) =>
    call.endpoint === 'macro.subtitles.get'
      ? { value: unauthorized }
      : undefined,
  );
  try {
    await expect(f.provider.search(song)).rejects.toThrow(
      /authentication|rejected|refresh/i,
    );
    expect(f.count('token.get')).toBe(2);
    expect(f.count('macro.subtitles.get')).toBe(2);
  } finally {
    f.close();
  }
});

test('concurrent first searches initialize one client token', async () => {
  const f = await fixture();
  try {
    const results = await Promise.all([
      f.provider.search(song),
      f.provider.search(song),
    ]);
    expect(results.map((result) => result.title)).toEqual(['Yellow', 'Yellow']);
    expect(f.count('token.get')).toBe(1);
  } finally {
    f.close();
  }
});

test('a delayed old-token 401 cannot invalidate the already refreshed token', async () => {
  let oldCalls = 0;
  let releaseOld: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => (releaseOld = resolve));
  const f = await fixture(async (call) => {
    if (call.endpoint !== 'macro.subtitles.get') return;
    if (call.url.searchParams.get('usertoken') === 'fixture-token-1') {
      if (++oldCalls === 2) await delayed;
      return { value: unauthorized };
    }
    releaseOld!();
  });
  try {
    const results = await Promise.all([
      f.provider.search(song),
      f.provider.search(song),
    ]);
    expect(results.map((result) => result.title)).toEqual(['Yellow', 'Yellow']);
    expect(f.count('token.get')).toBe(2);
    expect(f.count('macro.subtitles.get')).toBe(4);
  } finally {
    releaseOld!();
    f.close();
  }
});

test('failed initialization can be retried without keeping a poisoned promise', async () => {
  let tokens = 0;
  const f = await fixture((call) =>
    call.endpoint === 'token.get' && ++tokens === 1
      ? { status: 503, value: {} }
      : undefined,
  );
  try {
    await expect(f.provider.search(song)).rejects.toThrow();
    expect(await f.provider.search(song)).toMatchObject({ title: 'Yellow' });
    expect(f.count('token.get')).toBe(2);
  } finally {
    f.close();
  }
});

test('malformed payload errors never log echoed tokens or raw responses', async () => {
  const f = await fixture((call) =>
    call.endpoint === 'macro.subtitles.get'
      ? {
          value: {
            message: {
              header: { status_code: 200 },
              body: { echoedToken: 'DO_NOT_LOG_FIXTURE_TOKEN' },
            },
          },
        }
      : undefined,
  );
  try {
    await expect(f.provider.search(song)).rejects.toThrow(/response|schema/i);
    expect(f.diagnostics).toEqual([]);
  } finally {
    f.close();
  }
});
