'use strict';
// F4 controls run through inert source VM adapters; no native execution.
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
const F4_PHASES = ['ENTRY','INPUT_PARSED','PATH_FILE_CHECKED','SIGNATURE_BEGIN','SIGNATURE_RETURNED','VERSION_READY'];
const F4_WIRE = Buffer.from('PDP1:0\nPDP1:1\nPDP1:2\nPDP1:3\nPDP1:4\nPDP1:5\n','ascii');
function f4Child() {
  return {version:1,origin:'CHILD_FAILED',disposition:'RETURNED',child:{closed:true,code:1,signal:null,reason:null},reporter:'VALID',scan:'COMPLETE',target:{specs:1,tests:1,results:1,statusMask:2},errors:{root:0,target:1},first:{name:'Error',code:'ERR_MODULE_NOT_FOUND',file:'MODULE_HELPER',line:42,column:7}};
}
function f4Reply(extra={}) {
  return {status:0,signal:null,stdout:Buffer.from('{"version":1,"trusted":true,"fileVersion":"10.0.26100.1"}'),stderr:F4_WIRE,...extra};
}
function policy() {
  return {
    schema: 1,
    sourceHead: '9659187ca3b7663e78039def9d929bc1b586ef58',
    sourceTree: 'da245590c2708adb0c6d4caa00ef5d3a650330d2',
    sourceParent: '978c10380c10ae2e185f8186e483bc8df0d29711',
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
    ref: 'refs/heads/diagnostic/api-nonloopback-qualified-f4',
    githubSHA: head,
    workflowRef:
      'deruta74/pear-desktop/.github/workflows/tests.yml@refs/heads/diagnostic/api-nonloopback-qualified-f4',
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
        stderr: F4_WIRE,
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
              stderr: F4_WIRE,
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
    GITHUB_REF: 'refs/heads/diagnostic/api-nonloopback-qualified-f4',
    GITHUB_SHA: head,
    GITHUB_WORKFLOW_REF:
      'deruta74/pear-desktop/.github/workflows/tests.yml@refs/heads/diagnostic/api-nonloopback-qualified-f4',
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
          'child-summary-valid',
          'child-summary-invalid',
          'child-summary-cleanup',
          'producer-summary-valid',
          'producer-summary-invalid',
          'producer-summary-cleanup',
          'producer-summary-cancelled',
        ].includes(fault)
      ) {
        result.status = 'UNPROVEN';
        result.reason =
          fault === 'safe-topology-failure'
            ? 'TOPOLOGY_UNAVAILABLE'
            : 'PIN_MISMATCH';
        result.protocols = [];
        if (fault.startsWith('child-summary-')) {
          result.reason = fault === 'child-summary-cleanup' ? 'CLEANUP_FAILED' : 'CHILD_FAILED';
          result.childFailure = f4Child();
          if (fault === 'child-summary-invalid') result.childFailure.target.statusMask = 31;
        }
        if (fault.startsWith('producer-summary-')) {
          result.reason = fault === 'producer-summary-cleanup' ? 'CLEANUP_FAILED' : fault === 'producer-summary-cancelled' ? 'CANCELLED' : 'CHILD_FAILED';
          result.childFailure = f4S2Summary(f4S2Report([{status:'failed',error:{stack:'TypeError: PRIVATE producer detail'},errors:[]}]));
          if (fault === 'producer-summary-invalid') result.childFailure.target.statusMask=31;
        }
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
                'child-summary-valid',
                'child-summary-invalid',
                'child-summary-cleanup',
                'producer-summary-valid',
                'producer-summary-invalid',
                'producer-summary-cleanup',
                'producer-summary-cancelled',
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
    ref: 'refs/heads/diagnostic/api-nonloopback-qualified-f4',
    githubSHA: head,
    workflowRef:
      'deruta74/pear-desktop/.github/workflows/tests.yml@refs/heads/diagnostic/api-nonloopback-qualified-f4',
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
  assert.match(workflow, /diagnostic\/api-nonloopback-qualified-f4/);
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
    'diagnostic/api-nonloopback-qualified-f4',
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
    GITHUB_REF: 'refs/heads/diagnostic/api-nonloopback-qualified-f4',
    GITHUB_SHA: head,
    GITHUB_WORKFLOW_REF:
      'deruta74/pear-desktop/.github/workflows/tests.yml@refs/heads/diagnostic/api-nonloopback-qualified-f4',
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
        stderr: F4_WIRE,
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
    stderr: F4_WIRE,
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
      stderr: F4_WIRE,
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

test('F4 exact byte decoder classifies all 43 prefixes without partial-frame leakage', () => {
  assert.equal(typeof api.probePhaseStream,'function');
  for(let n=0;n<=42;n++) {
    const d=api.probePhaseStream(F4_WIRE.subarray(0,n));
    assert.equal(d.version,1);
    assert.equal(d.state,n===0?'ABSENT':n===42?'COMPLETE':n%7===0?'PREFIX':'TRUNCATED');
    assert.equal(d.completed,Math.floor(n/7));
    assert.equal(d.last,n<7?null:F4_PHASES[Math.floor(n/7)-1]);
    assert.deepEqual(Object.keys(d),['version','state','last','completed']);
  }
});
test('F4 marker mutations, unknown bytes and oversize discard all phase observations', () => {
  const invalid=[];
  for(let n=0;n<42;n++){const b=Buffer.from(F4_WIRE);b[n]^=0x80;invalid.push(b);}
  invalid.push(Buffer.from('PDP1:1\n'),Buffer.from('PDP1:0\nPDP1:0\n'),Buffer.from('PDP1:0\r\n'),Buffer.from('\ufeffPDP1:0\n'),Buffer.from('PRIVATE stderr'));
  for(const b of invalid){const d=api.probePhaseStream(b);assert.equal(d.state,'INVALID');assert.equal(d.completed,0);assert.equal(d.last,null);}
  assert.equal(api.probePhaseStream(Buffer.concat([F4_WIRE,Buffer.from('\n')])).state,'OVERSIZE');
  assert.equal(api.probePhaseStream(undefined).state,'UNAVAILABLE');
  assert.equal(api.probePhaseStream('PDP1:0\n').state,'UNAVAILABLE');
  assert.equal(api.probePhaseStream(F4_WIRE,Buffer.alloc(983)).state,'OVERSIZE');
});
test('F4 fixed identity accepts only complete42B stderr plus unchanged trusted normal-zero verdict', () => {
  const invoke=(raw,d={})=>api.verifyPowerShellIdentity('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',{env:{SystemRoot:'C:\\Windows',PATH:'C:\\pinned'},parent:'C:\\temp',spawnSync:()=>raw},d);
  const d={};assert.equal(invoke(f4Reply(),d),'10.0.26100.1');assert.equal(d.phaseStream.state,'COMPLETE');
  for(const stderr of [Buffer.alloc(0),F4_WIRE.subarray(0,7),F4_WIRE.subarray(0,41),Buffer.from('PRIVATE'),Buffer.concat([F4_WIRE,Buffer.from('\n')]),null])assert.throws(()=>invoke(f4Reply({stderr})),/POWERSHELL_UNPROVEN/);
  for(const extra of [{status:1},{signal:'SIGKILL'},{error:{code:'ETIMEDOUT'}},{stdout:Buffer.alloc(257)},{stdout:Buffer.from('{"version":1,"trusted":false,"fileVersion":"10.0.1.2"}')},{stdout:Buffer.from('{"version":1,"trusted":true,"fileVersion":"PRIVATE"}')},{stdout:Buffer.from('PRIVATE malformed')}])assert.throws(()=>invoke(f4Reply(extra)),/POWERSHELL_UNPROVEN/);
});
test('F4 timed-out probe records only completed phase observations and never parses verdict', () => {
  for(let n=0;n<=42;n++){
    const d={};assert.throws(()=>api.verifyPowerShellIdentity('C:\\fixed.exe',{env:{SystemRoot:'C:\\Windows',PATH:'C:\\pinned'},parent:'C:\\temp',spawnSync:()=>f4Reply({status:null,signal:'SIGKILL',error:{code:'ETIMEDOUT'},stderr:F4_WIRE.subarray(0,n)})},d),/POWERSHELL_UNPROVEN/);
    assert.equal(d.timedOut,true);assert.equal(d.normalClose,false);assert.equal(d.jsonParsed,null);assert.equal(d.killed,null);assert.equal(d.phaseStream.completed,Math.floor(n/7));assert.ok(!JSON.stringify(d).includes('10.0.26100.1'));
  }
});
test('F4 invocation emits six fixed flushed frames at approved statement boundaries and keeps bounds', () => {
  let call;api.verifyPowerShellIdentity('C:\\fixed.exe',{env:{SystemRoot:'C:\\Windows',PATH:'C:\\pinned'},parent:'C:\\temp',spawnSync:(...args)=>(call=args,f4Reply())});
  const [tool,args,o]=call;assert.equal(tool,'C:\\fixed.exe');assert.deepEqual(args.slice(0,4),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand']);
  const p=Buffer.from(args[4],'base64').toString('utf16le');
  const offsets=[];for(let i=0;i<6;i++){const literal="[Console]::Error.Write([string]::Concat('PDP1:"+i+"',[char]10));[Console]::Error.Flush()";assert.equal(p.split(literal).length,2);offsets.push(p.indexOf(literal));}
  assert.equal((p.match(/::Error\.Flush\(\)/g)||[]).length,6);
  assert.ok(offsets[0]<p.indexOf('$ErrorActionPreference'));
  assert.ok(p.indexOf('$request=[Console]::In.ReadLine()|ConvertFrom-Json')<offsets[1]&&offsets[1]<p.indexOf('$tool=[IO.Path]'));
  assert.ok(p.indexOf('$item.PSIsContainer')<offsets[2]&&offsets[2]<offsets[3]&&offsets[3]<p.indexOf('$signature=Get-AuthenticodeSignature'));
  assert.ok(p.indexOf('$signature=Get-AuthenticodeSignature')<offsets[4]&&offsets[4]<p.indexOf("$signature.Status -ne 'Valid'"));
  assert.ok(p.indexOf('$version=@(')<offsets[5]&&offsets[5]<p.indexOf('[Console]::Write'));
  assert.deepEqual(JSON.parse(JSON.stringify(o)),{shell:false,windowsHide:true,encoding:null,input:'{"tool":"C:\\\\fixed.exe"}\n',timeout:5000,killSignal:'SIGKILL',maxBuffer:1024,env:{CI:'1',SystemRoot:'C:\\Windows',PATH:'C:\\pinned',TEMP:'C:\\temp',TMP:'C:\\temp'}});
});
test('F4 strict ChildFailureV1 accepts canonical fixture and enforces all2080 mask-count combinations', () => {
  assert.equal(typeof api.safeChildFailure,'function');
  assert.deepEqual(api.safeChildFailure(f4Child(),'CHILD_FAILED'),f4Child());
  let count=0;for(let results=0;results<=64;results++)for(let mask=0;mask<32;mask++){
    const x=f4Child();x.target.results=results;x.target.statusMask=mask;x.errors.target=0;x.first=null;
    const bits=[1,2,4,8,16].filter(bit=>(mask&bit)!==0).length;
    const allowed=(results===0?mask===0:mask!==0)&&bits<=results;
    if(allowed)assert.doesNotThrow(()=>api.safeChildFailure(x,'CHILD_FAILED'));
    else assert.throws(()=>api.safeChildFailure(x,'CHILD_FAILED'),/RUNNER_EVIDENCE_REJECTED/);
    count++;
  }assert.equal(count,2080);
});
test('F4 child summary rejects private fields, invalid enums, bounds and inconsistent aggregate facts', () => {
  const changes=[x=>x.raw='PRIVATE',x=>x.version=2,x=>x.origin='PRIVATE',x=>x.disposition='PRIVATE',x=>x.child.closed='true',x=>x.child.code=4294967296,x=>x.child.code=-2147483649,x=>x.child.signal='PRIVATE',x=>x.child.reason='PRIVATE',x=>x.reporter='PRIVATE',x=>x.scan='PRIVATE',x=>x.target.results=65,x=>x.target.specs=0,x=>x.target.tests=0,x=>x.target.statusMask=32,x=>x.errors.root=64,x=>x.first.name='PRIVATE',x=>x.first.code='PRIVATE',x=>x.first.file='PRIVATE',x=>x.first.line=0,x=>x.first.column=1000001,x=>x.first.file='UNKNOWN',x=>x.scan='LIMIT',x=>x.scan='UNKNOWN',x=>x.reporter='INVALID',x=>x.disposition='REJECTED',x=>x.disposition='UNKNOWN',x=>x.child.raw='PRIVATE',x=>x.target.raw='PRIVATE',x=>x.errors.raw='PRIVATE',x=>x.first.raw='PRIVATE'];
  for(const mutate of changes){const x=f4Child();mutate(x);assert.throws(()=>api.safeChildFailure(x,'CHILD_FAILED'),/RUNNER_EVIDENCE_REJECTED/);}
  for(const field of ['closed','code','signal','reason']){const x=f4Child();delete x.child[field];assert.throws(()=>api.safeChildFailure(x,'CHILD_FAILED'),/RUNNER_EVIDENCE_REJECTED/);}
  const unknown=f4Child();Object.assign(unknown,{disposition:'UNKNOWN',reporter:'UNAVAILABLE',scan:'UNKNOWN',child:{closed:null,code:null,signal:'UNKNOWN',reason:'UNKNOWN'},target:{specs:null,tests:null,results:null,statusMask:null},errors:{root:null,target:null},first:null});
  assert.deepEqual(api.safeChildFailure(unknown,'CHILD_FAILED'),unknown);
  for(const code of [-2147483648,4294967295]){const x=f4Child();x.child.code=code;assert.equal(api.safeChildFailure(x,'CHILD_FAILED').child.code,code);}
});
test('F4 child summary snapshots descriptors once without getter/coercion and safely rejects traps', () => {
  let gets=0,coercions=0;const x=f4Child();Object.defineProperty(x.first,'name',{get(){gets++;return 'Error';}});
  assert.throws(()=>api.safeChildFailure(x,'CHILD_FAILED'),/RUNNER_EVIDENCE_REJECTED/);assert.equal(gets,0);
  const y=f4Child();y.first.code={toString(){coercions++;return 'ERR_ASSERTION';}};assert.throws(()=>api.safeChildFailure(y,'CHILD_FAILED'),/RUNNER_EVIDENCE_REJECTED/);assert.equal(coercions,0);
  const reads=new Map();const z=new Proxy(f4Child(),{getOwnPropertyDescriptor(target,key){reads.set(key,(reads.get(key)||0)+1);return Object.getOwnPropertyDescriptor(target,key);}});
  api.safeChildFailure(z,'CHILD_FAILED');assert.ok([...reads.values()].every(n=>n===1));
  for(const trap of ['ownKeys','getPrototypeOf','getOwnPropertyDescriptor'])assert.throws(()=>api.safeChildFailure(new Proxy(f4Child(),{[trap](){throw Error('PRIVATE trap');}}),'CHILD_FAILED'),/RUNNER_EVIDENCE_REJECTED/);
  assert.throws(()=>api.safeChildFailure(Object.assign(Object.create({private:'PRIVATE'}),f4Child()),'CHILD_FAILED'),/RUNNER_EVIDENCE_REJECTED/);
});
test('F4 whole-envelope parser requires child summary, forbids inappropriate summaries and preserves cleanup origin', () => {
  const {p,result}=acceptedResult();Object.assign(result,{status:'UNPROVEN',reason:'CHILD_FAILED',protocols:[],childFailure:f4Child()});
  assert.deepEqual(api.safeInnerFailure(Buffer.from(JSON.stringify(result)),p).innerFailure,f4Child());
  assert.deepEqual(api.safeRunner(result,p).childFailure,f4Child());
  for(const reason of ['CLEANUP_FAILED','CANCELLED']){const r={...result,reason};assert.equal(api.safeInnerFailure(Buffer.from(JSON.stringify(r)),p).innerFailure.origin,'CHILD_FAILED');}
  for(const change of [r=>delete r.childFailure,r=>r.childFailure=null,r=>r.childFailure.target.statusMask=31,r=>r.reason='CHILD_TIMEOUT',r=>r.reason='PIN_MISMATCH',r=>r.childFailure.raw='PRIVATE']){
    const r=JSON.parse(JSON.stringify(result));change(r);assert.throws(()=>api.safeInnerFailure(Buffer.from(JSON.stringify(r)),p),/RUNNER_EVIDENCE_REJECTED/);assert.throws(()=>api.safeRunner(r,p),/RUNNER_EVIDENCE_REJECTED/);
  }
  const pass=acceptedResult().result;pass.childFailure=f4Child();assert.throws(()=>api.safeRunner(pass,p),/RUNNER_EVIDENCE_REJECTED/);
});
test('F4 diagnosticsv2 separates canonical innerFailure, primary reason and coarse authority', () => {
  const {p,result}=acceptedResult();Object.assign(result,{status:'UNPROVEN',reason:'CHILD_FAILED',protocols:[],childFailure:f4Child()});
  const ledger=api.failureLedger('run');ledger.stage='CHILD';ledger.inner=api.safeInnerFailure(Buffer.from(JSON.stringify(result)),p);
  const d=api.rememberFailure(ledger,Error('RUNNER_UNPROVEN'));assert.equal(d.version,2);assert.equal(d.inner.validated,true);assert.equal(d.inner.reason,'CHILD_FAILED');assert.deepEqual(d.innerFailure,f4Child());
  assert.equal(d.inner.cleanup,null);assert.equal(d.inner.outerReapRequired,null);assert.ok(!JSON.stringify(d).includes('PRIVATE'));
  ledger.stage='REMOVAL';api.rememberFailure(ledger,Error('CLEANUP_FAILED'));assert.equal(ledger.primary.stage,'CHILD');assert.equal(ledger.primary.inner.reason,'CHILD_FAILED');
});
test('F4 final formatted UTF8 artifact cap includes newline and cannot truncate overflow', () => {
  assert.equal(typeof api.formatResult,'function');const exact=api.formatResult({x:'a'.repeat(8178)});assert.equal(Buffer.byteLength(exact),8192);assert.ok(exact.endsWith('\n'));
  assert.throws(()=>api.formatResult({x:'a'.repeat(8179)}),/FILE_UNPROVEN/);
  assert.throws(()=>api.formatResult({x:'\u00e9'.repeat(8178)}),/FILE_UNPROVEN/);
});
test('F4 genuinely unbound source identity rejects before runtime imports even with hosted-looking input', async () => {
  const src=fs.readFileSync(require.resolve('./api-music-nonloopback-carrier.cjs'),'utf8').replace(/^const SOURCE_(HEAD|TREE|PARENT) = '[^']+';/gm,(_,k)=>"const SOURCE_"+k+" = 'UNBOUND_S2_"+k+"';");
  const module={exports:{}};let imports=0;const req=()=>{imports++;throw Error('PRIVATE runtime import');};req.main=module;
  const stderr=[];vm.runInNewContext(src,{module,require:req,process:{argv:['node','carrier','preflight'],env:{CARRIER_MODE:'qualify',GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',EXPECTED_CARRIER_SHA:head,EXPECTED_WORKFLOW_SHA256:sha,EXPECTED_HELPER_SHA256:sha,EXPECTED_POLICY_SHA256:sha},stderr:{write:x=>stderr.push(x)}},Buffer});
  for(let n=0;n<20;n++)await Promise.resolve();assert.equal(imports,0);assert.deepEqual(stderr,['CARRIER_UNPROVEN\n']);
  const p=policy();Object.assign(p,{sourceHead:'UNBOUND_S2_HEAD',sourceTree:'UNBOUND_S2_TREE',sourceParent:'UNBOUND_S2_PARENT'});
  assert.throws(()=>module.exports.admit(p,'inspect',host),/ADMISSION_UNPROVEN/);
  assert.throws(()=>module.exports.bindSource(p,{event:'workflow_dispatch',repository:'deruta74/pear-desktop',ref:'refs/heads/diagnostic/api-nonloopback-qualified-f4',expectedCarrierSHA:head,head,githubSHA:head,workflowRef:'deruta74/pear-desktop/.github/workflows/tests.yml@refs/heads/diagnostic/api-nonloopback-qualified-f4',workflowSHA:head,parents:p.sourceHead,sourceTree:p.sourceTree,sourceParent:p.sourceParent,expectedWorkflowSHA256:sha,workflowSHA256:sha,expectedHelperSHA256:sha,helperSHA256:sha,expectedPolicySHA256:sha,policySHA256:sha,changes:expectedChanges,trackedDirty:false,unexpectedFiles:[]}),/SOURCE_UNPROVEN/);
});
test('F4 composed nonzero child projection preserves valid origin and rejects invalid whole envelope without removal', async () => {
  for(const fault of ['child-summary-valid','child-summary-invalid','child-summary-cleanup']){
    const h=await carrierMainHarness(fault);assert.equal(h.result.status,'UNPROVEN');assert.equal(h.result.diagnostics.version,2);assert.equal(h.operations.filter(([k])=>k==='rm').length,0);assert.equal(h.result.qualification,undefined);
    if(fault==='child-summary-invalid'){assert.equal(h.result.diagnostics.inner.validated,false);assert.equal(h.result.diagnostics.innerFailure,null);assert.equal(h.result.diagnostics.inner.reason,'UNKNOWN');}
    else{assert.equal(h.result.diagnostics.innerFailure.origin,'CHILD_FAILED');assert.equal(h.result.diagnostics.inner.reason,fault==='child-summary-cleanup'?'CLEANUP_FAILED':'CHILD_FAILED');}
  }
});
test('F4 error envelope rejects accessor fields and noncanonical empty protocols without serialization leaks', () => {
  const base=()=>{const {p,result}=acceptedResult();Object.assign(result,{status:'UNPROVEN',reason:'CHILD_FAILED',protocols:[],childFailure:f4Child()});return {p,result};};
  for(const kind of ['field-getter','array-private','array-getter','array-prototype']){
    const {p,result}=base();let reads=0;
    if(kind==='field-getter')Object.defineProperty(result,'status',{get(){reads++;return 'UNPROVEN';}});
    if(kind==='array-private')result.protocols.raw='PRIVATE';
    if(kind==='array-getter')Object.defineProperty(result.protocols,'toJSON',{get(){reads++;return ()=>['PRIVATE'];}});
    if(kind==='array-prototype')Object.setPrototypeOf(result.protocols,{toJSON(){reads++;return ['PRIVATE'];}});
    assert.throws(()=>api.safeRunner(result,p),/RUNNER_EVIDENCE_REJECTED/);assert.equal(reads,0);
  }
});
test('F4 exact actual timeout mapping uses injected5015ms clock and keeps every unknown fact unknown', () => {
  const module={exports:{}};let imports=0,tick=0;const ticks=[0,5015,5015];
  vm.runInNewContext(fs.readFileSync(require.resolve('./api-music-nonloopback-carrier.cjs'),'utf8'),{module,require:()=>{imports++;throw Error('forbidden');},Buffer,Date:{now:()=>ticks[tick++]}});
  const d={};assert.throws(()=>module.exports.verifyPowerShellIdentity('C:\\fixed.exe',{env:{SystemRoot:'C:\\Windows',PATH:'C:\\pinned'},parent:'C:\\temp',spawnSync:()=>({status:null,signal:'SIGKILL',error:{code:'ETIMEDOUT'},stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)})},d),/POWERSHELL_UNPROVEN/);
  assert.equal(imports,0);assert.equal(tick,3);assert.deepEqual(JSON.parse(JSON.stringify(d)),{returned:true,normalClose:false,code:null,signal:'SIGKILL',errorCode:'ETIMEDOUT',timedOut:true,killed:null,elapsedMs:5015,stdoutBytes:0,stderrBytes:0,jsonParsed:null,schemaValid:null,trusted:null,versionShapeValid:null,phaseStream:{version:1,state:'ABSENT',last:null,completed:0}});
});

// The report driver supplies these ACTUAL root-sealed S2 declarations inertly.
function f4S2Report(results, errors=[]) {
  return {errors,suites:[{specs:[{file:'tests/api-music-remote-http.test.ts',title:'runtime-admitted nonloopback HTTP and TLS require actual direct peers',tests:[{results}]}]}]};
}
function f4S2Summary(report, changes={}) {
  return require('./qualify-api-music-nonloopback.cjs').summarizeChildFailure('CHILD_FAILED','RETURNED',{closed:true,code:1,signal:null,reason:null,stdout:JSON.stringify(report),...changes},'/source');
}
function f4S2Project(summary, reason='CHILD_FAILED') {
  const {p,result}=acceptedResult();Object.assign(result,{status:'UNPROVEN',reason,protocols:[],childFailure:summary});
  const decoded=api.safeInnerFailure(Buffer.from(JSON.stringify(result)),p);
  assert.equal(decoded.validated,true);assert.deepEqual(decoded.innerFailure,summary);
  assert.deepEqual(api.safeRunner(result,p).childFailure,summary);
  return decoded;
}
test('F4 actual S2 producer canonical summary projects without fields, enums or privacy changes', () => {
  const producer=require('./qualify-api-music-nonloopback.cjs');
  const x=f4S2Summary(f4S2Report([{status:'failed',error:{name:'TypeError',code:'ERR_MODULE_NOT_FOUND',location:{file:'tests/api-music-remote-http.test.ts',line:11,column:3},message:'PRIVATE producer detail'},errors:[{}]}]));
  assert.deepEqual(producer.validateChildFailure(x),x);assert.equal(x.first.file,'TEST');assert.equal(x.first.line,11);assert.equal(x.first.column,3);
  f4S2Project(x);assert.ok(Buffer.byteLength(JSON.stringify(x))<=1024);assert.ok(!JSON.stringify(x).includes('PRIVATE'));
  for(const origin of ['CHILD_FAILED','CHILD_NO_CLOSE','CHILD_TIMEOUT','CHILD_OUTPUT_LIMIT','CHILD_CANCELLED','CHILD_SPAWN_FAILED','CHILD_LOG_FAILED']){
    const y=producer.summarizeChildFailure(origin,'UNKNOWN',undefined,'/source');f4S2Project(y,origin);assert.equal(y.child.signal,'UNKNOWN');assert.equal(y.child.closed,null);
  }
});
test('F4 S2-F2 present formatted errors including empty arrays retain exact projected counts', () => {
  for(const shape of ['empty','nonempty','absent']){
    const result={status:'failed',error:{stack:'TypeError: PRIVATE'},errors:[{stack:'RangeError: PRIVATE'}]};
    if(shape==='empty')result.errors=[];if(shape==='absent')delete result.errors;
    const x=f4S2Summary(f4S2Report([result]));assert.equal(x.scan,'COMPLETE');assert.equal(x.errors.target,shape==='empty'?0:1);assert.equal(x.first===null,shape==='empty');f4S2Project(x);
  }
  const x=f4S2Summary(f4S2Report([{status:'failed',error:{stack:'TypeError: PRIVATE'},errors:[]}],Array.from({length:64},()=>({stack:'SyntaxError: PRIVATE'}))));
  assert.equal(x.scan,'COMPLETE');assert.equal(x.errors.root,64);assert.equal(x.errors.target,0);assert.equal(x.first.name,'TypeError');f4S2Project(x);
});
test('F4 S2-F2 first qualifying failed result stays latched through outer projection', () => {
  for(const status of ['failed','timedOut','interrupted'])for(const withRoot of [false,true]){
    const x=f4S2Summary(f4S2Report([{status,errors:[]},{status:'failed',error:{stack:'TypeError: PRIVATE'},errors:[{stack:'RangeError: PRIVATE'}]}],withRoot?[{stack:'SyntaxError: PRIVATE'}]:[]));
    assert.equal(x.target.results,2);assert.equal(x.errors.target,1);assert.equal(x.first?.name??null,withRoot?'SyntaxError':null);f4S2Project(x);
  }
  for(const status of ['failed','timedOut','interrupted'])for(const raw of [false,true]){
    const first={status,errors:[{stack:'RangeError: PRIVATE'}]};if(raw)first.error={stack:'TypeError: PRIVATE'};
    const x=f4S2Summary(f4S2Report([first,{status:'failed',error:{stack:'ReferenceError: PRIVATE'}}],[{stack:'SyntaxError: PRIVATE'}]));assert.equal(x.first.name,raw?'TypeError':'RangeError');f4S2Project(x);
  }
  for(const status of ['passed','skipped']){
    const x=f4S2Summary(f4S2Report([{status,error:{stack:'TypeError: PRIVATE'}},{status:'interrupted',error:{stack:'SyntaxError: PRIVATE'}}],[{stack:'RangeError: PRIVATE'}]));assert.equal(x.first.name,'SyntaxError');f4S2Project(x);
  }
});
test('F4 actual S2 fake orchestration preserves child origin under cleanup failure and late cancellation', async () => {
  const producer=require('./qualify-api-music-nonloopback.cjs');const {p}=acceptedResult();
  for(const finalReason of ['CHILD_FAILED','CLEANUP_FAILED','CANCELLED']){
    let inventory=0,executions=0,removals=0,cancelled=false;
    const x=await producer.runQualification(p,{verifyPins:async()=>{},readInterfaces:()=>{inventory++;return{fake:[{family:'IPv4',internal:false,address:'10.3.4.5'}]};},createPrivateTemp:async()=>'/owned',writeAdmission:async()=>{},execute:async spec=>{executions++;assert.equal(spec.command,p.node.path);assert.ok(spec.args.includes('--global-timeout=120000'));return{closed:true,code:1,signal:null,reason:null,stdout:JSON.stringify(f4S2Report([{status:'failed',errors:[{}]}]))};},removeTemp:async()=>{removals++;if(finalReason==='CLEANUP_FAILED')throw Error('PRIVATE cleanup');if(finalReason==='CANCELLED')cancelled=true;},isCancelled:()=>cancelled,sourceRoot:'/source'});
    assert.equal(inventory,1);assert.equal(executions,1);assert.equal(removals,1);assert.equal(x.status,'UNPROVEN');assert.equal(x.reason,finalReason);assert.equal(x.childFailure.origin,'CHILD_FAILED');
    const inner=api.safeInnerFailure(Buffer.from(JSON.stringify(x)),p);assert.equal(inner.reason,finalReason);assert.deepEqual(inner.innerFailure,x.childFailure);assert.equal(inner.cleanup,null);assert.equal(inner.outerReapRequired,null);
  }
});
test('F4 actual producer summary mutation or required omission rejects the entire source-bound envelope', () => {
  const x=f4S2Summary(f4S2Report([{status:'failed',errors:[{}]}]));
  for(const change of [r=>delete r.childFailure,r=>r.childFailure.target.statusMask=31,r=>r.childFailure.first={name:'Error',code:'UNKNOWN',file:'PRIVATE',line:1,column:1},r=>r.childFailure.raw='PRIVATE',r=>r.reason='CHILD_TIMEOUT']){
    const {p,result}=acceptedResult();Object.assign(result,{status:'UNPROVEN',reason:'CHILD_FAILED',protocols:[],childFailure:JSON.parse(JSON.stringify(x))});change(result);
    assert.throws(()=>api.safeInnerFailure(Buffer.from(JSON.stringify(result)),p),/RUNNER_EVIDENCE_REJECTED/);assert.throws(()=>api.safeRunner(result,p),/RUNNER_EVIDENCE_REJECTED/);
  }
});
test('F4 actual S2 unknown and bounded reporter states project without raw stdout or invented observations', () => {
  const producer=require('./qualify-api-music-nonloopback.cjs');let reads=0;
  const child={closed:false,code:null,signal:null,reason:null};Object.defineProperty(child,'stdout',{get(){reads++;return 'PRIVATE';}});
  const unknown=producer.summarizeChildFailure('CHILD_NO_CLOSE','RETURNED',child,'/source');assert.equal(reads,0);assert.equal(unknown.child.closed,false);assert.equal(unknown.child.signal,null);f4S2Project(unknown,'CHILD_NO_CLOSE');
  for(const [stdout,reporter,scan] of [['','EMPTY','UNKNOWN'],['PRIVATE malformed','INVALID','UNKNOWN'],['null','VALID','UNKNOWN'],['x'.repeat(2097153),'UNAVAILABLE','LIMIT']]){
    const x=f4S2Summary({}, {stdout});assert.equal(x.reporter,reporter);assert.equal(x.scan,scan);assert.equal(x.target.results,null);assert.equal(x.first,null);f4S2Project(x);assert.ok(!JSON.stringify(x).includes('PRIVATE'));
  }
});
test('F4 actual S2-F2 producer reaches composed outer main with zero counts and no deletion authority', async () => {
  for(const fault of ['producer-summary-valid','producer-summary-invalid','producer-summary-cleanup','producer-summary-cancelled']){
    const h=await carrierMainHarness(fault);assert.equal(h.result.status,'UNPROVEN');assert.equal(h.operations.filter(([k])=>k==='rm').length,0);assert.equal(h.result.qualification,undefined);
    if(fault==='producer-summary-invalid'){assert.equal(h.result.diagnostics.inner.validated,false);assert.equal(h.result.diagnostics.innerFailure,null);}
    else{assert.equal(h.result.diagnostics.innerFailure.origin,'CHILD_FAILED');assert.equal(h.result.diagnostics.innerFailure.errors.target,0);assert.equal(h.result.diagnostics.innerFailure.first,null);assert.equal(h.result.diagnostics.inner.reason,fault==='producer-summary-cleanup'?'CLEANUP_FAILED':fault==='producer-summary-cancelled'?'CANCELLED':'CHILD_FAILED');}
    assert.ok(!JSON.stringify(h.result).includes('PRIVATE'));
  }
});
