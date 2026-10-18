'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let api = {};
try {
  api = require('./api-music-nonloopback-carrier.cjs');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
}
const expectedChanges = [
  'M\t.github/workflows/tests.yml',
  'A\tscripts/api-music-nonloopback-admission.json',
  'A\tscripts/api-music-nonloopback-carrier.cjs',
  'A\tscripts/api-music-nonloopback-carrier.node.cjs',
];
const sha = 'a'.repeat(64),
  head = 'b'.repeat(40);
function policy() {
  return {
    schema: 1,
    sourceHead: '978c10380c10ae2e185f8186e483bc8df0d29711',
    sourceTree: '976f9436174b47a67006484374a7bac4bfd89f86',
    sourceParent: '6943f9955455cee62f14803ff96f48f9e8764028',
    nodeVersion: 'v24.20.0',
    pnpmVersion: '11.28.6',
    lockSHA256: sha,
    cliSHA256: sha,
    platforms: [
      {
        label: 'ubuntu-24.04',
        platform: 'linux',
        arch: 'x64',
        imageOS: 'ubuntu24',
        imageVersion: '20261017.1',
        nodeSHA256: sha,
        systemRoot: null,
        powerShellIdentity: null,
      },
      {
        label: 'macos-latest',
        platform: 'darwin',
        arch: 'arm64',
        imageOS: 'macos15',
        imageVersion: '20261017.1',
        nodeSHA256: sha,
        systemRoot: null,
        powerShellIdentity: null,
      },
      {
        label: 'windows-latest',
        platform: 'win32',
        arch: 'x64',
        imageOS: 'win25',
        imageVersion: '20261017.1',
        nodeSHA256: sha,
        systemRoot: 'C:\\Windows',
        powerShellIdentity: 'MICROSOFT_AUTHENTICODE_VALID',
      },
    ],
  };
}
const host = {
  platform: 'linux',
  arch: 'x64',
  imageOS: 'ubuntu24',
  imageVersion: '20261017.1',
  nodeVersion: 'v24.20.0',
  nodeSHA256: sha,
};
test('carrier has pure admission functions and stays inert on import', () => {
  assert.equal(typeof api.admit, 'function');
  const source = fs.readFileSync(
    require.resolve('./api-music-nonloopback-carrier.cjs'),
    'utf8',
  );
  vm.runInNewContext(source, {
    module: { exports: {} },
    require() {
      throw Error('runtime import');
    },
  });
});
test('complete exact three-OS admission binds actual image, architecture and Node bytes', () => {
  assert.equal(api.admit(policy(), 'qualify', host).platform, 'linux');
  for (const key of [
    'platform',
    'arch',
    'imageOS',
    'imageVersion',
    'nodeVersion',
    'nodeSHA256',
  ])
    assert.throws(
      () => api.admit(policy(), 'qualify', { ...host, [key]: 'PRIVATE' }),
      /ADMISSION_UNPROVEN/,
    );
});
test('missing pins prohibit qualification and pure policy inspection cannot admit executable fields', () => {
  const p = policy();
  p.platforms[0].imageVersion = null;
  p.platforms[0].nodeSHA256 = null;
  assert.equal(api.admit(p, 'inspect', host).platform, 'linux');
  assert.throws(() => api.admit(p, 'qualify', host), /ADMISSION_UNPROVEN/);
  p.command = 'PRIVATE';
  assert.throws(() => api.admit(p, 'inspect', host), /ADMISSION_UNPROVEN/);
  assert.throws(() => api.admit(policy(), 'other', host), /ADMISSION_UNPROVEN/);
});
test('Windows needs trusted SystemRoot/Microsoft identity and all OS rows remain mandatory', () => {
  const p = policy(),
    win = {
      ...host,
      platform: 'win32',
      arch: 'x64',
      imageOS: 'win25',
      systemRoot: 'C:\\Windows',
      powerShellIdentity: 'MICROSOFT_AUTHENTICODE_VALID',
    };
  assert.equal(api.admit(p, 'qualify', win).platform, 'win32');
  win.powerShellIdentity = 'UNTRUSTED';
  assert.throws(() => api.admit(p, 'qualify', win), /ADMISSION_UNPROVEN/);
  p.platforms.pop();
  assert.throws(() => api.admit(p, 'inspect', host), /ADMISSION_UNPROVEN/);
});
test('actual carrier binding rejects wrong source parent/tree/event/ref and any extra diff path', () => {
  const s = {
    event: 'workflow_dispatch',
    repository: 'deruta74/pear-desktop',
    ref: 'refs/heads/diagnostic/api-nonloopback-qualified-f3',
    githubSHA: head,
    workflowRef:
      'deruta74/pear-desktop/.github/workflows/tests.yml@refs/heads/diagnostic/api-nonloopback-qualified-f3',
    workflowSHA: head,
    expectedCarrierSHA: head,
    head,
    parents: policy().sourceHead,
    sourceTree: policy().sourceTree,
    sourceParent: policy().sourceParent,
    workflowSHA256: sha,
    expectedWorkflowSHA256: sha,
    helperSHA256: sha,
    expectedHelperSHA256: sha,
    policySHA256: sha,
    expectedPolicySHA256: sha,
    changes: expectedChanges,
    trackedDirty: false,
    unexpectedFiles: [],
  };
  api.bindSource(policy(), s);
  for (const key of [
    'event',
    'ref',
    'parents',
    'sourceTree',
    'sourceParent',
    'workflowSHA256',
    'policySHA256',
  ])
    assert.throws(
      () => api.bindSource(policy(), { ...s, [key]: 'PRIVATE' }),
      /SOURCE_UNPROVEN/,
    );
  assert.throws(
    () =>
      api.bindSource(policy(), {
        ...s,
        changes: [...expectedChanges, 'A\tsrc/index.ts'],
      }),
    /SOURCE_UNPROVEN/,
  );
});
test('qualification plan is data-only and restricted runner env discards credentials and TLS overrides', () => {
  const e = {
    GITHUB_REPOSITORY: 'deruta74/pear-desktop',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    ImageVersion: host.imageVersion,
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_TEMP: '/owned/temp',
    TOKEN: 'PRIVATE',
    NODE_OPTIONS: 'PRIVATE',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  };
  const p = api.makePlan(
    policy(),
    policy().platforms[0],
    e,
    { path: '/pinned/node', version: host.nodeVersion, sha256: sha },
    sha,
    '456',
  );
  assert.equal(p.jobId, '456');
  assert.equal(p.expectedHead, policy().sourceHead);
  assert.ok(!Object.hasOwn(p, 'command'));
  const env = api.runnerEnvironment(
    e,
    '/pinned',
    '/private',
    require('node:path').posix,
  );
  assert.ok(!JSON.stringify(env).includes('PRIVATE'));
  assert.equal(env.PATH, '/pinned');
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.throws(
    () =>
      api.makePlan(
        policy(),
        policy().platforms[0],
        e,
        { path: '/pinned/node', version: host.nodeVersion, sha256: sha },
        sha,
        'job-name',
      ),
    /ADMISSION_UNPROVEN/,
  );
});
test('workflow is manual-only, pinned, hook-disabled, bounded and exact-safe-file only', () => {
  let s = '';
  try {
    s = fs.readFileSync(
      require('node:path').join(__dirname, '../.github/workflows/tests.yml'),
      'utf8',
    );
  } catch {}
  assert.match(s, /workflow_dispatch:/);
  assert.doesNotMatch(
    s,
    /pull_request:|^  push:|pnpm build|playwright install|xvfb|src\/index|metadata-only/m,
  );
  assert.match(s, /timeout-minutes: 12/);
  assert.match(s, /--frozen-lockfile --ignore-scripts --ignore-pnpmfile/);
  assert.match(s, /retention-days: 1/);
  assert.doesNotMatch(s, /path:.*\*|node-version:.*24\.x/);
});
test('fixed PowerShell identity probe requires physical success and exact safe Microsoft signature verdict', () => {
  assert.equal(typeof api.verifyPowerShellIdentity, 'function');
  const calls = [];
  const io = {
    spawnSync: (...a) => {
      calls.push(a);
      return {
        status: 0,
        signal: null,
        stdout: Buffer.from(
          '{"version":1,"trusted":true,"fileVersion":"10.0.26100.1"}',
        ),
        stderr: Buffer.alloc(0),
      };
    },
    env: { PATH: 'C:\\pinned', SystemRoot: 'C:\\Windows', TOKEN: 'PRIVATE' },
    parent: 'C:\\runner\\temp',
  };
  assert.equal(
    api.verifyPowerShellIdentity(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      io,
    ),
    '10.0.26100.1',
  );
  assert.equal(calls[0][2].timeout, 5000);
  assert.equal(calls[0][2].shell, false);
  assert.ok(!JSON.stringify(calls[0][2].env).includes('PRIVATE'));
  for (const fault of [
    { status: 1 },
    { signal: 'SIGKILL' },
    { stderr: Buffer.from('PRIVATE') },
    {
      stdout: Buffer.from(
        '{"version":1,"trusted":true,"fileVersion":"PRIVATE path"}',
      ),
    },
  ]) {
    assert.throws(
      () =>
        api.verifyPowerShellIdentity(
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          {
            ...io,
            spawnSync: () => ({
              status: 0,
              signal: null,
              stdout: Buffer.from(
                '{"version":1,"trusted":true,"fileVersion":"10.0.26100.1"}',
              ),
              stderr: Buffer.alloc(0),
              ...fault,
            }),
          },
        ),
      /POWERSHELL_UNPROVEN/,
    );
  }
});

