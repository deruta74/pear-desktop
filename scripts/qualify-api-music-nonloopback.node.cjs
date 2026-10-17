const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

let api = {};
try {
  api = require('./qualify-api-music-nonloopback.cjs');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const checkpoints = [
  'actual_nonempty_socket_facts',
  'search100plus51_replay',
  'distinct_grants_default_disabled',
  'namespace_headers',
  'accepted_receipt_exact_replay',
  'terminal_owner_cursor_receipt',
  'two_client_logical_cancel_physical_hold',
  'bounded_cleanup',
];
const leafFingerprint =
  'fb6e906aa7015cfe4194ac90bd771a3b4f4d2eecef8ba4614b079a59138f35b1';
function telemetry(protocol) {
  return {
    version: 1,
    endpoint: {
      label: 'owned-v4',
      family: 4,
      observations: 30,
      port: 32123,
      nonloopback: true,
      peerMatchesAdmission: true,
      localMatchesAdmission: true,
      owned: true,
      epochs: [
        { label: 'disabled', observations: 1 },
        { label: 'A', observations: 15 },
        { label: 'B', observations: 5 },
        { label: 'configured', observations: 9 },
      ],
    },
    tls: {
      encrypted: protocol === 'TLS',
      versions: protocol === 'TLS' ? ['TLSv1.3'] : [],
      verifiedResponses: protocol === 'TLS' ? 29 : 0,
      peerLeafFingerprint256: protocol === 'TLS' ? leafFingerprint : null,
    },
    pages: {
      firstItems: 100,
      secondItems: 51,
      nativeFetchesForPaging: 1,
      replayNativeDelta: 0,
    },
    ownership: {
      retiredA: true,
      distinctAB: true,
      oldCursorStatus: 404,
      oldReceiptStatus: 409,
    },
    counts: {
      requests: 30,
      nativeReadPackets: 7,
      controlsAfterAccepted: 1,
      controlsAfterReplay: 1,
      controlsFinal: 2,
      cancelPackets: 1,
      holdsBeforeLoss: 2,
      holdsAfterLoss: 2,
      holdsAfterSettlement: 0,
    },
    cleanup: {
      serverListening: false,
      brokerDispatched: 0,
      brokerQueued: 0,
      openRequestClients: 0,
      openServerSockets: 0,
      held: 0,
      ownedStoreRemoval: 'completed',
    },
  };
}
function report() {
  return {
    errors: [],
    stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    suites: [
      {
        specs: [
          {
            file: 'tests/api-music-remote-http.test.ts',
            title:
              'runtime-admitted nonloopback HTTP and TLS require actual direct peers',
            ok: true,
            tests: [
              {
                expectedStatus: 'passed',
                status: 'expected',
                results: [
                  {
                    status: 'passed',
                    retry: 0,
                    workerIndex: 0,
                    attachments: ['HTTP', 'TLS'].map((protocol) => ({
                      name: `runtime-${protocol}-checkpoints`,
                      contentType: 'application/json',
                      body: Buffer.from(
                        JSON.stringify({
                          protocol,
                          checkpoints,
                          outcome: 'PASS',
                          telemetry: telemetry(protocol),
                        }),
                      ).toString('base64'),
                    })),
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
const hash = 'a'.repeat(64);
const plan = () => ({
  schema: 1,
  disposableRunner: true,
  platform: 'linux',
  arch: 'x64',
  image: 'ubuntu24-20261017.1',
  repository: 'owner/project',
  runId: '123',
  attempt: '1',
  jobId: '456',
  expectedHead: 'b'.repeat(40),
  expectedTree: 'c'.repeat(40),
  sourceManifestSHA256: hash,
  node: { path: '/pinned/node', version: 'v24.20.0', sha256: hash },
  cliSHA256: hash,
  lockSHA256: hash,
});

test('import is inert even when every runtime builtin is forbidden', () => {
  const source = fs.readFileSync(
    require.resolve('./qualify-api-music-nonloopback.cjs'),
    'utf8',
  );
  const context = {
    module: { exports: {} },
    exports: {},
    require() {
      throw Error('Runtime import');
    },
  };
  vm.runInNewContext(source, context);
  assert.equal(typeof context.module.exports.runQualification, 'function');
});

test('selection is deterministic assigned self IPv4 and discards unsafe or internal rows', () => {
  const rows = {
    z: [{ family: 'IPv4', address: '10.0.0.8', internal: false }],
    a: [
      { family: 4, address: '10.0.0.2', internal: false },
      ...[
        '127.0.0.1',
        '0.0.0.0',
        '169.254.1.2',
        '224.0.0.1',
        '255.255.255.255',
        '010.0.0.1',
        '1.2.3.4:5',
        'host.invalid',
      ].map((address) => ({ family: 'IPv4', address, internal: false })),
      { family: 'IPv6', address: '::1', internal: false },
      { family: 'IPv4', address: '1.1.1.1', internal: true },
      { family: 'IPv4', address: '1.1.1.2' },
    ],
  };
  assert.equal(api.selectAssignedIPv4(rows), '10.0.0.2');
  assert.equal(
    api.selectAssignedIPv4({ a: rows.a.toReversed(), z: rows.z }),
    '10.0.0.2',
  );
  for (const invalid of [
    null,
    {},
    { a: null },
    { a: [{ address: '127.0.0.1', family: 'IPv4', internal: false }] },
  ])
    assert.throws(
      () => api.selectAssignedIPv4(invalid),
      /TOPOLOGY_UNAVAILABLE/,
    );
});

test('plans reject arbitrary commands, floating node, invalid pins and leaked provenance', () => {
  assert.doesNotThrow(() => api.validatePlan(plan()));
  for (const change of [
    { disposableRunner: false },
    { platform: 'other' },
    { arch: 'other' },
    { image: 'token=PRIVATE' },
    { repository: '../private' },
    { runId: 'https://private.invalid' },
    { expectedHead: 'main' },
    { sourceManifestSHA256: '' },
    { node: { path: 'node', version: '24.x', sha256: hash } },
    { cliSHA256: 'none' },
    { command: '/arbitrary/program' },
  ])
    assert.throws(
      () => api.validatePlan({ ...plan(), ...change }),
      /INVALID_PLAN/,
    );
});

test('report requires exactly one passing attempt and both exact protocol checkpoint records', () => {
  assert.deepEqual(api.parseEvidence(report()), [
    {
      protocol: 'HTTP',
      checkpoints,
      outcome: 'PASS',
      telemetry: telemetry('HTTP'),
    },
    {
      protocol: 'TLS',
      checkpoints,
      outcome: 'PASS',
      telemetry: telemetry('TLS'),
    },
  ]);
  const mutations = [
    (r) => r.errors.push({ message: 'PRIVATE' }),
    (r) => {
      r.stats.skipped = 1;
    },
    (r) => r.suites[0].specs.push(structuredClone(r.suites[0].specs[0])),
    (r) => {
      r.suites[0].specs[0].file = 'other.test.ts';
    },
    (r) => {
      r.suites[0].specs[0].tests[0].status = 'flaky';
    },
    (r) => {
      r.suites[0].specs[0].tests[0].results[0].status = 'skipped';
    },
    (r) => r.suites[0].specs[0].tests[0].results.push({ status: 'passed' }),
    (r) => {
      r.suites[0].specs[0].tests[0].results[0].retry = 1;
    },
    (r) => r.suites[0].specs[0].tests[0].results[0].attachments.pop(),
    (r) => {
      const a = r.suites[0].specs[0].tests[0].results[0].attachments;
      a[1] = structuredClone(a[0]);
    },
    (r) => {
      const a = r.suites[0].specs[0].tests[0].results[0].attachments[0];
      delete a.body;
      a.path = '/private/raw';
    },
    (r) => {
      const a = r.suites[0].specs[0].tests[0].results[0].attachments[0];
      a.body = Buffer.from(
        JSON.stringify({
          protocol: 'HTTP',
          checkpoints: checkpoints.slice(1),
          outcome: 'PASS',
        }),
      ).toString('base64');
    },
    (r) => {
      const a = r.suites[0].specs[0].tests[0].results[0].attachments[0];
      a.body = Buffer.from(
        JSON.stringify({
          protocol: 'HTTP',
          checkpoints: [checkpoints.join('|')],
          outcome: 'PASS',
        }),
      ).toString('base64');
    },
    (r) => {
      const a = r.suites[0].specs[0].tests[0].results[0].attachments[0];
      a.body = Buffer.from(
        JSON.stringify({
          protocol: 'HTTP',
          checkpoints,
          outcome: 'PASS',
          address: 'PRIVATE',
        }),
      ).toString('base64');
    },
  ];
  for (const mutate of mutations) {
    const r = report();
    mutate(r);
    assert.throws(() => api.parseEvidence(r), /INVALID_REPORT/);
  }
});

function fakeRun(overrides = {}) {
  const calls = [];
  const deps = {
    verifyPins: async () => {
      calls.push('pins');
    },
    readInterfaces: () => {
      calls.push('interfaces');
      return {
        owned: [{ family: 'IPv4', address: '10.0.0.2', internal: false }],
      };
    },
    createPrivateTemp: async () => {
      calls.push('temp');
      return '/private/run';
    },
    writeAdmission: async (directory, input) => {
      calls.push(['input', directory, input]);
    },
    execute: async (spec) => {
      calls.push(['execute', spec]);
      return {
        closed: true,
        code: 0,
        signal: null,
        reason: null,
        stdout: JSON.stringify(report()),
      };
    },
    removeTemp: async (directory) => {
      calls.push(['remove', directory]);
    },
    ...overrides,
  };
  return { calls, deps };
}

test('orchestration reads interfaces once after pins and runs only the fixed CLI with self admission', async () => {
  const { calls, deps } = fakeRun();
  const result = await api.runQualification(plan(), deps);
  assert.equal(result.status, 'PASS');
  assert.equal(calls.filter((c) => c === 'interfaces').length, 1);
  assert.deepEqual(calls.slice(0, 3), ['pins', 'interfaces', 'temp']);
  assert.deepEqual(calls.find((c) => c[0] === 'input')[2], {
    environment: 'Linux',
    bindAddress: '10.0.0.2',
    clientAddress: '10.0.0.2',
    certSHA256:
      '597b4509e1ad0c12b69402bc0cff55bcb3f28603dea13a36623eb38891d109a3',
  });
  const spec = calls.find((c) => c[0] === 'execute')[1];
  assert.equal(spec.command, '/pinned/node');
  assert.deepEqual(spec.args.slice(0, 11), [
    'node_modules/@playwright/test/cli.js',
    'test',
    'tests/api-music-remote-http.test.ts',
    '--grep',
    '(?:^| )runtime-admitted nonloopback HTTP and TLS require actual direct peers$',
    '--workers=1',
    '--retries=0',
    '--reporter=json',
    '--timeout=120000',
    '--global-timeout=120000',
    '--output=/private/run/playwright',
  ]);
  assert.deepEqual(calls.at(-1), ['remove', '/private/run']);
  assert.equal(result.protocols.length, 2);
  assert.ok(!JSON.stringify(result).includes('10.0.0.2'));
  assert.ok(!JSON.stringify(result).includes('/private'));
});

test('failures never leak raw exception, report, interface, path or child diagnostics', async () => {
  for (const failure of [
    'pins',
    'topology',
    'temp',
    'input',
    'execute',
    'report',
    'cleanup',
    'timeout',
    'no-close',
  ]) {
    const secret = '10.21.43.65 Bearer SECRET /private/profile';
    const fail = async () => {
      throw Error(secret);
    };
    const overrides = {
      pins: { verifyPins: fail },
      topology: { readInterfaces: () => ({}) },
      temp: { createPrivateTemp: fail },
      input: { writeAdmission: fail },
      execute: { execute: fail },
      report: {
        execute: async () => ({ closed: true, code: 0, stdout: secret }),
      },
      cleanup: { removeTemp: fail },
      timeout: {
        execute: async () => ({
          closed: true,
          code: null,
          reason: 'TIMEOUT',
          stdout: secret,
        }),
      },
      'no-close': {
        execute: async () => ({ closed: false, code: null, stdout: secret }),
      },
    }[failure];
    const { deps } = fakeRun(overrides);
    const result = await api.runQualification(plan(), deps);
    assert.equal(result.status, 'UNPROVEN', failure);
    assert.equal(result.protocols.length, 0, failure);
    assert.ok(!JSON.stringify(result).includes(secret), failure);
    assert.ok(!JSON.stringify(result).includes('SECRET'), failure);
  }
});

function childHarness() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
  };
  child.unref = () => {};
  const signalSource = new EventEmitter();
  const timers = new Map();
  let nextTimer = 0;
  const writes = [];
  const closed = [];
  let nextFd = 10;
  const io = {
    spawn: (...args) => {
      io.spawned = args;
      return child;
    },
    fs: {
      openSync: (...args) => {
        writes.push(args);
        return nextFd++;
      },
      writeSync: (...args) => writes.push(args),
      closeSync: (fd) => closed.push(fd),
    },
    setTimeout: (fn, ms) => {
      const id = ++nextTimer;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    signalSource,
  };
  const tick = () => {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    timer.fn();
  };
  return { child, signalSource, timers, writes, closed, io, tick };
}
const childSpec = {
  command: '/pinned/node',
  args: ['fixed'],
  cwd: '/source',
  directory: '/private/run',
  env: { CI: '1' },
};

test('owned child output is private, capped, shell-free and requires close', async () => {
  const h = childHarness();
  const pending = api.runOwnedChild(childSpec, h.io);
  h.child.stdout.emit('data', Buffer.from('PRIVATE'));
  h.child.emit('exit', 0, null);
  let settled = false;
  pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  h.child.emit('close', 0, null);
  const result = await pending;
  assert.equal(result.stdout, 'PRIVATE');
  assert.equal(result.closed, true);
  assert.equal(h.io.spawned[2].shell, false);
  assert.deepEqual(h.io.spawned[2].stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(h.writes[0][1], 'wx');
  assert.equal(h.writes[0][2], 0o600);
  assert.deepEqual(h.closed, [10, 11]);
  assert.equal(h.timers.size, 0);
  assert.equal(h.signalSource.listenerCount('SIGTERM'), 0);
});

test('timeout and output overflow terminate only owned child and stop at a bounded no-close result', async () => {
  for (const reason of ['TIMEOUT', 'OUTPUT_LIMIT', 'CANCELLED']) {
    const h = childHarness();
    const pending = api.runOwnedChild(childSpec, h.io);
    if (reason === 'TIMEOUT') h.tick();
    if (reason === 'OUTPUT_LIMIT')
      h.child.stderr.emit('data', Buffer.alloc(2 * 1024 * 1024 + 1));
    if (reason === 'CANCELLED') h.signalSource.emit('SIGTERM');
    assert.deepEqual(h.child.kills, ['SIGTERM']);
    h.tick();
    assert.deepEqual(h.child.kills, ['SIGTERM', 'SIGKILL']);
    h.tick();
    const result = await pending;
    assert.equal(result.closed, false);
    assert.equal(result.reason, reason);
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.closed, [10, 11]);
  }
});

test('spawn and private log failures are sanitized and release owned handles', async () => {
  const h = childHarness();
  h.io.spawn = () => {
    throw Error('Bearer SECRET');
  };
  const result = await api.runOwnedChild(childSpec, h.io);
  assert.equal(result.reason, 'SPAWN_FAILED');
  assert.equal(result.closed, true);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.deepEqual(h.closed, [10, 11]);
  const f = childHarness();
  f.io.fs.writeSync = () => {
    throw Error('PRIVATE');
  };
  const pending = api.runOwnedChild(childSpec, f.io);
  f.child.stdout.emit('data', Buffer.from('data'));
  f.child.emit('close', 0, null);
  assert.equal((await pending).reason, 'LOG_FAILED');
});

test('runtime pin verification checks actual bytes, executable identity and required manifest membership before any interface read', async () => {
  const crypto = require('node:crypto');
  const path = require('node:path').posix;
  const digest = (bytes) =>
    crypto.createHash('sha256').update(bytes).digest('hex');
  const p = plan();
  const files = new Map();
  const required = [
    'tests/api-music-remote-http.test.ts',
    'tests/helpers/api-music-remote-http.ts',
    'scripts/qualify-api-music-nonloopback.cjs',
    'scripts/api-music-windows-private-root.cjs',
    'pnpm-lock.yaml',
    'tests/fixtures/api-music-http-tls/cert.pem',
    'tests/fixtures/api-music-http-tls/key.pem',
  ];
  const cert = 'public certificate fixture';
  const manifest = Object.fromEntries(
    required.map((file) => {
      const bytes = Buffer.from(
        file.endsWith('cert.pem') ? cert : `source:${file}`,
      );
      files.set('/source/' + file, bytes);
      return [file, digest(bytes)];
    }),
  );
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  files.set('/source/api-music-runtime-manifest.json', manifestBytes);
  files.set('/pinned/node', Buffer.from('node executable'));
  files.set(
    '/source/node_modules/@playwright/test/cli.js',
    Buffer.from('pinned cli'),
  );
  files.set(
    '/source/node_modules/@playwright/test/package.json',
    Buffer.from('{"version":"1.61.1"}'),
  );
  p.sourceManifestSHA256 = digest(manifestBytes);
  p.node.sha256 = digest(files.get('/pinned/node'));
  p.cliSHA256 = digest(
    files.get('/source/node_modules/@playwright/test/cli.js'),
  );
  p.lockSHA256 = digest(files.get('/source/pnpm-lock.yaml'));
  // This deliberately fake cert hash must fail after every other pin matches.
  const reads = [];
  const io = {
    path,
    digest,
    cwd: '/source',
    platform: 'linux',
    arch: 'x64',
    version: 'v24.20.0',
    execPath: '/pinned/node',
    realpath: async (file) => file,
    readBounded: async (file) => {
      reads.push(file);
      if (!files.has(file)) throw Error('PRIVATE');
      return files.get(file);
    },
  };
  await assert.rejects(api.verifyRuntimePins(p, io), /PIN_MISMATCH/);
  assert.ok(reads.includes('/source/node_modules/@playwright/test/cli.js'));
  const originalDigest = io.digest;
  io.digest = (bytes) =>
    bytes.toString() === cert
      ? '597b4509e1ad0c12b69402bc0cff55bcb3f28603dea13a36623eb38891d109a3'
      : originalDigest(bytes);
  manifest['tests/fixtures/api-music-http-tls/cert.pem'] =
    '597b4509e1ad0c12b69402bc0cff55bcb3f28603dea13a36623eb38891d109a3';
  const revised = Buffer.from(JSON.stringify(manifest));
  files.set('/source/api-music-runtime-manifest.json', revised);
  p.sourceManifestSHA256 = digest(revised);
  await api.verifyRuntimePins(p, io);
  files.set(
    '/source/tests/api-music-remote-http.test.ts',
    Buffer.from('changed source'),
  );
  await assert.rejects(api.verifyRuntimePins(p, io), /PIN_MISMATCH/);
  files.set(
    '/source/tests/api-music-remote-http.test.ts',
    Buffer.from('source:tests/api-music-remote-http.test.ts'),
  );
  await assert.rejects(
    api.verifyRuntimePins(p, { ...io, version: 'v24.21.0' }),
    /PIN_MISMATCH/,
  );
  await assert.rejects(
    api.verifyRuntimePins(p, {
      ...io,
      realpath: async (file) =>
        file === '/source/tests/api-music-remote-http.test.ts'
          ? '/outside/file'
          : file,
    }),
    /PIN_MISMATCH/,
  );
  delete manifest['tests/helpers/api-music-remote-http.ts'];
  const missing = Buffer.from(JSON.stringify(manifest));
  files.set('/source/api-music-runtime-manifest.json', missing);
  p.sourceManifestSHA256 = digest(missing);
  await assert.rejects(api.verifyRuntimePins(p, io), /PIN_MISMATCH/);
});

function mainHarness(changes = {}) {
  const crypto = require('node:crypto');
  const path = require('node:path')[changes.windows ? 'win32' : 'posix'];
  const sourceRoot = changes.windows ? 'C:\\source' : '/source';
  const nodePath = changes.windows ? 'C:\\pinned\\node.exe' : '/pinned/node';
  const runnerTemp = changes.windows ? 'C:\\runner\\temp' : '/runner/temp';
  const privateRoot = path.join(runnerTemp, 'pear-music-nonloopback-owned');
  const planPath = changes.windows ? 'C:\\root-plan.json' : '/root-plan.json';
  const digest = (bytes) =>
    crypto.createHash('sha256').update(bytes).digest('hex');
  const p = plan();
  p.node.path = nodePath;
  if (changes.windows) p.platform = 'win32';
  const certSHA =
    '597b4509e1ad0c12b69402bc0cff55bcb3f28603dea13a36623eb38891d109a3';
  const files = new Map();
  const operations = [];
  const sources = [
    'tests/api-music-remote-http.test.ts',
    'tests/helpers/api-music-remote-http.ts',
    'scripts/qualify-api-music-nonloopback.cjs',
    'scripts/api-music-windows-private-root.cjs',
    'pnpm-lock.yaml',
    'tests/fixtures/api-music-http-tls/cert.pem',
    'tests/fixtures/api-music-http-tls/key.pem',
  ];
  const manifest = {};
  for (const file of sources) {
    const bytes = Buffer.from(
      file.endsWith('cert.pem') ? 'FAKE_PUBLIC_CERT' : file,
    );
    files.set(path.join(sourceRoot, file), bytes);
    manifest[file] = file.endsWith('cert.pem') ? certSHA : digest(bytes);
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  files.set(
    path.join(sourceRoot, 'api-music-runtime-manifest.json'),
    manifestBytes,
  );
  files.set(nodePath, Buffer.from('FAKE_NODE'));
  files.set(
    path.join(sourceRoot, 'node_modules/@playwright/test/cli.js'),
    Buffer.from('FAKE_CLI'),
  );
  files.set(
    path.join(sourceRoot, 'node_modules/@playwright/test/package.json'),
    Buffer.from('{"version":"1.61.1"}'),
  );
  p.node.sha256 = digest(files.get(nodePath));
  p.cliSHA256 = digest(
    files.get(path.join(sourceRoot, 'node_modules/@playwright/test/cli.js')),
  );
  p.lockSHA256 = digest(files.get(path.join(sourceRoot, 'pnpm-lock.yaml')));
  p.sourceManifestSHA256 = digest(manifestBytes);
  files.set(planPath, Buffer.from(JSON.stringify(p)));
  const stdout = [];
  const fakeProcess = Object.assign(new EventEmitter(), {
    argv: [
      nodePath,
      path.join(sourceRoot, 'scripts/qualify-api-music-nonloopback.cjs'),
      '--execute-admitted-runner',
      planPath,
    ],
    version: p.node.version,
    platform: p.platform,
    arch: p.arch,
    execPath: nodePath,
    env: {
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_TEMP: runnerTemp,
      GITHUB_REPOSITORY: p.repository,
      GITHUB_RUN_ID: p.runId,
      GITHUB_RUN_ATTEMPT: p.attempt,
      ImageVersion: p.image,
      SystemRoot: changes.windows ? 'C:\\Windows' : undefined,
      NODE_OPTIONS: 'PRIVATE',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      SECRET_TOKEN: 'PRIVATE',
    },
    stdout: { write: (data) => stdout.push(data) },
  });
  const h = childHarness();
  const fsp = {
    open: async (file) => {
      operations.push(['open', file]);
      const bytes = files.get(file);
      if (!bytes) throw Error('PRIVATE_MISSING');
      return {
        stat: async () => ({ isFile: () => true, size: bytes.length }),
        readFile: async () => bytes,
        close: async () => {},
      };
    },
    realpath: async (file) => file,
    lstat: async (file) => ({
      isSymbolicLink: () => false,
      isDirectory: () => !file.endsWith('.exe'),
      isFile: () => file.endsWith('.exe'),
    }),
    mkdtemp: async (prefix) => {
      operations.push(['mkdtemp', prefix]);
      return privateRoot;
    },
    chmod: async (...args) => {
      operations.push(['chmod', ...args]);
    },
    mkdir: async (...args) => {
      operations.push(['mkdir', ...args]);
    },
    writeFile: async (...args) => {
      operations.push(['writeFile', ...args]);
    },
    rm: async (...args) => {
      operations.push(['rm', ...args]);
    },
  };
  const fakeFs = { ...h.io.fs, promises: fsp };
  const modules = {
    './api-music-windows-private-root.cjs': windowsApi,
    'node:fs': fakeFs,
    'node:path': path,
    'node:crypto': {
      createHash: () => {
        let input;
        return {
          update: (bytes) => {
            input = bytes;
            return {
              digest: () =>
                input.toString() === 'FAKE_PUBLIC_CERT'
                  ? certSHA
                  : digest(input),
            };
          },
        };
      },
    },
    'node:os': {
      networkInterfaces: () => {
        operations.push(['interfaces']);
        return {
          assigned: [{ address: '10.0.0.2', internal: false, family: 'IPv4' }],
        };
      },
    },
    'node:child_process': {
      spawn: (...args) => {
        if (args[0].endsWith('powershell.exe')) {
          operations.push(['spawnACL', ...args]);
          const child = new EventEmitter();
          child.stdin = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => {};
          child.unref = () => {};
          child.stdin.destroy = () => {};
          child.stdout.destroy = () => {};
          child.stderr.destroy = () => {};
          child.stdin.end = (input) => {
            operations.push(['aclInput', input]);
            queueMicrotask(() => {
              child.stdout.emit(
                'data',
                Buffer.from('{"version":1,"private":true}'),
              );
              child.emit('close', 0, null);
            });
          };
          return child;
        }
        operations.push(['spawn', ...args]);
        queueMicrotask(() => {
          const cliArgs = args[1];
          const pattern = cliArgs[cliArgs.indexOf('--grep') + 1];
          const fullTitle =
            'tests/api-music-remote-http.test.ts runtime-admitted nonloopback HTTP and TLS require actual direct peers';
          const selected = new RegExp(pattern).test(fullTitle);
          h.child.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify(
                selected
                  ? report()
                  : {
                      errors: [{ message: 'No tests found' }],
                      suites: [],
                      stats: {
                        expected: 0,
                        unexpected: 0,
                        skipped: 0,
                        flaky: 0,
                      },
                    },
              ),
            ),
          );
          h.child.emit('close', selected ? 0 : 1, null);
        });
        return h.child;
      },
    },
  };
  changes.mutate?.({ fakeProcess, fsp, modules, files, operations, h });
  const module = { exports: {} };
  const fakeRequire = (name) => {
    if (name === './api-music-windows-private-root.cjs')
      operations.push(['import-windows']);
    if (!Object.hasOwn(modules, name)) throw Error('Forbidden module ' + name);
    return modules[name];
  };
  fakeRequire.main = module;
  const source = fs.readFileSync(
    require.resolve('./qualify-api-music-nonloopback.cjs'),
    'utf8',
  );
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: fakeRequire,
    process: fakeProcess,
    __dirname: path.join(sourceRoot, 'scripts'),
    Buffer,
    setTimeout: h.io.setTimeout,
    clearTimeout: h.io.clearTimeout,
  });
  return { operations, fakeProcess, stdout, h };
}

test('executable main uses only fake runner inventory, private fs, exact child and allowlisted environment', async () => {
  const { operations, fakeProcess, stdout, h } = mainHarness();
  for (let n = 0; n < 1000 && !stdout.length; n++) await Promise.resolve();
  assert.equal(stdout.length, 1);
  const evidence = JSON.parse(stdout[0]);
  assert.equal(evidence.status, 'PASS');
  assert.equal(fakeProcess.exitCode, 0);
  assert.equal(operations.filter(([name]) => name === 'interfaces').length, 1);
  assert.ok(
    operations.findIndex(([name]) => name === 'interfaces') >
      operations.findIndex(
        ([name, file]) => name === 'open' && file.endsWith('package.json'),
      ),
  );
  assert.deepEqual(operations.find(([name]) => name === 'chmod').slice(1), [
    '/runner/temp/pear-music-nonloopback-owned',
    0o700,
  ]);
  const admissionWrite = operations.find(([name]) => name === 'writeFile');
  assert.equal(admissionWrite[3].mode, 0o600);
  assert.equal(admissionWrite[3].flag, 'wx');
  const spawn = operations.find(([name]) => name === 'spawn');
  assert.equal(spawn[1], '/pinned/node');
  assert.ok(!JSON.stringify(spawn[3].env).includes('PRIVATE'));
  assert.equal(
    spawn[3].env.PEAR_MUSIC_RUNTIME_ADMISSION,
    '/runner/temp/pear-music-nonloopback-owned/admission.json',
  );
  assert.equal(operations.at(-1)[0], 'rm');
  assert.equal(h.timers.size, 0);
  assert.ok(!stdout[0].includes('10.0.0.2'));
  assert.ok(!stdout[0].includes('/runner'));
});

test('main refuses a non-disposable host or absent flag before reading any dependency or interface', async () => {
  for (const mutate of [
    ({ fakeProcess }) => {
      fakeProcess.env.RUNNER_ENVIRONMENT = 'self-hosted';
    },
    ({ fakeProcess }) => {
      fakeProcess.argv = fakeProcess.argv.slice(0, 2);
    },
  ]) {
    const { operations, fakeProcess, stdout } = mainHarness({ mutate });
    for (let n = 0; n < 1000 && !stdout.length; n++) await Promise.resolve();
    assert.equal(JSON.parse(stdout[0]).status, 'UNPROVEN');
    assert.equal(fakeProcess.exitCode, 1);
    assert.equal(operations.length, 0);
  }
});

test('private temp initialization failure removes the newly owned directory and never reads a second inventory', async () => {
  const { operations, stdout } = mainHarness({
    mutate: ({ fsp }) => {
      fsp.mkdir = async () => {
        throw Error('PRIVATE');
      };
    },
  });
  for (let n = 0; n < 1000 && !stdout.length; n++) await Promise.resolve();
  const evidence = JSON.parse(stdout[0]);
  assert.equal(evidence.status, 'UNPROVEN');
  assert.equal(evidence.reason, 'PRIVATE_TEMP_FAILED');
  assert.equal(operations.filter(([name]) => name === 'interfaces').length, 1);
  assert.equal(operations.filter(([name]) => name === 'spawn').length, 0);
  assert.equal(operations.at(-1)[0], 'rm');
});

test('cancellation before spawn and during cleanup prevents PASS while removing owned private data', async () => {
  for (const at of ['writeFile', 'rm']) {
    const { operations, fakeProcess, stdout } = mainHarness({
      mutate: ({ fsp, fakeProcess }) => {
        const original = fsp[at];
        fsp[at] = async (...args) => {
          const result = await original(...args);
          fakeProcess.emit('SIGTERM');
          return result;
        };
      },
    });
    for (let n = 0; n < 1000 && !stdout.length; n++) await Promise.resolve();
    const evidence = JSON.parse(stdout[0]);
    assert.equal(evidence.status, 'UNPROVEN', at);
    assert.equal(evidence.reason, 'CANCELLED', at);
    assert.equal(operations.at(-1)[0], 'rm');
    assert.equal(fakeProcess.exitCode, 1);
    assert.equal(
      operations.filter(([name]) => name === 'spawn').length,
      at === 'writeFile' ? 0 : 1,
    );
    assert.equal(fakeProcess.listenerCount('SIGTERM'), 0);
  }
});

test('Windows private-directory creation fails closed without reviewed ACL seam and only accepts an owned runner-temp child', async () => {
  const path = require('node:path').win32;
  const calls = [];
  const io = {
    platform: 'win32',
    path,
    runnerTemp: 'C:\\runner\\temp',
    fsp: {
      mkdir: async (...args) => calls.push(['mkdir', ...args]),
      rm: async (...args) => calls.push(['rm', ...args]),
    },
  };
  await assert.rejects(
    api.createPrivateTempDirectory(io),
    /WINDOWS_PRIVATE_TEMP_UNPROVEN/,
  );
  assert.equal(calls.length, 0);
  const directory = await api.createPrivateTempDirectory({
    ...io,
    makeWindowsPrivateDirectory: async () =>
      'C:\\runner\\temp\\pear-music-nonloopback-owned',
  });
  assert.equal(directory, 'C:\\runner\\temp\\pear-music-nonloopback-owned');
  assert.equal(calls[0][0], 'mkdir');
  for (const invalid of [
    'C:\\runner\\temp',
    'C:\\elsewhere\\pear-music-nonloopback-owned',
    'C:\\runner\\temp\\unowned',
  ])
    await assert.rejects(
      api.createPrivateTempDirectory({
        ...io,
        makeWindowsPrivateDirectory: async () => invalid,
      }),
      /PRIVATE_TEMP_FAILED/,
    );
});

test('cleanup watchdog returns failure at five seconds for a stuck owned removal and clears timers after success', async () => {
  const h = childHarness();
  const stuck = api.removeOwnedTemp('/owned/private', {
    remove: () => new Promise(() => {}),
    setTimeout: h.io.setTimeout,
    clearTimeout: h.io.clearTimeout,
  });
  assert.equal([...h.timers.values()][0].ms, 5000);
  h.tick();
  await assert.rejects(stuck, /CLEANUP_FAILED/);
  assert.equal(h.timers.size, 0);
  await api.removeOwnedTemp('/owned/private', {
    remove: async () => {},
    setTimeout: h.io.setTimeout,
    clearTimeout: h.io.clearTimeout,
  });
  assert.equal(h.timers.size, 0);
});

test('fixed grep selects the complete pinned Playwright title path and rejects other title suffixes', async () => {
  const { calls, deps } = fakeRun();
  await api.runQualification(plan(), deps);
  const args = calls.find((c) => c[0] === 'execute')[1].args;
  const matcher = new RegExp(args[args.indexOf('--grep') + 1]);
  const title =
    'runtime-admitted nonloopback HTTP and TLS require actual direct peers';
  for (const prefix of [
    'tests/api-music-remote-http.test.ts ',
    ' tests/api-music-remote-http.test.ts ',
    'project tests/api-music-remote-http.test.ts ',
    'project tests\\api-music-remote-http.test.ts ',
  ])
    assert.equal(matcher.test(prefix + title), true, prefix);
  for (const wrong of [
    'tests/api-music-remote-http.test.ts other runtime case',
    'tests/api-music-remote-http.test.ts prefixed-' + title,
    'tests/api-music-remote-http.test.ts ' + title + ' extra',
    'tests/api-music-remote-http.test.ts ' + title.replace('HTTP', 'http'),
  ])
    assert.equal(matcher.test(wrong), false, wrong);
  for (const mutate of [
    (r) => {
      r.suites[0].specs[0].title = 'prefix ' + title;
    },
    (r) => {
      r.suites[0].specs[0].file = 'tests/other-api-music-remote-http.test.ts';
    },
  ]) {
    const r = report();
    mutate(r);
    assert.throws(() => api.parseEvidence(r), /INVALID_REPORT/);
  }
});

test('initialization-failure cleanup composes the five-second watchdog and never attests stuck removal', async () => {
  const h = childHarness();
  const calls = [];
  const pending = api.createPrivateTempDirectory({
    path: require('node:path').posix,
    runnerTemp: '/runner/temp',
    platform: 'linux',
    fsp: {
      mkdtemp: async () => '/runner/temp/pear-music-nonloopback-owned',
      chmod: async () => {},
      mkdir: async () => {
        throw Error('PRIVATE');
      },
      rm: (directory) => {
        calls.push(directory);
        return new Promise(() => {});
      },
    },
    setTimeout: h.io.setTimeout,
    clearTimeout: h.io.clearTimeout,
  });
  let settled = false;
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let n = 0; n < 100; n++) await Promise.resolve();
  assert.deepEqual(calls, ['/runner/temp/pear-music-nonloopback-owned']);
  assert.equal(settled, false);
  assert.equal([...h.timers.values()].length, 1);
  assert.equal([...h.timers.values()][0].ms, 5000);
  h.tick();
  await assert.rejects(pending, /CLEANUP_FAILED/);
  assert.equal(h.timers.size, 0);
});

test('main initialization cleanup timeout emits sanitized UNPROVEN without spawning or claiming removal', async () => {
  const { operations, stdout, h, fakeProcess } = mainHarness({
    mutate: ({ fsp }) => {
      fsp.mkdir = async () => {
        throw Error('PRIVATE');
      };
      fsp.rm = async (directory) => {
        operations.push(['stuck-rm', directory]);
        return new Promise(() => {});
      };
    },
  });
  for (let n = 0; n < 1000 && !h.timers.size; n++) await Promise.resolve();
  assert.equal(stdout.length, 0);
  assert.equal([...h.timers.values()][0].ms, 5000);
  h.tick();
  for (let n = 0; n < 1000 && !stdout.length; n++) await Promise.resolve();
  const evidence = JSON.parse(stdout[0]);
  assert.equal(evidence.status, 'UNPROVEN');
  assert.equal(evidence.reason, 'CLEANUP_FAILED');
  assert.equal(evidence.protocols.length, 0);
  assert.equal(fakeProcess.exitCode, 1);
  assert.equal(operations.filter(([name]) => name === 'stuck-rm').length, 1);
  assert.equal(operations.filter(([name]) => name === 'spawn').length, 0);
  assert.equal(h.timers.size, 0);
  assert.ok(!stdout[0].includes('PRIVATE'));
  assert.ok(!stdout[0].includes('/runner/temp'));
});

test('telemetry parser rejects substituted topology, TLS, epoch, counter and cleanup facts without leaking supplied diagnostics', () => {
  const changes = [
    (t) => {
      t.endpoint.nonloopback = false;
    },
    (t) => {
      t.endpoint.peerMatchesAdmission = false;
    },
    (t) => {
      t.endpoint.localMatchesAdmission = false;
    },
    (t) => {
      t.endpoint.port = 0;
    },
    (t) => {
      t.endpoint.observations = 0;
    },
    (t) => {
      t.endpoint.family = 6;
    },
    (t) => {
      t.endpoint.epochs[1].label = 'enabled';
    },
    (t) => {
      t.endpoint.epochs[1].observations++;
    },
    (t) => {
      t.endpoint.epochs.push(t.endpoint.epochs[1]);
    },
    (t) => {
      t.endpoint.address = 'PRIVATE';
    },
    (t) => {
      t.tls.verifiedResponses = 0;
    },
    (t) => {
      t.tls.peerLeafFingerprint256 = 'a'.repeat(64);
    },
    (t) => {
      t.tls.versions = ['TLSv1'];
    },
    (t) => {
      t.tls.peerLeafFingerprint256 =
        '597b4509e1ad0c12b69402bc0cff55bcb3f28603dea13a36623eb38891d109a3';
    },
    (t) => {
      t.tls.encrypted = false;
    },
    (t) => {
      t.tls.verifiedResponses = 31;
    },
    (t) => {
      t.counts.controlsAfterReplay = 2;
    },
    (t) => {
      t.counts.nativeReadPackets = 1;
    },
    (t) => {
      t.counts.requests = 29;
    },
    (t) => {
      t.counts.holdsAfterLoss = 1;
    },
    (t) => {
      t.counts.cancelPackets = 0;
    },
    (t) => {
      t.pages.nativeFetchesForPaging = 2;
    },
    (t) => {
      t.pages.replayNativeDelta = 1;
    },
    (t) => {
      t.ownership.distinctAB = false;
    },
    (t) => {
      t.cleanup.openServerSockets = 1;
    },
    (t) => {
      t.cleanup.ownedStoreRemoval = 'timeout';
    },
  ];
  for (const change of changes) {
    const r = report();
    const a = r.suites[0].specs[0].tests[0].results[0].attachments[1];
    const body = JSON.parse(Buffer.from(a.body, 'base64'));
    change(body.telemetry);
    a.body = Buffer.from(JSON.stringify(body)).toString('base64');
    assert.throws(() => api.parseEvidence(r), /INVALID_REPORT/);
  }
  const r = report();
  const a = r.suites[0].specs[0].tests[0].results[0].attachments[0];
  const body = JSON.parse(Buffer.from(a.body, 'base64'));
  body.telemetry.tls.versions = ['TLSv1.3'];
  a.body = Buffer.from(JSON.stringify(body)).toString('base64');
  assert.throws(() => api.parseEvidence(r), /INVALID_REPORT/);
});

let windowsApi = {};
try {
  windowsApi = require('./api-music-windows-private-root.cjs');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

function windowsHarness(overrides = {}) {
  const path = require('node:path').win32;
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const calls = [],
    timers = new Map();
  let next = 0;
  child.stdin.end = (data) => {
    calls.push(['input', data]);
  };
  child.stdin.destroy = () => {
    calls.push(['stdin-destroy']);
  };
  child.stdout.destroy = () => {};
  child.stderr.destroy = () => {};
  child.unref = () => {};
  child.kill = (signal) => {
    calls.push(['kill', signal]);
  };
  const signalSource = new EventEmitter();
  const io = {
    path,
    systemRoot: 'C:\\Windows',
    signalSource,
    isCancelled: () => false,
    fsp: {
      realpath: async (value) => value,
      lstat: async (value) => ({
        isDirectory: () => !value.endsWith('.exe'),
        isFile: () => value.endsWith('.exe'),
        isSymbolicLink: () => false,
      }),
      mkdtemp: async (prefix) => {
        calls.push(['mkdtemp', prefix]);
        return 'C:\\runner\\temp\\pear-music-nonloopback-owned';
      },
      rm: async (directory) => {
        calls.push(['remove', directory]);
      },
    },
    spawn: (...args) => {
      calls.push(['spawn', ...args]);
      return child;
    },
    env: { CI: '1', PATH: 'C:\\pinned' },
    setTimeout: (fn, ms) => {
      const id = ++next;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    removeOwnedTemp: api.removeOwnedTemp,
    ...overrides,
  };
  const tick = () => {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    timer.fn();
  };
  const drain = async (name) => {
    for (let n = 0; n < 200 && !calls.some(([key]) => key === name); n++)
      await Promise.resolve();
  };
  return { io, child, calls, timers, tick, drain, signalSource };
}

test('Windows module import is inert and fixed adapter invokes only canonical absolute PowerShell with JSON path data', async () => {
  const source = fs.readFileSync(
    require.resolve('./api-music-windows-private-root.cjs'),
    'utf8',
  );
  vm.runInNewContext(source, {
    module: { exports: {} },
    require() {
      throw Error('runtime import');
    },
  });
  const h = windowsHarness();
  const pending = windowsApi.createWindowsPrivateDirectory(
    'C:\\runner\\temp',
    h.io,
  );
  await h.drain('input');
  const spawn = h.calls.find(([key]) => key === 'spawn');
  assert.equal(
    spawn[1],
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.deepEqual(spawn[2].slice(0, 4), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
  ]);
  assert.equal(spawn[3].shell, false);
  assert.equal(spawn[3].windowsHide, true);
  assert.deepEqual(spawn[3].stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(JSON.parse(h.calls.find(([key]) => key === 'input')[1]), {
    directory: 'C:\\runner\\temp\\pear-music-nonloopback-owned',
    parent: 'C:\\runner\\temp',
  });
  h.child.stdout.emit('data', Buffer.from('{"version":1,"private":true}'));
  h.child.emit('exit', 0);
  let resolved = false;
  pending.then(() => {
    resolved = true;
  });
  await Promise.resolve();
  assert.equal(resolved, false);
  h.child.emit('close', 0, null);
  assert.equal(await pending, 'C:\\runner\\temp\\pear-music-nonloopback-owned');
  assert.equal(h.calls.filter(([key]) => key === 'remove').length, 0);
  assert.equal(h.timers.size, 0);
});

test('Windows tool/root validation rejects path lookup, traversal, reparses and outside ownership before launching', async () => {
  for (const systemRoot of [
    undefined,
    'Windows',
    '\\\\host\\Windows',
    'C:\\Windows\\..\\evil',
    'C:\\Windows:evil',
    'C:\\Windows\\',
  ]) {
    const h = windowsHarness({ systemRoot });
    await assert.rejects(
      windowsApi.createWindowsPrivateDirectory('C:\\runner\\temp', h.io),
      /WINDOWS_PRIVATE_ROOT_UNPROVEN/,
    );
    assert.equal(h.calls.length, 0);
  }
  for (const fault of ['reparse', 'redirect', 'outside']) {
    const h = windowsHarness();
    if (fault === 'reparse')
      h.io.fsp.lstat = async () => ({
        isDirectory: () => true,
        isFile: () => true,
        isSymbolicLink: () => true,
      });
    if (fault === 'redirect') h.io.fsp.realpath = async () => 'C:\\elsewhere';
    if (fault === 'outside')
      h.io.fsp.mkdtemp = async () =>
        'C:\\elsewhere\\pear-music-nonloopback-owned';
    await assert.rejects(
      windowsApi.createWindowsPrivateDirectory('C:\\runner\\temp', h.io),
      /WINDOWS_PRIVATE_ROOT_UNPROVEN/,
    );
    assert.equal(
      h.calls.filter(([key]) => key === 'spawn' || key === 'remove').length,
      0,
    );
  }
  for (const badPath of ['node', 'C:\\pinned;C:\\untrusted', 'C:\\pinned;']) {
    const h = windowsHarness({ env: { PATH: badPath } });
    const rejected = assert.rejects(
      windowsApi.createWindowsPrivateDirectory('C:\\runner\\temp', h.io),
      /WINDOWS_PRIVATE_ROOT_UNPROVEN/,
    );
    await h.drain('input');
    // If the guard regresses, close the fake worker so this test reports a
    // failed rejection rather than leaving an uncompleted test promise.
    if (h.calls.some(([key]) => key === 'spawn')) {
      h.child.stdout.emit('data', Buffer.from('{"version":1,"private":true}'));
      h.child.emit('close', 0, null);
    }
    await rejected;
    assert.equal(h.calls.length, 0);
  }
});

test('Windows ACL rejection and output faults remove only a physically closed owned root through bounded cleanup', async () => {
  for (const fault of ['denied', 'extra', 'stderr', 'overflow', 'cancel']) {
    const h = windowsHarness();
    const pending = windowsApi.createWindowsPrivateDirectory(
      'C:\\runner\\temp',
      h.io,
    );
    await h.drain('input');
    if (fault === 'denied')
      h.child.stdout.emit('data', Buffer.from('{"version":1,"private":false}'));
    if (fault === 'extra')
      h.child.stdout.emit(
        'data',
        Buffer.from('{"version":1,"private":true,"sid":"PRIVATE"}'),
      );
    if (fault === 'stderr') h.child.stderr.emit('data', Buffer.from('PRIVATE'));
    if (fault === 'overflow') h.child.stdout.emit('data', Buffer.alloc(257));
    if (fault === 'cancel') h.signalSource.emit('SIGTERM');
    h.child.emit('close', fault === 'denied' ? 1 : 0, null);
    await assert.rejects(
      pending,
      (error) => error.message === 'WINDOWS_PRIVATE_ROOT_UNPROVEN',
    );
    assert.deepEqual(
      h.calls.filter(([key]) => key === 'remove'),
      [['remove', 'C:\\runner\\temp\\pear-music-nonloopback-owned']],
    );
    assert.equal(h.timers.size, 0);
  }
});

test('Windows helper timeout without physical close withholds deletion, reports outer reap and never supplies admission root', async () => {
  const h = windowsHarness();
  const pending = windowsApi.createWindowsPrivateDirectory(
    'C:\\runner\\temp',
    h.io,
  );
  await h.drain('input');
  assert.equal([...h.timers.values()][0].ms, 5000);
  h.tick();
  assert.deepEqual(
    h.calls.filter(([key]) => key === 'kill'),
    [['kill', 'SIGKILL']],
  );
  assert.equal([...h.timers.values()][0].ms, 2000);
  h.tick();
  await assert.rejects(
    pending,
    (error) =>
      error.code === 'WINDOWS_HELPER_NO_CLOSE' &&
      error.cleanup === 'UNPROVEN' &&
      error.outerReapRequired === true,
  );
  assert.equal(h.calls.filter(([key]) => key === 'remove').length, 0);
  assert.equal(h.timers.size, 0);
});

test('Windows ACL failure with physically closed worker retains ownership while a stuck removal uses the five-second watchdog', async () => {
  const h = windowsHarness();
  h.io.fsp.rm = () => new Promise(() => {});
  const pending = windowsApi.createWindowsPrivateDirectory(
    'C:\\runner\\temp',
    h.io,
  );
  await h.drain('input');
  h.child.emit('close', 1, null);
  for (let n = 0; n < 100 && !h.timers.size; n++) await Promise.resolve();
  assert.equal([...h.timers.values()][0].ms, 5000);
  h.tick();
  await assert.rejects(pending, /CLEANUP_FAILED/);
  assert.equal(h.timers.size, 0);
});

test('admitted Windows main lazily composes the fixed internal adapter before admission and retains Node-only child PATH', async () => {
  const { operations, stdout, fakeProcess } = mainHarness({ windows: true });
  for (let n = 0; n < 3000 && !stdout.length; n++) await Promise.resolve();
  assert.equal(JSON.parse(stdout[0]).status, 'PASS');
  assert.equal(fakeProcess.exitCode, 0);
  const imported = operations.findIndex(([name]) => name === 'import-windows');
  const write = operations.findIndex(([name]) => name === 'writeFile');
  const acl = operations.findIndex(([name]) => name === 'spawnACL');
  assert.ok(imported > operations.findIndex(([name]) => name === 'interfaces'));
  assert.ok(acl > imported && write > acl);
  const childOptions = operations.find(([name]) => name === 'spawn')[3];
  assert.equal(childOptions.env.SystemRoot, 'C:\\Windows');
  assert.equal(childOptions.env.PATH, 'C:\\pinned');
  assert.ok(!JSON.stringify(childOptions.env).includes('PRIVATE'));
});

test('outer evidence for an ACL helper lacking physical close requires reap and never writes admission or removes a live root', async () => {
  const h = mainHarness({
    windows: true,
    mutate: ({ modules, operations }) => {
      modules['./api-music-windows-private-root.cjs'] = {
        createWindowsPrivateDirectory: async () => {
          const error = Error('PRIVATE');
          error.code = 'WINDOWS_HELPER_NO_CLOSE';
          throw error;
        },
      };
    },
  });
  for (let n = 0; n < 3000 && !h.stdout.length; n++) await Promise.resolve();
  const evidence = JSON.parse(h.stdout[0]);
  assert.equal(evidence.reason, 'WINDOWS_HELPER_NO_CLOSE');
  assert.equal(evidence.cleanup, 'UNPROVEN');
  assert.equal(evidence.outerReapRequired, true);
  assert.equal(
    h.operations.filter(([name]) => ['writeFile', 'rm', 'spawn'].includes(name))
      .length,
    0,
  );
});

test('Windows ACL input bound rejects oversized path data before spawning and retires only its allocated root', async () => {
  const h = windowsHarness();
  const parent = 'C:\\runner\\' + '界'.repeat(3000);
  const owned = h.io.path.join(parent, 'pear-music-nonloopback-owned');
  h.io.fsp.mkdtemp = async () => owned;
  await assert.rejects(
    windowsApi.createWindowsPrivateDirectory(parent, h.io),
    /WINDOWS_PRIVATE_ROOT_UNPROVEN/,
  );
  assert.equal(h.calls.filter(([name]) => name === 'spawn').length, 0);
  assert.deepEqual(
    h.calls.filter(([name]) => name === 'remove'),
    [['remove', owned]],
  );
});

test('closed Windows ACL failure sanitizes an immediate owned-removal error as cleanup failure', async () => {
  const h = windowsHarness();
  h.io.fsp.rm = async () => {
    throw Error('PRIVATE filesystem path and SID');
  };
  const pending = windowsApi.createWindowsPrivateDirectory(
    'C:\\runner\\temp',
    h.io,
  );
  await h.drain('input');
  h.child.emit('close', 1, null);
  await assert.rejects(pending, (error) => error.message === 'CLEANUP_FAILED');
  assert.equal(h.timers.size, 0);
});
