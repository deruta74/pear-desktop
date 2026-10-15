import { test, expect } from '@playwright/test';
import { request, Agent } from 'node:http';
import {
  musicRemoteHttpFixture,
  parseMusicRuntimeAdmission,
} from './helpers/api-music-remote-http';

for (const tls of [false, true])
  test(`owned loopback ${tls ? 'TLS' : 'HTTP'} explicit remote audience stays separate from local grants`, async () => {
    const f = await musicRemoteHttpFixture({ tls });
    try {
      const first = await f.http(
        '/api/v1/music/search',
        'POST',
        '{"query":"owned","limit":100}',
      );
      expect(first.status).toBe(200);
      expect(first.body.items).toHaveLength(100);
      const second = await f.http(
        '/api/v1/music/search',
        'POST',
        JSON.stringify({ cursor: first.body.nextCursor, limit: 100 }),
      );
      expect(second.status).toBe(200);
      expect(second.body.items).toHaveLength(51);
      expect(
        (
          await f.http(
            '/api/v1/music/search',
            'POST',
            JSON.stringify({ cursor: first.body.nextCursor, limit: 100 }),
          )
        ).body,
      ).toEqual(second.body);
      expect(
        (
          await f.http(
            '/api/v1/music/current',
            'GET',
            undefined,
            {},
            f.local.token,
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await f.http('/api/v1/music/current', 'GET', undefined, {
            host: `127.0.0.1:${f.port}`,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await f.http(
            '/api/v1/music/current',
            'GET',
            undefined,
            { host: `127.0.0.1:${f.port}` },
            f.local.token,
          )
        ).status,
      ).toBe(200);
      f.config.musicApiRemoteEnabled = false;
      f.publish();
      expect((await f.http('/api/v1/music/current')).status).toBe(403);
      expect(
        (
          await f.http(
            '/api/v1/music/current',
            'GET',
            undefined,
            { host: `127.0.0.1:${f.port}` },
            f.local.token,
          )
        ).status,
      ).toBe(200);
    } finally {
      await f.close();
    }
  });

test('actual socket namespace consumes OPTIONS errors and encoded aliases before legacy CORS', async () => {
  const f = await musicRemoteHttpFixture();
  try {
    for (const [target, method, body, status] of [
      ['/api/v1/music/current', 'OPTIONS', undefined, 405],
      ['/api/v1/music/missing', 'GET', undefined, 404],
      ['/api/v1/%6dusic/current', 'GET', undefined, 400],
      [
        '/api/v1/music/search',
        'POST',
        '{"resource":"http://forged.invalid/api/v1/music","query":"x"}',
        400,
      ],
    ] as const) {
      const r = await f.http(target, method, body);
      expect(r.status).toBe(status);
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
      expect(r.headers['access-control-allow-private-network']).toBeUndefined();
    }
    const legacy = await f.http('/api/v1/song');
    expect(legacy.status).toBe(200);
    expect(legacy.headers['access-control-allow-origin']).toBe('*');
    expect(
      (await f.http('/api/v1/song', 'OPTIONS')).headers[
        'access-control-allow-origin'
      ],
    ).toBe('*');
  } finally {
    await f.close();
  }
});

test('actual remote REST invokes accepted prepare control receipt methods and exact replay once', async () => {
  const f = await musicRemoteHttpFixture();
  try {
    const command = { action: 'pause' };
    const prepared = await f.http(
      '/api/v1/music/operations/prepare',
      'POST',
      JSON.stringify(command),
    );
    expect(prepared.status).toBe(200);
    const input = JSON.stringify({
      ...command,
      operationId: prepared.body.operationId,
    });
    const result = await f.http('/api/v1/music/control', 'POST', input);
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('accepted');
    expect((await f.http('/api/v1/music/control', 'POST', input)).body).toEqual(
      result.body,
    );
    expect(
      (await f.http('/api/v1/music/operations/' + prepared.body.operationId))
        .body,
    ).toEqual(result.body);
    expect(
      f.sent.filter(
        (p) =>
          p[0] === 'peard:music-read' && p[1].input.operation === 'control',
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('all fourteen socket branches call actual For methods with one selected immutable REST invocation and deadline', async () => {
  const f = await musicRemoteHttpFixture();
  const names = [
    'current',
    'search',
    'browse',
    'queue',
    'home',
    'library',
    'lyrics',
    'related',
    'comments',
    'prepare',
    'navigate',
    'control',
    'mutateQueue',
    'operation',
  ];
  const seen = new Set<string>();
  try {
    for (const name of names) {
      const original = f.service[name + 'For'].bind(f.service);
      f.service[name + 'For'] = (...args: any[]) => {
        const inv = args[0];
        expect(inv.transport).toBe('rest');
        expect(inv.resource).toBe(f.config.musicApiRemoteResource);
        expect(inv.session).toBeUndefined();
        expect(Object.isFrozen(inv)).toBe(true);
        expect(typeof args.at(-1)).toBe('number');
        seen.add(name);
        return original(...args);
      };
      f.service[name] = () => {
        throw Error('Route used old local wrapper ' + name);
      };
    }
    for (const target of [
      '/current',
      '/queue?limit=100',
      '/home?limit=100',
      '/library/playlists?limit=100',
      '/song/lyrics?videoId=abcdefghijk',
      '/song/related?videoId=abcdefghijk&limit=100',
      '/song/comments?videoId=abcdefghijk&limit=100',
    ])
      expect((await f.http('/api/v1/music' + target)).status, target).toBe(200);
    for (const [target, input] of [
      ['/search', { query: 'owned', limit: 100 }],
      [
        '/browse',
        { target: { kind: 'playlist', id: 'PL_N1PlaylistA' }, limit: 100 },
      ],
    ] as const)
      expect(
        (await f.http('/api/v1/music' + target, 'POST', JSON.stringify(input)))
          .status,
        target,
      ).toBe(200);
    for (const [target, action, fields] of [
      ['/control', 'pause', {}],
      ['/play/song', 'play_song', { videoId: 'abcdefghijk' }],
      ['/queue/song', 'enqueue_song', { videoId: 'abcdefghijk' }],
    ] as const) {
      const prepare = await f.http(
        '/api/v1/music/operations/prepare',
        'POST',
        JSON.stringify({ action, ...fields }),
      );
      expect(prepare.status).toBe(200);
      const result = await f.http(
        '/api/v1/music' + target,
        'POST',
        JSON.stringify({
          ...fields,
          ...(target === '/control' ? { action } : {}),
          operationId: prepare.body.operationId,
        }),
      );
      expect(result.status, target).toBe(200);
      expect(result.body.status).toBe('accepted');
      expect(
        (await f.http('/api/v1/music/operations/' + prepare.body.operationId))
          .body,
      ).toEqual(result.body);
    }
    expect([...seen].sort()).toEqual([...names].sort());
  } finally {
    await f.close();
  }
});

// Deliberately absent from ordinary discovery: missing root admission is NOT a skip/pass witness.
if (process.env.PEAR_MUSIC_RUNTIME_ADMISSION) {
  test('runtime-admitted nonloopback HTTP and TLS require actual direct peers', async () => {
    const { readFile } = await import('node:fs/promises');
    const { isIP } = await import('node:net');
    const { createHash } = await import('node:crypto');
    const input = parseMusicRuntimeAdmission(
      JSON.parse(
        await readFile(process.env.PEAR_MUSIC_RUNTIME_ADMISSION!, 'utf8'),
      ),
    );
    expect(['macOS', 'Windows', 'Linux']).toContain(input.environment);
    for (const ip of [input.bindAddress, input.clientAddress])
      expect(isIP(ip)).toBeGreaterThan(0);
    for (const tls of [false, true]) {
      const f = await musicRemoteHttpFixture({ tls, admission: input });
      try {
        expect(createHash('sha256').update(f.cert).digest('hex')).toBe(
          input.certSHA256,
        );
        expect(
          (
            await f.http(
              '/api/v1/music/search',
              'POST',
              '{"query":"owned","limit":100}',
            )
          ).status,
        ).toBe(200);
        for (const observed of f.observations) {
          expect(observed.owned).toBe(true);
          expect(observed.port).toBe(f.port);
          expect(observed.tls).toBe(tls);
          for (const ip of [observed.peer, observed.local]) {
            expect(isIP(ip)).toBeGreaterThan(0);
            expect(
              ip === '::1' ||
                ip.startsWith('127.') ||
                /^::ffff:(127\.|7f)/i.test(ip),
            ).toBe(false);
          }
        }
      } finally {
        await f.close();
      }
    }
  });
}

test('normal complete POST keepalive stays alive and one socket loss retains physical holds without canceling another client', async () => {
  const f = await musicRemoteHttpFixture();
  const agent = new Agent({ keepAlive: true });
  let req: any;
  try {
    f.setHold();
    const lost = new Promise<void>((resolve) => {
      req = request(
        {
          hostname: '127.0.0.1',
          port: f.port,
          path: '/api/v1/music/search',
          method: 'POST',
          agent,
          headers: {
            host: f.host,
            authorization: 'Bearer ' + f.grant.token,
            'content-type': 'application/json',
          },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.setTimeout(5000, () => req.destroy());
      req.on('error', () => resolve());
      req.end('{"query":"owned","limit":100}');
    });
    await expect.poll(() => f.held.length).toBe(1);
    const healthy = f.http(
      '/api/v1/music/search',
      'POST',
      '{"query":"owned","limit":100}',
    );
    await expect.poll(() => f.held.length).toBe(2);
    expect(f.sent.filter((p) => p[0] === 'peard:music-cancel')).toHaveLength(0);
    expect(f.broker.stats()).toEqual({ dispatched: 2, queued: 0 });
    req.destroy();
    await lost;
    await expect
      .poll(() => f.sent.filter((p) => p[0] === 'peard:music-cancel').length)
      .toBe(1);
    expect(f.broker.stats()).toEqual({ dispatched: 2, queued: 0 });
    f.settle();
    expect((await healthy).status).toBe(200);
    expect(f.service.stats().cursors).toBe(1);
    expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
  } finally {
    req?.destroy();
    agent.destroy();
    await f.close();
  }
});

test('listener loss fences held authorization and old cursors receipts remain retired after same-resource replacement', async () => {
  const f = await musicRemoteHttpFixture();
  try {
    const page = await f.http(
      '/api/v1/music/search',
      'POST',
      '{"query":"owned","limit":100}',
    );
    const prepared = await f.http(
      '/api/v1/music/operations/prepare',
      'POST',
      '{"action":"pause"}',
    );
    expect(prepared.status).toBe(200);
    const original = f.store.authorize.bind(f.store);
    let release: () => void = () => {};
    let entered = false;
    f.store.authorize = async (...args: any[]) => {
      entered = true;
      await new Promise<void>((r) => (release = r));
      return original(...args);
    };
    const waiting = f.http('/api/v1/music/current');
    await expect.poll(() => entered).toBe(true);
    const before = f.sent.filter((p) => p[0] === 'peard:music-read').length;
    f.retireListener();
    expect((await waiting).status).toBe(409);
    f.publish(false);
    release();
    f.store.authorize = original;
    expect(
      (
        await f.http(
          '/api/v1/music/search',
          'POST',
          JSON.stringify({ cursor: page.body.nextCursor, limit: 100 }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await f.http('/api/v1/music/operations/' + prepared.body.operationId))
        .status,
    ).toBe(409);
    expect(
      (
        await f.http(
          '/api/v1/music/control',
          'POST',
          JSON.stringify({
            action: 'pause',
            operationId: prepared.body.operationId,
          }),
        )
      ).status,
    ).toBe(409);
    expect(f.sent.filter((p) => p[0] === 'peard:music-read')).toHaveLength(
      before,
    );
    expect((await f.http('/api/v1/music/current')).status).toBe(200);
  } finally {
    await f.close();
  }
});

test('raw TLS boundaries reject duplicate authority fatal UTF8 and oversized streamed bodies without native work', async () => {
  const f = await musicRemoteHttpFixture({ tls: true });
  try {
    const base = `Host: ${f.host}\r\nAuthorization: Bearer ${f.grant.token}\r\n`;
    for (const extra of [
      `Host: ${f.host}\r\n`,
      `Authorization: Bearer ${f.grant.token}\r\n`,
      'Origin: \r\n',
      'Origin: null\r\nOrigin: null\r\n',
      'Forwarded: \r\n',
      'X-Forwarded-Proto: https\r\n',
      'Content-Type: application/json\r\nContent-Type: application/json\r\n',
    ]) {
      const response = await f.raw(
        `GET /api/v1/music/current HTTP/1.1\r\n${base}${extra}Connection: close\r\n\r\n`,
      );
      expect(response).toMatch(/^HTTP\/1\.1 (400|403)/);
      expect(response.toLowerCase()).not.toContain(
        'access-control-allow-origin',
      );
    }
    const invalid = Buffer.concat([
      Buffer.from(
        `POST /api/v1/music/search HTTP/1.1\r\n${base}Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n`,
      ),
      Buffer.from([0xc3, 0x28]),
    ]);
    expect(await f.raw(invalid)).toMatch(/^HTTP\/1\.1 400/);
    const body = 'x'.repeat(16385);
    expect(
      await f.raw(
        `POST /api/v1/music/search HTTP/1.1\r\n${base}Content-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`,
      ),
    ).toMatch(/^HTTP\/1\.1 413/);
    expect(f.sent.filter((p) => p[0] === 'peard:music-read')).toHaveLength(0);
    expect((await f.http('/api/v1/music/current')).status).toBe(200);
  } finally {
    await f.close();
  }
});

test('partial body abort and listener reentry or configuration ABA cannot dispatch old authority and healthy owner recovers', async () => {
  const f = await musicRemoteHttpFixture();
  let req: any;
  try {
    const body = '{"query":"owned","limit":100}';
    const original = f.store.authorize.bind(f.store);
    let entered = false;
    f.store.authorize = async (...args: any[]) => {
      const result = await original(...args);
      entered = true;
      return result;
    };
    const response = new Promise<number | undefined>((resolve, reject) => {
      req = request(
        {
          hostname: '127.0.0.1',
          port: f.port,
          path: '/api/v1/music/search',
          method: 'POST',
          agent: false,
          headers: {
            host: f.host,
            authorization: 'Bearer ' + f.grant.token,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.setTimeout(3000, () => req.destroy());
      req.on('error', reject);
      req.write(body.slice(0, 2));
    });
    await expect.poll(() => entered).toBe(true);
    f.retireListener();
    req.end(body.slice(2));
    expect(await response).toBe(409);
    f.publish(false);
    expect(f.sent.filter((p) => p[0] === 'peard:music-read')).toHaveLength(0);
    // Actual partial-body socket loss is separate from normal body completion.
    const aborted = request(
      {
        hostname: '127.0.0.1',
        port: f.port,
        path: '/api/v1/music/search',
        method: 'POST',
        agent: false,
        headers: {
          host: f.host,
          authorization: 'Bearer ' + f.grant.token,
          'content-type': 'application/json',
          'content-length': 100,
        },
      },
      (res) => res.resume(),
    );
    aborted.on('error', () => {});
    aborted.setTimeout(3000, () => aborted.destroy());
    aborted.write('{');
    await expect.poll(() => f.observations.length).toBe(2);
    aborted.destroy();
    let armed = true;
    f.store.authorize = async (...args: any[]) => {
      const result = await original(...args);
      const a = f.owner(),
        current = a.current;
      a.current = () => {
        if (armed) {
          armed = false;
          f.publish(false);
        }
        return current();
      };
      return result;
    };
    expect((await f.http('/api/v1/music/current')).status).toBe(409);
    f.store.authorize = original;
    let release: () => void = () => {};
    entered = false;
    f.store.authorize = async (...args: any[]) => {
      entered = true;
      await new Promise<void>((r) => (release = r));
      return original(...args);
    };
    const waiting = f.http('/api/v1/music/current');
    await expect.poll(() => entered).toBe(true);
    f.config.musicApiRemoteEnabled = false;
    f.publish();
    f.config.musicApiRemoteEnabled = true;
    f.publish();
    release();
    f.store.authorize = original;
    expect((await waiting).status).toBe(409);
    expect(f.sent.filter((p) => p[0] === 'peard:music-read')).toHaveLength(0);
    expect((await f.http('/api/v1/music/current')).status).toBe(200);
  } finally {
    req?.destroy();
    await f.close();
  }
});

test('explicit runtime admission parser rejects missing or malformed authority without running sockets', () => {
  for (const input of [
    undefined,
    null,
    {},
    'host',
    {
      environment: 'macOS',
      bindAddress: '127.0.0.1',
      clientAddress: '127.0.0.1',
      certSHA256: 'bad',
    },
  ])
    expect(() => parseMusicRuntimeAdmission(input)).toThrow();
});