function acceptedResult() {
  const p = api.makePlan(
    policy(),
    policy().platforms[0],
    {
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      ImageVersion: host.imageVersion,
    },
    { path: '/pinned/node', version: host.nodeVersion, sha256: sha },
    sha,
    '456',
  );
  const telemetry = (protocol) => ({
    version: 1,
    endpoint: {
      label: 'owned-v4',
      family: 4,
      observations: 8,
      port: 12345,
      nonloopback: true,
      peerMatchesAdmission: true,
      localMatchesAdmission: true,
      owned: true,
      epochs: ['disabled', 'A', 'B', 'configured'].map((label) => ({
        label,
        observations: 2,
      })),
    },
    tls: {
      encrypted: protocol === 'TLS',
      versions: protocol === 'TLS' ? ['TLSv1.3'] : [],
      verifiedResponses: protocol === 'TLS' ? 7 : 0,
      peerLeafFingerprint256:
        protocol === 'TLS'
          ? 'fb6e906aa7015cfe4194ac90bd771a3b4f4d2eecef8ba4614b079a59138f35b1'
          : null,
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
      requests: 8,
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
  });
  const result = {
    schema: 1,
    status: 'PASS',
    reason: 'CHECKPOINTS_COMPLETE',
    protocols: ['HTTP', 'TLS'].map((protocol) => ({
      protocol,
      checkpoints: [
        'actual_nonempty_socket_facts',
        'search100plus51_replay',
        'distinct_grants_default_disabled',
        'namespace_headers',
        'accepted_receipt_exact_replay',
        'terminal_owner_cursor_receipt',
        'two_client_logical_cancel_physical_hold',
        'bounded_cleanup',
      ],
      outcome: 'PASS',
      telemetry: telemetry(protocol),
    })),
    platform: p.platform,
    arch: p.arch,
    image: p.image,
    expectedHead: p.expectedHead,
    expectedTree: p.expectedTree,
    sourceManifestSHA256: p.sourceManifestSHA256,
    nodeVersion: p.node.version,
    nodeSHA256: p.node.sha256,
    cliSHA256: p.cliSHA256,
    lockSHA256: p.lockSHA256,
    certSHA256:
      '597b4509e1ad0c12b69402bc0cff55bcb3f28603dea13a36623eb38891d109a3',
    runURL:
      'https://github.com/deruta74/pear-desktop/actions/runs/123/attempts/2',
    jobId: '456',
    endpointLabel: 'runner-owned-v4',
  };
  return { p, result };
}
test('artifact boundary accepts only exact pinned runner provenance and measured safe telemetry', () => {
  const { p, result } = acceptedResult();
  assert.deepEqual(api.safeRunner(result, p), result);
  for (const change of [
    (r) => {
      r.raw = 'PRIVATE';
    },
    (r) => {
      r.protocols[1].telemetry.endpoint.address = 'PRIVATE';
    },
    (r) => {
      r.protocols[0].telemetry.tls.verifiedResponses = 1;
    },
    (r) => {
      r.protocols[1].telemetry.tls.peerLeafFingerprint256 = 'a'.repeat(64);
    },
    (r) => {
      r.protocols[1].telemetry.endpoint.epochs[0].observations++;
    },
    (r) => {
      r.protocols[1].telemetry.counts.requests++;
    },
    (r) => {
      r.outerReapRequired = true;
    },
    (r) => {
      r.protocols[1].telemetry.cleanup.openRequestClients = 1;
    },
    (r) => {
      r.expectedHead = 'a'.repeat(40);
    },
    (r) => {
      r.jobId = '999';
    },
  ]) {
    const mutated = JSON.parse(JSON.stringify(result));
    change(mutated);
    assert.throws(() => api.safeRunner(mutated, p), /RUNNER_EVIDENCE_REJECTED/);
  }
});
test('actual executable rejects absent hosted admission before loading any runtime builtin', async () => {
  const source = fs.readFileSync(
      require.resolve('./api-music-nonloopback-carrier.cjs'),
      'utf8',
    ),
    module = { exports: {} },
    outputs = [];
  const requireFake = () => {
    throw Error('runtime builtin accessed');
  };
  requireFake.main = module;
  vm.runInNewContext(source, {
    module,
    require: requireFake,
    process: {
      argv: ['node', 'carrier', 'run'],
      env: {},
      stderr: { write: (v) => outputs.push(v) },
    },
  });
  for (let n = 0; n < 20; n++) await Promise.resolve();
  assert.deepEqual(outputs, ['CARRIER_UNPROVEN\n']);
});
test('complete source manifest retains the sole fixed non-executable SVG while runner grammar remains strict', () => {
  assert.equal(typeof api.runnerManifest, 'function');
  const full = {
    'src/providers/music-request.ts': sha,
    'assets/generated/icons/mac/icon.icon/Assets/SVG Image.svg': sha,
  };
  const runtime = api.runnerManifest(full);
  assert.deepEqual(Object.keys(runtime), ['src/providers/music-request.ts']);
  assert.equal(Object.keys(full).length, 2);
  assert.throws(
    () => api.runnerManifest({ ...full, 'src/other source.ts': sha }),
    /SOURCE_UNPROVEN/,
  );
});

async function carrierMainHarness(fault) {
  const path = require('node:path').posix,
    crypto = require('node:crypto');
  const digest = (v) => crypto.createHash('sha256').update(v).digest('hex');
  const cwd = '/source',
    privateRoot = '/runner/temp/pear-music-nonloopback-owned';
  const p = policy(),
    files = new Map(),
    operations = [],
    outputs = [],
    snapshots = {};
  const set = (file, v) =>
    files.set(file, Buffer.isBuffer(v) ? v : Buffer.from(v));
  const sourceFiles = [
    'scripts/qualify-api-music-nonloopback.cjs',
    'tests/api-music-remote-http.test.ts',
    'pnpm-lock.yaml',
    'assets/generated/icons/mac/icon.icon/Assets/SVG Image.svg',
    ...api.CARRIER_PATHS,
  ];
  for (const name of sourceFiles) set(cwd + '/' + name, 'FIXED:' + name);
  set('/pinned/node', 'FAKE_NODE');
  set(cwd + '/node_modules/@playwright/test/cli.js', 'FAKE_CLI');
  set(
    cwd + '/node_modules/@playwright/test/package.json',
    '{"version":"1.61.1"}',
  );
  p.platforms[0].nodeSHA256 = digest(files.get('/pinned/node'));
  p.lockSHA256 = digest(files.get(cwd + '/pnpm-lock.yaml'));
  p.cliSHA256 = digest(
    files.get(cwd + '/node_modules/@playwright/test/cli.js'),
  );
  set(cwd + '/scripts/api-music-nonloopback-admission.json', JSON.stringify(p));
  set(cwd + '/' + api.CARRIER_PATHS[0], 'FIXED_WORKFLOW');
  set(cwd + '/' + api.CARRIER_PATHS[2], 'FIXED_HELPER');
  const env = {
    CARRIER_MODE: 'qualify',
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: 'deruta74/pear-desktop',
    GITHUB_REF: 'refs/heads/diagnostic/api-nonloopback-qualified-f3',
    GITHUB_SHA: head,
    GITHUB_WORKFLOW_REF:
      'deruta74/pear-desktop/.github/workflows/tests.yml@refs/heads/diagnostic/api-nonloopback-qualified-f3',
    GITHUB_WORKFLOW_SHA: head,
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    ImageOS: host.imageOS,
    ImageVersion: host.imageVersion,
    RUNNER_TEMP: '/runner/temp',
    PEAR_MUSIC_CARRIER_PRIVATE_ROOT: privateRoot,
    QUALIFICATION_JOB_ID: '456',
    EXPECTED_CARRIER_SHA: head,
    EXPECTED_WORKFLOW_SHA256: digest(
      files.get(cwd + '/' + api.CARRIER_PATHS[0]),
    ),
    EXPECTED_HELPER_SHA256: digest(files.get(cwd + '/' + api.CARRIER_PATHS[2])),
    EXPECTED_POLICY_SHA256: digest(
      files.get(cwd + '/scripts/api-music-nonloopback-admission.json'),
    ),
    TOKEN: 'PRIVATE',
    NODE_OPTIONS: 'PRIVATE',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  };
  set(
    privateRoot + '/owner.json',
    JSON.stringify({ schema: 1, carrier: head, run: '123', attempt: '2' }),
  );
  const fsp = {
    open: async (file) => {
      operations.push(['read', file]);
      if (!files.has(file)) throw Error('PRIVATE missing');
      const bytes = files.get(file);
      return {
        stat: async () => ({ isFile: () => true, size: bytes.length }),
        readFile: async () => bytes,
        close: async () => {},
      };
    },
    realpath: async (file) => file,
    mkdir: async () => {},
    writeFile: async (file, bytes, options) => {
      if (fault === 'reap-write-failure' && file.endsWith('/reap-required'))
        throw Object.assign(Error('PRIVATE marker failure'), {
          code: 'EACCES',
        });
      if (options.flag === 'wx' && files.has(file)) throw Error('duplicate');
      set(file, bytes);
      operations.push(['write', file]);
    },
    rm: async (file) => {
      operations.push(['rm', file]);
      if (fault === 'cleanup-reject') throw Error('PRIVATE filesystem path');
      for (const key of files.keys())
        if (key === file || key.startsWith(file + '/')) files.delete(key);
    },
  };
  const fakeFs = {
    promises: fsp,
    openSync: (file) => {
      set(file, '');
      return file;
    },
    closeSync: () => {},
    existsSync: (file) => files.has(file),
  };
  const cp = {
    execFileSync: (_exe, args) => {
      operations.push(['git', ...args]);
      const command = args.join(' ');
      if (command === 'rev-parse HEAD') return head;
      if (command === 'rev-parse HEAD^{tree}') return 'c'.repeat(40);
      if (command === 'show -s --format=%P HEAD') return p.sourceHead;
      if (command === 'rev-parse ' + p.sourceHead + '^{tree}')
        return p.sourceTree;
      if (command === 'show -s --format=%P ' + p.sourceHead)
        return p.sourceParent;
      if (
        command ===
        'diff --name-status --no-renames ' + p.sourceHead + ' HEAD'
      )
        return expectedChanges.join('\n');
      if (command === 'status --porcelain --untracked-files=no') return '';
      if (command === 'ls-files --others --exclude-standard')
        return files.has(cwd + '/api-music-runtime-manifest.json')
          ? 'api-music-runtime-manifest.json'
          : '';
      if (command === 'ls-tree -r --name-only HEAD')
        return sourceFiles.join('\n');
      throw Error('unexpected git');
    },
    spawnSync: (exe, args, options) => {
      operations.push(['runner', exe, args, options]);
      assert.equal(exe, '/pinned/node');
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 215000);
      assert.ok(!JSON.stringify(options.env).includes('PRIVATE'));
      const plan = JSON.parse(files.get(args[2]).toString('utf8')),
        result = acceptedResult().result;
      Object.assign(result, {
        sourceManifestSHA256: plan.sourceManifestSHA256,
        nodeSHA256: plan.node.sha256,
        cliSHA256: plan.cliSHA256,
        lockSHA256: plan.lockSHA256,
      });
      snapshots.completeBytes = files.get(
        privateRoot + '/complete-carrier-manifest.json',
      );
      snapshots.runnerBytes = files.get(
        cwd + '/api-music-runtime-manifest.json',
      );
      snapshots.complete = JSON.parse(snapshots.completeBytes);
      snapshots.runner = JSON.parse(snapshots.runnerBytes);
      snapshots.expectedHashes = Object.fromEntries(
        sourceFiles.map((p) => [p, digest(files.get(cwd + '/' + p))]),
      );
      if (fault === 'extra-output') result.raw = 'PRIVATE';
      if (
        [
          'safe-pin-failure',
          'safe-topology-failure',
          'no-close',
          'timeout-error',
        ].includes(fault)
      ) {
        result.status = 'UNPROVEN';
        result.reason =
          fault === 'safe-topology-failure'
            ? 'TOPOLOGY_UNAVAILABLE'
            : 'PIN_MISMATCH';
        result.protocols = [];
      }
      set(
        options.stdio[1],
        fault === 'malformed-failure'
          ? 'PRIVATE malformed'
          : fault === 'oversized-failure'
            ? 'x'.repeat(65537)
            : JSON.stringify(result),
      );
      if (fault?.startsWith('overlay:')) {
        set(cwd + '/' + fault.slice(8), 'TAMPER');
        snapshots.tamperedPath = fault.slice(8);
      }
      if (fault === 'cli-tamper')
        set(cwd + '/node_modules/@playwright/test/cli.js', 'TAMPER');
      if (fault === 'source-tamper')
        set(cwd + '/tests/api-music-remote-http.test.ts', 'TAMPER');
      return {
        status: ['no-close', 'timeout-error'].includes(fault)
          ? null
          : [
                'exit1',
                'safe-pin-failure',
                'safe-topology-failure',
                'malformed-failure',
                'oversized-failure',
                'reap-write-failure',
              ].includes(fault)
            ? 1
            : 0,
        error:
          fault === 'timeout-error'
            ? Object.assign(Error('PRIVATE timed out'), { code: 'ETIMEDOUT' })
            : undefined,
        signal: fault === 'signal' ? 'SIGKILL' : null,
      };
    },
  };
  const module = { exports: {} },
    requireFake = (name) =>
      ({
        'node:fs': fakeFs,
        'node:path': path,
        'node:crypto': crypto,
        'node:child_process': cp,
        './qualify-api-music-nonloopback.cjs': require('./qualify-api-music-nonloopback.cjs'),
      })[name] ||
      (() => {
        throw Error('forbidden runtime import');
      })();
  requireFake.main = module;
  const processFake = {
    argv: ['/pinned/node', '/source/scripts/carrier', 'run'],
    env,
    platform: 'linux',
    arch: 'x64',
    version: 'v24.20.0',
    execPath: '/pinned/node',
    stderr: { write: (v) => outputs.push(v) },
  };
  vm.runInNewContext(
    fs.readFileSync(
      require.resolve('./api-music-nonloopback-carrier.cjs'),
      'utf8',
    ),
    {
      module,
      require: requireFake,
      __dirname: '/source/scripts',
      process: processFake,
      Buffer,
      setTimeout,
      clearTimeout,
    },
  );
  const resultFile = cwd + '/api-music-nonloopback-safe/result.json';
  for (let n = 0; n < 4000 && !files.has(resultFile) && !outputs.length; n++)
    await Promise.resolve();
  assert.deepEqual(outputs, []);
  assert.ok(files.has(resultFile), 'main emitted a result');
  assert.equal(
    operations.filter(([kind]) => kind === 'runner').length,
    1,
    'composed main reached the fixed child',
  );
  assert.ok(
    snapshots.complete && snapshots.runner,
    'child reached manifest capture',
  );
  return {
    result: JSON.parse(files.get(resultFile)),
    files,
    operations,
    privateRoot,
    exitCode: processFake.exitCode,
    snapshots,
    policy: p,
  };
}
test('composed actual main binds full source, runs fixed child, awaits owned removal and only then emits PASS', async () => {
  const h = await carrierMainHarness();
  assert.equal(h.result.status, 'PASS');
  assert.equal(h.result.processAbsence, 'UNPROVEN');
  assert.equal(h.result.outerReap, 'HOSTED_VM_AT_JOB_END');
  assert.equal(h.operations.filter(([k]) => k === 'runner').length, 1);
  const rm = h.operations.findIndex(([k]) => k === 'rm'),
    emit = h.operations.findIndex(
      ([k, path]) =>
        k === 'write' &&
        path.endsWith('/api-music-nonloopback-safe/result.json'),
    );
  assert.ok(rm >= 0);
  assert.ok(emit > rm);
  assert.ok(!h.files.has(h.privateRoot + '/owner.json'));
  assert.equal(h.result.completeCarrierManifestSHA256.length, 64);
  assert.equal(h.result.runnerCarrierManifestSHA256.length, 64);
  assert.notEqual(
    h.result.completeCarrierManifestSHA256,
    h.result.runnerCarrierManifestSHA256,
  );
  assert.ok(!JSON.stringify(h.result).includes('PRIVATE'));
  assert.equal(h.result.manifestScope, 'CARRIER_HEAD_TRACKED_FILES');
  assert.equal(h.result.provenance.sourceHead, h.policy.sourceHead);
  assert.equal(h.result.provenance.sourceTree, h.policy.sourceTree);
  assert.equal(h.result.provenance.carrierHead, head);
  assert.equal(h.result.provenance.carrierTree, 'c'.repeat(40));
  assert.notEqual(
    h.result.provenance.sourceHead,
    h.result.provenance.carrierHead,
  );
  for (const p of api.CARRIER_PATHS) {
    assert.equal(h.snapshots.complete[p], h.snapshots.expectedHashes[p]);
    assert.equal(h.snapshots.runner[p], h.snapshots.expectedHashes[p]);
  }
  const svg = 'assets/generated/icons/mac/icon.icon/Assets/SVG Image.svg';
  assert.ok(h.snapshots.complete[svg]);
  assert.equal(h.snapshots.runner[svg], undefined);
  assert.deepEqual(
    Object.keys(h.snapshots.runner).sort(),
    Object.keys(h.snapshots.complete)
      .filter((p) => p !== svg)
      .sort(),
  );
  const hash = (b) =>
    require('node:crypto').createHash('sha256').update(b).digest('hex');
  assert.equal(
    h.result.completeCarrierManifestSHA256,
    hash(h.snapshots.completeBytes),
  );
  assert.equal(
    h.result.runnerCarrierManifestSHA256,
    hash(h.snapshots.runnerBytes),
  );
  assert.equal(
    h.result.qualification.sourceManifestSHA256,
    hash(h.snapshots.runnerBytes),
  );
  assert.ok(
    h.operations.some((r) => r.join(' ') === 'git ls-tree -r --name-only HEAD'),
  );
  assert.ok(!Object.hasOwn(h.result, 'completeSourceManifestSHA256'));
});
test('composed failed child or post-child source mutation withholds PASS and deletion for VM reap', async () => {
  for (const fault of ['exit1', 'source-tamper']) {
    const h = await carrierMainHarness(fault);
    assert.equal(h.result.status, 'UNPROVEN');
    assert.equal(h.exitCode, 1);
    assert.ok(h.files.has(h.privateRoot + '/reap-required'));
    assert.equal(h.operations.filter(([k]) => k === 'rm').length, 0);
    assert.equal(h.result.qualification, undefined);
  }
});

