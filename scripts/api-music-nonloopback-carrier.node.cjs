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
    ref: 'refs/heads/diagnostic/api-nonloopback-qualified-f2',
    githubSHA: head,
    workflowRef:
      'deruta74/pear-desktop/.github/workflows/tests.yml@refs/heads/diagnostic/api-nonloopback-qualified-f2',
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
    GITHUB_REF: 'refs/heads/diagnostic/api-nonloopback-qualified-f2',
    GITHUB_SHA: head,
    GITHUB_WORKFLOW_REF:
      'deruta74/pear-desktop/.github/workflows/tests.yml@refs/heads/diagnostic/api-nonloopback-qualified-f2',
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
      set(options.stdio[1], JSON.stringify(result));
      if (fault?.startsWith('overlay:')) {
        set(cwd + '/' + fault.slice(8), 'TAMPER');
        snapshots.tamperedPath = fault.slice(8);
      }
      if (fault === 'cli-tamper')
        set(cwd + '/node_modules/@playwright/test/cli.js', 'TAMPER');
      if (fault === 'source-tamper')
        set(cwd + '/tests/api-music-remote-http.test.ts', 'TAMPER');
      return {
        status: fault === 'exit1' ? 1 : 0,
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
    ref: 'refs/heads/diagnostic/api-nonloopback-qualified-f2',
    githubSHA: head,
    workflowRef:
      'deruta74/pear-desktop/.github/workflows/tests.yml@refs/heads/diagnostic/api-nonloopback-qualified-f2',
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
  assert.match(workflow, /diagnostic\/api-nonloopback-qualified-f2/);
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
    'diagnostic/api-nonloopback-qualified-f2',
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