function exactBinding() {
  return {
    event: 'workflow_dispatch',
    repository: 'deruta74/pear-desktop',
    ref: 'refs/heads/diagnostic/api-nonloopback-qualified-f3',
    githubSHA: head,
    workflowRef:
      'deruta74/pear-desktop/.github/workflows/tests.yml@refs/heads/diagnostic/api-nonloopback-qualified-f3',
    workflowSHA: head,
    expectedCarrierSHA: head,
    head,
    parents: policy().sourceHead,
    sourceTree: policy().sourceTree,
    sourceParent: policy().sourceParent,
    workflowSHA256: sha,
    expectedWorkflowSHA256: sha,
    helperSHA256: sha,
    expectedHelperSHA256: sha,
    policySHA256: sha,
    expectedPolicySHA256: sha,
    changes: expectedChanges,
    trackedDirty: false,
    unexpectedFiles: [],
  };
}
test('exact mixed M plus three A status admission rejects renamed, added-workflow, missing or extra overlay rows', () => {
  const valid = exactBinding();
  api.bindSource(policy(), valid);
  for (const changes of [
    expectedChanges.slice(1),
    [...expectedChanges, 'A\tsrc/unadmitted.ts'],
    expectedChanges.map((v, i) => (i === 0 ? v.replace(/^M/, 'A') : v)),
    expectedChanges.map((v, i) => (i === 1 ? v.replace(/^A/, 'M') : v)),
    expectedChanges.map((v, i) =>
      i === 0
        ? 'R100\t.github/workflows/tests.yml\t.github/workflows/other.yml'
        : v,
    ),
  ])
    assert.throws(
      () => api.bindSource(policy(), { ...valid, changes }),
      /SOURCE_UNPROVEN/,
    );
});
test('registered workflow context must point at this diagnostic ref and exact carrier SHA', () => {
  const valid = exactBinding();
  api.bindSource(policy(), valid);
  assert.throws(
    () =>
      api.bindSource(policy(), {
        ...valid,
        workflowRef:
          'deruta74/pear-desktop/.github/workflows/tests.yml@refs/heads/master',
      }),
    /SOURCE_UNPROVEN/,
  );
  assert.throws(
    () => api.bindSource(policy(), { ...valid, workflowSHA: 'f'.repeat(40) }),
    /SOURCE_UNPROVEN/,
  );
  const workflow = fs.readFileSync(
    require('node:path').join(__dirname, '../.github/workflows/tests.yml'),
    'utf8',
  );
  assert.match(workflow, /376634247/);
  assert.match(workflow, /diagnostic\/api-nonloopback-qualified-f3/);
  assert.equal(
    fs.existsSync(
      require('node:path').join(
        __dirname,
        '../.github/workflows/api-music-nonloopback-qualification.yml',
      ),
    ),
    false,
  );
});
test('each of the four C overlay files is rehashed after the child despite unchanged fake Git cleanliness', async () => {
  for (const overlay of api.CARRIER_PATHS) {
    const h = await carrierMainHarness('overlay:' + overlay);
    assert.equal(h.snapshots.tamperedPath, overlay);
    assert.equal(
      h.snapshots.complete[overlay],
      h.snapshots.expectedHashes[overlay],
    );
    assert.equal(h.result.status, 'UNPROVEN', overlay);
    assert.equal(h.result.manifestScope, 'CARRIER_HEAD_TRACKED_FILES');
    assert.equal(h.result.qualification, undefined);
    assert.equal(h.exitCode, 1);
    assert.ok(h.files.has(h.privateRoot + '/reap-required'));
    assert.equal(h.operations.filter(([k]) => k === 'rm').length, 0);
  }
});
test('C-scoped safe provenance and complete manifest include overlay bytes while plan preserves admitted S identity', async () => {
  const h = await carrierMainHarness(),
    crypto = require('node:crypto');
  const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
  for (const p of api.CARRIER_PATHS)
    assert.equal(h.snapshots.complete[p], h.snapshots.expectedHashes[p]);
  assert.equal(h.result.provenance.sourceHead, policy().sourceHead);
  assert.equal(h.result.provenance.sourceTree, policy().sourceTree);
  assert.equal(h.result.provenance.carrierHead, head);
  assert.equal(h.result.provenance.carrierTree, 'c'.repeat(40));
  assert.equal(h.result.provenance.registeredWorkflowId, '376634247');
  assert.equal(
    h.result.provenance.diagnosticRef,
    'diagnostic/api-nonloopback-qualified-f3',
  );
  assert.equal(h.result.manifestScope, 'CARRIER_HEAD_TRACKED_FILES');
  assert.equal(
    h.result.completeCarrierManifestSHA256,
    hash(h.snapshots.completeBytes),
  );
  assert.equal(
    h.result.runnerCarrierManifestSHA256,
    hash(h.snapshots.runnerBytes),
  );
  assert.equal(h.result.qualification.expectedHead, policy().sourceHead);
  assert.equal(h.result.qualification.expectedTree, policy().sourceTree);
  assert.equal(
    h.result.qualification.sourceManifestSHA256,
    h.result.runnerCarrierManifestSHA256,
  );
  assert.equal(Object.hasOwn(h.result, 'runnerSourceManifestSHA256'), false);
});
test('signal, extra output, CLI mutation and owned cleanup rejection cannot emit qualification PASS or private diagnostics', async () => {
  for (const fault of [
    'signal',
    'extra-output',
    'cli-tamper',
    'cleanup-reject',
  ]) {
    const h = await carrierMainHarness(fault);
    assert.equal(h.result.status, 'UNPROVEN', fault);
    assert.equal(h.exitCode, 1);
    assert.equal(h.result.qualification, undefined);
    assert.ok(!JSON.stringify(h.result).includes('PRIVATE'));
    if (fault === 'cleanup-reject') {
      assert.equal(h.result.reason, 'CARRIER_CLEANUP_UNPROVEN');
      assert.ok(h.files.has(h.privateRoot + '/owner.json'));
    } else {
      assert.ok(h.files.has(h.privateRoot + '/reap-required'));
      assert.equal(h.operations.filter(([k]) => k === 'rm').length, 0);
    }
  }
});

test('F3 failure ledger reads only own data fields, redacts arbitrary exceptions and preserves the primary error', () => {
  assert.equal(typeof api.failureLedger, 'function');
  const ledger = api.failureLedger('prepare');
  ledger.stage = 'WINDOWS_RESOLVER';
  let getters = 0;
  const privateError = {
    toJSON() {
      throw Error('must not serialize');
    },
    toString() {
      throw Error('must not coerce');
    },
  };
  Object.defineProperty(privateError, 'message', {
    get() {
      getters++;
      return 'PRIVATE';
    },
  });
  Object.defineProperty(privateError, 'code', {
    get() {
      getters++;
      return 'PRIVATE';
    },
  });
  const d = api.rememberFailure(ledger, privateError);
  assert.equal(getters, 0);
  assert.equal(d.reason, 'UNKNOWN');
  assert.equal(d.osCode, 'UNKNOWN');
  const first = api.failureLedger('run');
  first.stage = 'TOOL_PINS';
  api.rememberFailure(
    first,
    Object.assign(Error('DEPENDENCY_UNPROVEN'), { code: 'EACCES' }),
  );
  first.stage = 'EMISSION';
  api.rememberFailure(first, Error('PRIVATE path/password'));
  assert.equal(first.primary.stage, 'TOOL_PINS');
  assert.equal(first.primary.reason, 'DEPENDENCY_UNPROVEN');
  assert.equal(first.primary.osCode, 'EACCES');
  assert.ok(!JSON.stringify(first.primary).includes('PRIVATE'));
});
test('F3 separate failure parser retains only exact source-bound UNPROVEN reasons and rejects unsafe substitutes', () => {
  assert.equal(typeof api.safeInnerFailure, 'function');
  const { p, result } = acceptedResult();
  result.status = 'UNPROVEN';
  result.reason = 'PIN_MISMATCH';
  result.protocols = [];
  const safe = api.safeInnerFailure(Buffer.from(JSON.stringify(result)), p);
  assert.equal(safe.reason, 'PIN_MISMATCH');
  assert.equal(safe.phase, 'PINS');
  for (const change of [
    (r) => (r.reason = 'PRIVATE'),
    (r) => (r.extra = 'PRIVATE'),
    (r) => (r.nodeSHA256 = 'f'.repeat(64)),
    (r) => (r.status = 'PASS'),
    (r) => (r.protocols = [{}]),
    (r) => (r.cleanup = 'PRIVATE'),
  ]) {
    const r = JSON.parse(JSON.stringify(result));
    change(r);
    assert.throws(
      () => api.safeInnerFailure(Buffer.from(JSON.stringify(r)), p),
      /RUNNER_EVIDENCE_REJECTED/,
    );
  }
});
test('F3 nonzero normally closed child retains safe PIN and topology reasons without qualification or deletion', async () => {
  for (const [fault, reason] of [
    ['safe-pin-failure', 'PIN_MISMATCH'],
    ['safe-topology-failure', 'TOPOLOGY_UNAVAILABLE'],
  ]) {
    const h = await carrierMainHarness(fault);
    assert.equal(h.result.status, 'UNPROVEN');
    assert.equal(h.result.diagnostics.inner.reason, reason);
    assert.equal(h.result.diagnostics.child.normalClose, true);
    assert.equal(h.result.qualification, undefined);
    assert.equal(h.operations.filter(([k]) => k === 'rm').length, 0);
    assert.ok(!JSON.stringify(h.result).includes('PRIVATE'));
  }
});

async function prepareMainHarness(fault) {
  const path = require('node:path').win32,
    crypto = require('node:crypto'),
    { EventEmitter } = require('node:events');
  const digest = (b) => crypto.createHash('sha256').update(b).digest('hex'),
    cwd = 'C:\\source',
    node = 'C:\\pinned\\node.exe',
    temp = 'C:\\runner\\temp',
    owned = temp + '\\pear-music-nonloopback-owned';
  const p = policy(),
    files = new Map(),
    ops = [],
    stderr = [],
    dirs = new Set();
  const set = (f, b) => files.set(f, Buffer.isBuffer(b) ? b : Buffer.from(b));
  set(node, 'FAKE_NODE');
  p.platforms[2].nodeSHA256 =
    fault === 'node-pin' ? 'f'.repeat(64) : digest(files.get(node));
  set(path.join(cwd, api.CARRIER_PATHS[0]), 'FAKE_WORKFLOW');
  set(path.join(cwd, api.CARRIER_PATHS[2]), 'FAKE_HELPER');
  set(path.join(cwd, api.CARRIER_PATHS[1]), JSON.stringify(p));
  const e = {
    CARRIER_MODE: 'qualify',
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: 'deruta74/pear-desktop',
    GITHUB_REF: 'refs/heads/diagnostic/api-nonloopback-qualified-f3',
    GITHUB_SHA: head,
    GITHUB_WORKFLOW_REF:
      'deruta74/pear-desktop/.github/workflows/tests.yml@refs/heads/diagnostic/api-nonloopback-qualified-f3',
    GITHUB_WORKFLOW_SHA: head,
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    EXPECTED_CARRIER_SHA: head,
    EXPECTED_WORKFLOW_SHA256: digest(
      files.get(path.join(cwd, api.CARRIER_PATHS[0])),
    ),
    EXPECTED_HELPER_SHA256: digest(
      files.get(path.join(cwd, api.CARRIER_PATHS[2])),
    ),
    EXPECTED_POLICY_SHA256: digest(
      files.get(path.join(cwd, api.CARRIER_PATHS[1])),
    ),
    RUNNER_TEMP: temp,
    SystemRoot: 'C:\\Windows',
    ImageOS: 'win25',
    ImageVersion: '20261017.1',
    GITHUB_ENV: 'C:\\github-env',
  };
  if (fault === 'no-host') delete e.GITHUB_ACTIONS;
  if (fault === 'missing-admission') delete e.EXPECTED_POLICY_SHA256;
  const fsp = {
    open: async (f) => {
      ops.push(['read', f]);
      if (fault === 'node-read' && f === node)
        throw Object.assign(Error('PRIVATE Node path'), { code: 'ENOENT' });
      if (!files.has(f)) throw Error('PRIVATE missing');
      const b = files.get(f);
      return {
        stat: async () => ({ isFile: () => true, size: b.length }),
        readFile: async () => b,
        close: async () => {},
      };
    },
    mkdir: async (f) => {
      ops.push(['mkdir', f]);
      if (dirs.has(f))
        throw Object.assign(Error('PRIVATE directory'), { code: 'EEXIST' });
      dirs.add(f);
    },
    writeFile: async (f, b, o) => {
      ops.push(['write', f]);
      if (fault === 'owner-write' && f.endsWith('owner.json'))
        throw Object.assign(Error('PRIVATE owner path'), { code: 'EACCES' });
      if (o.flag === 'wx' && files.has(f))
        throw Object.assign(Error('PRIVATE duplicate'), { code: 'EEXIST' });
      set(f, b);
    },
    appendFile: async (f, b) => {
      ops.push(['env-publish']);
      if (fault === 'env-publish')
        throw Object.assign(Error('PRIVATE environment'), { code: 'ENOSPC' });
      set(f, b);
    },
  };
  let imports = 0;
  const cp = {
    execFileSync: (_exe, args) => {
      ops.push(['git', ...args]);
      const c = args.join(' ');
      if (c === 'rev-parse HEAD') return head;
      if (c === 'rev-parse HEAD^{tree}') return 'c'.repeat(40);
      if (c === 'show -s --format=%P HEAD') return p.sourceHead;
      if (c === 'rev-parse ' + p.sourceHead + '^{tree}') return p.sourceTree;
      if (c === 'show -s --format=%P ' + p.sourceHead) return p.sourceParent;
      if (c === 'diff --name-status --no-renames ' + p.sourceHead + ' HEAD')
        return expectedChanges.join('\n');
      if (
        c === 'status --porcelain --untracked-files=no' ||
        c === 'ls-files --others --exclude-standard'
      )
        return '';
      throw Error('unexpected fake git');
    },
    spawnSync: () => {
      ops.push(['probe']);
      if (fault === 'probe-throw')
        throw Object.assign(Error('PRIVATE callback path'), { code: 'ENOENT' });
      return {
        status: 0,
        signal: null,
        stdout: Buffer.from(
          '{"version":1,"trusted":true,"fileVersion":"10.0.26100.1"}',
        ),
        stderr: Buffer.alloc(0),
      };
    },
  };
  const modules = {
    'node:fs': { promises: fsp },
    'node:path': path,
    'node:crypto': crypto,
    'node:child_process': cp,
    './api-music-windows-private-root.cjs': {
      resolveWindowsPowerShell: async () => {
        ops.push(['resolve']);
        if (fault === 'resolve') throw Error('WINDOWS_PRIVATE_ROOT_UNPROVEN');
        return {
          systemRoot: 'C:\\Windows',
          powerShell:
            'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        };
      },
    },
    './qualify-api-music-nonloopback.cjs': {
      createPrivateTempDirectory: async () => {
        ops.push(['private-root']);
        if (fault === 'root-no-close')
          throw Object.assign(Error('WINDOWS_PRIVATE_ROOT_UNPROVEN'), {
            code: 'WINDOWS_HELPER_NO_CLOSE',
            cleanup: 'UNPROVEN',
            outerReapRequired: true,
          });
        if (fault === 'root-create')
          throw Error('WINDOWS_PRIVATE_ROOT_UNPROVEN');
        return owned;
      },
      removeOwnedTemp: async () => {},
      validatePlan: () => {},
    },
  };
  const module = { exports: {} },
    requireFake = (name) => {
      imports++;
      assert.ok(Object.hasOwn(modules, name));
      return modules[name];
    };
  requireFake.main = module;
  const processFake = Object.assign(new EventEmitter(), {
    argv: [
      node,
      path.join(cwd, 'scripts/api-music-nonloopback-carrier.cjs'),
      'prepare',
    ],
    env: e,
    platform: 'win32',
    arch: 'x64',
    version: 'v24.20.0',
    execPath: node,
    stdout: { write: () => {} },
    stderr: { write: (v) => stderr.push(v) },
  });
  vm.runInNewContext(
    fs.readFileSync(
      require.resolve('./api-music-nonloopback-carrier.cjs'),
      'utf8',
    ),
    {
      module,
      require: requireFake,
      process: processFake,
      __dirname: path.join(cwd, 'scripts'),
      Buffer,
      setTimeout,
      clearTimeout,
    },
  );
  const target = path.join(cwd, 'api-music-nonloopback-safe/result.json');
  for (let n = 0; n < 4000 && !files.has(target) && !stderr.length; n++)
    await Promise.resolve();
  return {
    result: files.has(target) ? JSON.parse(files.get(target)) : null,
    ops,
    stderr,
    imports,
    files,
    nodeSHA: digest(files.get(node)),
    target,
    exitCode: processFake.exitCode,
  };
}
test('F3 Windows prepare failures after source binding emit exact safe error artifact before private capture exists', async () => {
  for (const [fault, stage, reason] of [
    ['resolve', 'WINDOWS_RESOLVER', 'WINDOWS_PRIVATE_ROOT_UNPROVEN'],
    ['probe-throw', 'WINDOWS_PROBE', 'POWERSHELL_UNPROVEN'],
    ['root-create', 'PRIVATE_ROOT', 'WINDOWS_PRIVATE_ROOT_UNPROVEN'],
    ['owner-write', 'PRIVATE_FILES', 'UNKNOWN'],
    ['env-publish', 'ENV_PUBLISH', 'UNKNOWN'],
    ['node-pin', 'NODE_PIN', 'ADMISSION_UNPROVEN'],
  ]) {
    const h = await prepareMainHarness(fault);
    assert.ok(h.result, 'public failure artifact');
    assert.equal(h.result.status, 'UNPROVEN');
    assert.equal(h.result.diagnostics.command, 'prepare');
    assert.equal(h.result.diagnostics.stage, stage);
    assert.equal(h.result.diagnostics.reason, reason);
    assert.ok(Buffer.byteLength(JSON.stringify(h.result)) <= 8192);
    assert.ok(!JSON.stringify(h.result).includes('PRIVATE '));
    if (fault === 'resolve') {
      assert.equal(h.result.provenance.carrierTree, null);
      assert.equal(h.result.provenance.systemRootMatches, null);
      assert.equal(h.result.diagnostics.probe, null);
    }
    if (fault === 'probe-throw')
      assert.equal(h.result.diagnostics.probe.errorCode, 'ENOENT');
  }
});
test('F3 missing hosted admission or exact SHA input stays inert before any runtime import or I/O', async () => {
  for (const fault of ['no-host', 'missing-admission']) {
    const h = await prepareMainHarness(fault);
    assert.equal(h.imports, 0);
    assert.equal(h.ops.length, 0);
    assert.equal(h.result, null);
  }
});

test('F3 signal, timeout and absent normal close never parse inner failure or authorize deletion', async () => {
  for (const fault of ['signal', 'no-close', 'timeout-error']) {
    const h = await carrierMainHarness(fault);
    assert.equal(h.result.status, 'UNPROVEN');
    assert.equal(h.result.diagnostics.child.normalClose, false);
    assert.equal(h.result.diagnostics.inner, null);
    assert.equal(
      h.operations.filter(
        ([k, p]) => k === 'read' && p.endsWith('/runner.stdout'),
      ).length,
      0,
    );
    assert.equal(h.operations.filter(([k]) => k === 'rm').length, 0);
    if (fault === 'timeout-error') {
      assert.equal(h.result.diagnostics.child.errorCode, 'ETIMEDOUT');
      assert.equal(h.result.diagnostics.child.timedOut, true);
    }
  }
});
test('F3 malformed and oversized nonzero failure bodies remain UNKNOWN without private payload or cleanup authority', async () => {
  for (const fault of ['malformed-failure', 'oversized-failure']) {
    const h = await carrierMainHarness(fault);
    assert.equal(h.result.status, 'UNPROVEN');
    assert.equal(h.result.diagnostics.inner.reason, 'UNKNOWN');
    assert.equal(h.result.diagnostics.inner.validated, false);
    assert.equal(h.result.qualification, undefined);
    assert.ok(!JSON.stringify(h.result).includes('PRIVATE '));
    assert.equal(h.operations.filter(([k]) => k === 'rm').length, 0);
  }
});
test('F3 diagnostic child/probe/inner snapshots discard injected fields and getters', () => {
  const l = api.failureLedger('run');
  l.stage = 'CHILD';
  let getters = 0;
  l.child = {
    normalClose: true,
    code: 1,
    signal: null,
    raw: 'PRIVATE payload',
    stdoutBytes: Infinity,
  };
  Object.defineProperty(l.child, 'killed', {
    get() {
      getters++;
      return 'PRIVATE';
    },
  });
  l.probe = { returned: true, raw: 'PRIVATE payload', stdoutBytes: 999999999 };
  l.inner = {
    validated: true,
    reason: 'PRIVATE payload',
    phase: 'PINS',
    raw: 'PRIVATE',
  };
  Object.defineProperty(l.tool, 'cliVersion', {
    get() {
      getters++;
      return 'PRIVATE';
    },
  });
  const d = api.rememberFailure(l, Error('RUNNER_UNPROVEN'));
  assert.equal(getters, 0);
  assert.equal(d.child.stdoutBytes, null);
  assert.equal(d.probe.stdoutBytes, null);
  assert.equal(d.inner.validated, false);
  assert.equal(d.inner.phase, 'UNKNOWN');
  assert.ok(!JSON.stringify(d).includes('PRIVATE'));
});
test('F3 probe diagnostic facts are observed-only booleans and bounded counts, never raw versions or errors', () => {
  const good = () => ({
    status: 0,
    signal: null,
    stdout: Buffer.from(
      '{"version":1,"trusted":true,"fileVersion":"10.0.26100.1"}',
    ),
    stderr: Buffer.alloc(0),
  });
  for (const [fault, result] of [
    [
      'trust',
      {
        ...good(),
        stdout: Buffer.from(
          '{"version":1,"trusted":false,"fileVersion":"10.0.26100.1"}',
        ),
      },
    ],
    [
      'version',
      {
        ...good(),
        stdout: Buffer.from(
          '{"version":1,"trusted":true,"fileVersion":"PRIVATE_VERSION_SENTINEL"}',
        ),
      },
    ],
    ['parse', { ...good(), stdout: Buffer.from('PRIVATE malformed') }],
    ['stderr', { ...good(), stderr: Buffer.from('PRIVATE stderr') }],
    ['overflow', { ...good(), stdout: Buffer.alloc(257) }],
    ['signal', { ...good(), signal: 'SIGKILL', status: null }],
    [
      'timeout',
      {
        ...good(),
        status: null,
        error: Object.assign(Error('PRIVATE callback'), { code: 'ETIMEDOUT' }),
      },
    ],
  ]) {
    const d = {};
    assert.throws(
      () =>
        api.verifyPowerShellIdentity(
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          {
            spawnSync: () => result,
            env: { PATH: 'C:\\pinned', SystemRoot: 'C:\\Windows' },
            parent: 'C:\\runner\\temp',
          },
          d,
        ),
      /POWERSHELL_UNPROVEN/,
    );
    assert.ok(!JSON.stringify(d).includes('PRIVATE'));
    assert.ok(!JSON.stringify(d).includes('10.0.26100.1'));
    if (fault === 'trust') assert.equal(d.trusted, false);
    if (fault === 'version') assert.equal(d.versionShapeValid, false);
    if (fault === 'parse') assert.equal(d.jsonParsed, false);
    if (fault === 'timeout') assert.equal(d.errorCode, 'ETIMEDOUT');
  }
});
test('F3 probe recorder failure cannot replace success or primary error and error code getters are never invoked', () => {
  const sink = new Proxy(
    {},
    {
      defineProperty() {
        throw Error('PRIVATE recorder');
      },
    },
  );
  const io = {
    env: { PATH: 'C:\\pinned', SystemRoot: 'C:\\Windows' },
    parent: 'C:\\runner\\temp',
    spawnSync: () => ({
      status: 0,
      signal: null,
      stdout: Buffer.from(
        '{"version":1,"trusted":true,"fileVersion":"10.0.26100.1"}',
      ),
      stderr: Buffer.alloc(0),
    }),
  };
  assert.equal(
    api.verifyPowerShellIdentity(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      io,
      sink,
    ),
    '10.0.26100.1',
  );
  let getters = 0;
  const e = Error('PRIVATE callback');
  Object.defineProperty(e, 'code', {
    get() {
      getters++;
      return 'PRIVATE';
    },
  });
  assert.throws(
    () =>
      api.verifyPowerShellIdentity(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        {
          ...io,
          spawnSync: () => {
            throw e;
          },
        },
        sink,
      ),
    /POWERSHELL_UNPROVEN/,
  );
  assert.equal(getters, 0);
});
test('F3 early Windows error provenance never invents unread Node digest or raw PowerShell version', async () => {
  const node = await prepareMainHarness('node-read');
  assert.equal(node.result.provenance.nodeSHA256, null);
  assert.equal(node.result.diagnostics.stage, 'NODE_PIN');
  assert.equal(node.result.diagnostics.osCode, 'ENOENT');
  const owner = await prepareMainHarness('owner-write');
  assert.equal(owner.result.diagnostics.probe.versionShapeValid, true);
  assert.equal(
    Object.hasOwn(owner.result.provenance, 'powerShellFileVersion'),
    false,
  );
  assert.ok(!JSON.stringify(owner.result).includes('10.0.26100.1'));
  const noClose = await prepareMainHarness('root-no-close');
  assert.equal(noClose.result.diagnostics.reason, 'WINDOWS_HELPER_NO_CLOSE');
  assert.equal(noClose.result.outerReap, 'HOSTED_VM_AT_JOB_END');
});
test('F3 marker failure does not replace the primary child failure, and success shape has no diagnostic fields', async () => {
  const failure = await carrierMainHarness('reap-write-failure');
  assert.equal(failure.result.diagnostics.stage, 'CHILD');
  assert.equal(failure.result.diagnostics.reason, 'RUNNER_UNPROVEN');
  assert.equal(failure.result.diagnostics.osCode, 'UNKNOWN');
  const success = await carrierMainHarness();
  assert.equal(success.result.status, 'PASS');
  assert.equal(Object.hasOwn(success.result, 'diagnostics'), false);
  assert.deepEqual(
    Object.keys(success.result).sort(),
    [
      'schema',
      'status',
      'reason',
      'manifestScope',
      'provenance',
      'processAbsence',
      'outerReap',
      'qualification',
      'completeCarrierManifestSHA256',
      'runnerCarrierManifestSHA256',
      'dependencyPolicy',
    ].sort(),
  );
});
