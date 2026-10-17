'use strict';

// SOURCE ONLY. Imports are inert. No local execution or CI is admitted here.
const CARRIER_PATHS = [
  '.github/workflows/tests.yml',
  'scripts/api-music-nonloopback-admission.json',
  'scripts/api-music-nonloopback-carrier.cjs',
  'scripts/api-music-nonloopback-carrier.node.cjs',
];
const CARRIER_CHANGES = CARRIER_PATHS.map(
  (file, index) => (index === 0 ? 'M' : 'A') + '\t' + file,
);
const SOURCE_HEAD = '978c10380c10ae2e185f8186e483bc8df0d29711';
const SOURCE_TREE = '976f9436174b47a67006484374a7bac4bfd89f86';
const SOURCE_PARENT = '6943f9955455cee62f14803ff96f48f9e8764028';
const STATIC_SVG = 'assets/generated/icons/mac/icon.icon/Assets/SVG Image.svg';
const fail = (reason) => {
  throw Error(reason);
};
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, names) =>
  object(v) && Object.keys(v).sort().join('|') === [...names].sort().join('|');
const sha = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const head = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const image = (v) => typeof v === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(v);
const numberId = (v) => typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v);
function admit(policy, mode, actual) {
  const bad = () => fail('ADMISSION_UNPROVEN');
  if (
    !['inspect', 'qualify'].includes(mode) ||
    !keys(policy, [
      'schema',
      'sourceHead',
      'sourceTree',
      'sourceParent',
      'nodeVersion',
      'pnpmVersion',
      'lockSHA256',
      'cliSHA256',
      'platforms',
    ]) ||
    policy.schema !== 1 ||
    policy.sourceHead !== SOURCE_HEAD ||
    policy.sourceTree !== SOURCE_TREE ||
    policy.sourceParent !== SOURCE_PARENT ||
    policy.nodeVersion !== 'v24.20.0' ||
    policy.pnpmVersion !== '11.28.6' ||
    !sha(policy.lockSHA256) ||
    !sha(policy.cliSHA256) ||
    !Array.isArray(policy.platforms) ||
    policy.platforms.length !== 3
  )
    bad();
  const triples = [
    ['ubuntu-24.04', 'linux', 'x64'],
    ['macos-latest', 'darwin', 'arm64'],
    ['windows-latest', 'win32', 'x64'],
  ];
  policy.platforms.forEach((row, i) => {
    if (
      !keys(row, [
        'label',
        'platform',
        'arch',
        'imageOS',
        'imageVersion',
        'nodeSHA256',
        'systemRoot',
        'powerShellIdentity',
      ]) ||
      [row.label, row.platform, row.arch].join('|') !== triples[i].join('|') ||
      !(row.imageOS === null || image(row.imageOS)) ||
      !(row.imageVersion === null || image(row.imageVersion)) ||
      !(row.nodeSHA256 === null || sha(row.nodeSHA256)) ||
      (row.platform === 'win32'
        ? row.systemRoot !== 'C:\\Windows' ||
          row.powerShellIdentity !== 'MICROSOFT_AUTHENTICODE_VALID'
        : row.systemRoot !== null || row.powerShellIdentity !== null)
    )
      bad();
  });
  const row = policy.platforms.find((row) => row.platform === actual.platform);
  if (!row || row.arch !== actual.arch) bad();
  if (
    mode === 'qualify' &&
    (!image(row.imageVersion) ||
      !sha(row.nodeSHA256) ||
      (row.imageOS !== null && row.imageOS !== actual.imageOS) ||
      row.imageVersion !== actual.imageVersion ||
      actual.nodeVersion !== policy.nodeVersion ||
      row.nodeSHA256 !== actual.nodeSHA256 ||
      (row.platform === 'win32' &&
        (row.systemRoot !== actual.systemRoot ||
          row.powerShellIdentity !== actual.powerShellIdentity)))
  )
    bad();
  return row;
}
function bindSource(policy, value) {
  const bad = () => fail('SOURCE_UNPROVEN');
  if (
    value.event !== 'workflow_dispatch' ||
    value.repository !== 'deruta74/pear-desktop' ||
    value.ref !== 'refs/heads/diagnostic/api-nonloopback-qualified-f2' ||
    !head(value.expectedCarrierSHA) ||
    value.head !== value.expectedCarrierSHA ||
    value.githubSHA !== value.head ||
    value.workflowRef !==
      'deruta74/pear-desktop/.github/workflows/tests.yml@' + value.ref ||
    value.workflowSHA !== value.head ||
    value.parents !== policy.sourceHead ||
    value.sourceTree !== policy.sourceTree ||
    value.sourceParent !== policy.sourceParent ||
    !sha(value.expectedWorkflowSHA256) ||
    value.workflowSHA256 !== value.expectedWorkflowSHA256 ||
    !sha(value.expectedHelperSHA256) ||
    value.helperSHA256 !== value.expectedHelperSHA256 ||
    !sha(value.expectedPolicySHA256) ||
    value.policySHA256 !== value.expectedPolicySHA256 ||
    !Array.isArray(value.changes) ||
    [...value.changes].sort().join('|') !==
      [...CARRIER_CHANGES].sort().join('|') ||
    value.trackedDirty !== false ||
    !Array.isArray(value.unexpectedFiles) ||
    value.unexpectedFiles.length
  )
    bad();
}
function makePlan(policy, row, env, node, manifestSHA256, jobId) {
  if (
    !numberId(jobId) ||
    !numberId(env.GITHUB_RUN_ID) ||
    !numberId(env.GITHUB_RUN_ATTEMPT) ||
    !sha(manifestSHA256)
  )
    fail('ADMISSION_UNPROVEN');
  return {
    schema: 1,
    disposableRunner: true,
    platform: row.platform,
    arch: row.arch,
    image: env.ImageVersion,
    repository: 'deruta74/pear-desktop',
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    jobId,
    expectedHead: policy.sourceHead,
    expectedTree: policy.sourceTree,
    sourceManifestSHA256: manifestSHA256,
    node,
    cliSHA256: policy.cliSHA256,
    lockSHA256: policy.lockSHA256,
  };
}
function runnerManifest(complete) {
  const runtime = {};
  for (const [file, hash] of Object.entries(complete)) {
    if (file === STATIC_SVG) continue;
    if (!/^[A-Za-z0-9_.@/-]+$/.test(file) || !sha(hash))
      fail('SOURCE_UNPROVEN');
    runtime[file] = hash;
  }
  return runtime;
}
function runnerEnvironment(env, nodeDirectory, privateRoot, path) {
  const out = {
    CI: '1',
    PATH: nodeDirectory,
    HOME: privateRoot,
    USERPROFILE: privateRoot,
    TEMP: path.join(privateRoot, 'tmp'),
    TMP: path.join(privateRoot, 'tmp'),
    TMPDIR: path.join(privateRoot, 'tmp'),
  };
  for (const name of [
    'GITHUB_ACTIONS',
    'RUNNER_ENVIRONMENT',
    'RUNNER_TEMP',
    'GITHUB_REPOSITORY',
    'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT',
    'ImageVersion',
  ])
    out[name] = env[name];
  if (env.SystemRoot) out.SystemRoot = env.SystemRoot;
  return out;
}
function verifyPowerShellIdentity(tool, io) {
  const program = String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$WarningPreference='SilentlyContinue'
try {
  $request=[Console]::In.ReadLine()|ConvertFrom-Json
  $tool=[IO.Path]::GetFullPath([string]$request.tool)
  if($tool -cne [string]$request.tool){throw 'unavailable'}
  $item=Get-Item -LiteralPath $tool -Force
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'unavailable'}
  $signature=Get-AuthenticodeSignature -LiteralPath $tool
  if($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)'){throw 'unavailable'}
  $v=[Diagnostics.FileVersionInfo]::GetVersionInfo($tool)
  $version=@($v.FileMajorPart,$v.FileMinorPart,$v.FileBuildPart,$v.FilePrivatePart)-join '.'
  [Console]::Write(('{"version":1,"trusted":true,"fileVersion":"'+$version+'"}'))
}catch{[Console]::Write('{"version":1,"trusted":false}');exit 1}
`;
  try {
    const input = JSON.stringify({ tool }) + '\n';
    if (Buffer.byteLength(input) > 16384) throw Error();
    const result = io.spawnSync(
      tool,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(program, 'utf16le').toString('base64'),
      ],
      {
        shell: false,
        windowsHide: true,
        encoding: null,
        input,
        timeout: 5000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024,
        env: {
          CI: '1',
          SystemRoot: io.env.SystemRoot,
          PATH: io.env.PATH,
          TEMP: io.parent,
          TMP: io.parent,
        },
      },
    );
    if (
      result.error ||
      result.status !== 0 ||
      result.signal ||
      !result.stdout ||
      result.stdout.length > 256 ||
      result.stderr?.length
    )
      throw Error();
    const value = JSON.parse(result.stdout.toString('utf8'));
    if (
      !keys(value, ['version', 'trusted', 'fileVersion']) ||
      value.version !== 1 ||
      value.trusted !== true ||
      typeof value.fileVersion !== 'string' ||
      !/^\d{1,10}(\.\d{1,10}){3}$/.test(value.fileVersion)
    )
      throw Error();
    return value.fileVersion;
  } catch {
    fail('POWERSHELL_UNPROVEN');
  }
}
// This schema validates data emitted by the pinned runner; no raw Playwright or error text is copied.
function safeRunner(value, plan) {
  const expected = [
    'schema',
    'status',
    'reason',
    'protocols',
    'platform',
    'arch',
    'image',
    'expectedHead',
    'expectedTree',
    'sourceManifestSHA256',
    'nodeVersion',
    'nodeSHA256',
    'cliSHA256',
    'lockSHA256',
    'certSHA256',
    'runURL',
    'jobId',
    'endpointLabel',
  ];
  const optional = ['cleanup', 'outerReapRequired'];
  if (
    !object(value) ||
    !expected.every((k) => Object.hasOwn(value, k)) ||
    Object.keys(value).some(
      (k) => !expected.includes(k) && !optional.includes(k),
    )
  )
    fail('RUNNER_EVIDENCE_REJECTED');
  const reasons = [
    'CHECKPOINTS_COMPLETE',
    'INVALID_PLAN',
    'PIN_MISMATCH',
    'TOPOLOGY_UNAVAILABLE',
    'WINDOWS_PRIVATE_TEMP_UNPROVEN',
    'PRIVATE_TEMP_FAILED',
    'ADMISSION_WRITE_FAILED',
    'CHILD_FAILED',
    'CHILD_NO_CLOSE',
    'CHILD_TIMEOUT',
    'CHILD_OUTPUT_LIMIT',
    'CHILD_CANCELLED',
    'CHILD_SPAWN_FAILED',
    'CHILD_LOG_FAILED',
    'INVALID_REPORT',
    'CLEANUP_FAILED',
    'CANCELLED',
    'WINDOWS_HELPER_NO_CLOSE',
  ];
  if (
    value.schema !== 1 ||
    !['PASS', 'UNPROVEN'].includes(value.status) ||
    !reasons.includes(value.reason) ||
    value.platform !== plan.platform ||
    value.arch !== plan.arch ||
    value.image !== plan.image ||
    value.expectedHead !== plan.expectedHead ||
    value.expectedTree !== plan.expectedTree ||
    value.sourceManifestSHA256 !== plan.sourceManifestSHA256 ||
    value.nodeVersion !== plan.node.version ||
    value.nodeSHA256 !== plan.node.sha256 ||
    value.cliSHA256 !== plan.cliSHA256 ||
    value.lockSHA256 !== plan.lockSHA256 ||
    value.certSHA256 !==
      '597b4509e1ad0c12b69402bc0cff55bcb3f28603dea13a36623eb38891d109a3' ||
    value.runURL !==
      'https://github.com/' +
        plan.repository +
        '/actions/runs/' +
        plan.runId +
        '/attempts/' +
        plan.attempt ||
    value.jobId !== plan.jobId ||
    value.endpointLabel !== 'runner-owned-v4' ||
    (Object.hasOwn(value, 'cleanup') && value.cleanup !== 'UNPROVEN') ||
    (Object.hasOwn(value, 'outerReapRequired') &&
      value.outerReapRequired !== true) ||
    !Array.isArray(value.protocols)
  )
    fail('RUNNER_EVIDENCE_REJECTED');
  if (value.status === 'PASS') {
    if (
      value.reason !== 'CHECKPOINTS_COMPLETE' ||
      value.protocols.length !== 2 ||
      value.cleanup ||
      value.outerReapRequired
    )
      fail('RUNNER_EVIDENCE_REJECTED');
    // Accepted runner already parses the actual Playwright report. Repeat its exact
    // telemetry shape/leaf allowlist here so the artifact boundary rejects extra strings.
    const shape = {
      version: 1,
      endpoint: {
        label: 'owned-v4',
        family: 4,
        observations: 'integer',
        port: 'integer',
        nonloopback: true,
        peerMatchesAdmission: true,
        localMatchesAdmission: true,
        owned: true,
        epochs: 'epochs',
      },
      tls: {
        encrypted: 'boolean',
        versions: 'versions',
        verifiedResponses: 'integer',
        peerLeafFingerprint256: 'fingerprint',
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
        requests: 'integer',
        nativeReadPackets: 'integer',
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
    function check(v, s) {
      if (object(s)) {
        if (!keys(v, Object.keys(s))) fail('RUNNER_EVIDENCE_REJECTED');
        for (const key of Object.keys(s)) check(v[key], s[key]);
      } else if (s === 'integer') {
        if (!Number.isSafeInteger(v) || v < 0 || v > 65535)
          fail('RUNNER_EVIDENCE_REJECTED');
      } else if (s === 'boolean') {
        if (typeof v !== 'boolean') fail('RUNNER_EVIDENCE_REJECTED');
      } else if (s === 'epochs') {
        if (!Array.isArray(v) || v.length !== 4)
          fail('RUNNER_EVIDENCE_REJECTED');
        ['disabled', 'A', 'B', 'configured'].forEach((label, i) => {
          if (
            !keys(v[i], ['label', 'observations']) ||
            v[i].label !== label ||
            !Number.isInteger(v[i].observations) ||
            v[i].observations < 1 ||
            v[i].observations > 256
          )
            fail('RUNNER_EVIDENCE_REJECTED');
        });
      } else if (s === 'versions') {
        if (
          !Array.isArray(v) ||
          v.length > 2 ||
          new Set(v).size !== v.length ||
          v.some((x) => !['TLSv1.2', 'TLSv1.3'].includes(x))
        )
          fail('RUNNER_EVIDENCE_REJECTED');
      } else if (s === 'fingerprint') {
        if (
          v !== null &&
          v !==
            'fb6e906aa7015cfe4194ac90bd771a3b4f4d2eecef8ba4614b079a59138f35b1'
        )
          fail('RUNNER_EVIDENCE_REJECTED');
      } else if (v !== s) fail('RUNNER_EVIDENCE_REJECTED');
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
    ['HTTP', 'TLS'].forEach((protocol, i) => {
      const p = value.protocols[i];
      if (
        !keys(p, ['protocol', 'checkpoints', 'outcome', 'telemetry']) ||
        p.protocol !== protocol ||
        p.outcome !== 'PASS' ||
        JSON.stringify(p.checkpoints) !== JSON.stringify(checkpoints)
      )
        fail('RUNNER_EVIDENCE_REJECTED');
      check(p.telemetry, shape);
      const { endpoint: e, tls: t, counts: c } = p.telemetry;
      if (
        e.observations < 1 ||
        e.observations > 256 ||
        e.port < 1 ||
        e.epochs.reduce((n, r) => n + r.observations, 0) !== e.observations ||
        c.requests !== e.observations ||
        c.nativeReadPackets < 5 ||
        c.nativeReadPackets > 128 ||
        c.nativeReadPackets > c.requests ||
        t.verifiedResponses > e.observations
      )
        fail('RUNNER_EVIDENCE_REJECTED');
      if (
        protocol === 'HTTP'
          ? t.encrypted ||
            t.versions.length ||
            t.verifiedResponses ||
            t.peerLeafFingerprint256 !== null
          : !t.encrypted ||
            !t.versions.length ||
            t.verifiedResponses < 1 ||
            t.peerLeafFingerprint256 === null
      )
        fail('RUNNER_EVIDENCE_REJECTED');
    });
  } else if (value.protocols.length) fail('RUNNER_EVIDENCE_REJECTED');
  return JSON.parse(JSON.stringify(value));
}
module.exports = {
  CARRIER_PATHS,
  CARRIER_CHANGES,
  admit,
  bindSource,
  makePlan,
  runnerEnvironment,
  safeRunner,
  verifyPowerShellIdentity,
  runnerManifest,
};

if (typeof require !== 'undefined' && require.main === module)
  main().catch(() => {
    process.stderr.write('CARRIER_UNPROVEN\n');
    process.exitCode = 1;
  });
async function main() {
  const e = process.env,
    command = process.argv[2],
    mode = e.CARRIER_MODE;
  // Before any runtime builtin, file access, child, or directory creation.
  if (
    process.argv.length !== 3 ||
    !['preflight', 'prepare', 'run', 'cleanup'].includes(command) ||
    mode !== 'qualify' ||
    e.GITHUB_ACTIONS !== 'true' ||
    e.RUNNER_ENVIRONMENT !== 'github-hosted'
  )
    fail('HOST_UNPROVEN');
  const fs = require('node:fs'),
    fsp = fs.promises,
    path = require('node:path'),
    crypto = require('node:crypto'),
    cp = require('node:child_process');
  const cwd = path.resolve(__dirname, '..'),
    safe = path.join(cwd, 'api-music-nonloopback-safe');
  const digest = (b) => crypto.createHash('sha256').update(b).digest('hex');
  async function read(file, max = 16 * 1024 * 1024) {
    const handle = await fsp.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > max) fail('FILE_UNPROVEN');
      const bytes = await handle.readFile();
      if (bytes.length > max) fail('FILE_UNPROVEN');
      return bytes;
    } finally {
      await handle.close();
    }
  }
  const git = (...args) =>
    cp
      .execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      })
      .trim();
  const policy = JSON.parse(
    await read(
      path.join(__dirname, 'api-music-nonloopback-admission.json'),
      16384,
    ),
  );
  const names = (text) => (text ? text.split(/\r?\n/) : []);
  const untracked = names(git('ls-files', '--others', '--exclude-standard'));
  bindSource(policy, {
    event: e.GITHUB_EVENT_NAME,
    repository: e.GITHUB_REPOSITORY,
    ref: e.GITHUB_REF,
    githubSHA: e.GITHUB_SHA,
    workflowRef: e.GITHUB_WORKFLOW_REF,
    workflowSHA: e.GITHUB_WORKFLOW_SHA,
    expectedCarrierSHA: e.EXPECTED_CARRIER_SHA,
    head: git('rev-parse', 'HEAD'),
    parents: git('show', '-s', '--format=%P', 'HEAD'),
    sourceTree: git('rev-parse', policy.sourceHead + '^{tree}'),
    sourceParent: git('show', '-s', '--format=%P', policy.sourceHead),
    workflowSHA256: digest(await read(path.join(cwd, CARRIER_PATHS[0]))),
    expectedWorkflowSHA256: e.EXPECTED_WORKFLOW_SHA256,
    helperSHA256: digest(await read(path.join(cwd, CARRIER_PATHS[2]))),
    expectedHelperSHA256: e.EXPECTED_HELPER_SHA256,
    policySHA256: digest(await read(path.join(cwd, CARRIER_PATHS[1]))),
    expectedPolicySHA256: e.EXPECTED_POLICY_SHA256,
    changes: names(
      git('diff', '--name-status', '--no-renames', policy.sourceHead, 'HEAD'),
    ),
    trackedDirty: git('status', '--porcelain', '--untracked-files=no') !== '',
    unexpectedFiles: untracked.filter(
      (p) =>
        ![
          'api-music-runtime-manifest.json',
          'api-music-nonloopback-safe/result.json',
        ].includes(p),
    ),
  });
  if (!image(e.ImageOS) || !image(e.ImageVersion)) fail('HOST_UNPROVEN');
  const actual = {
    platform: process.platform,
    arch: process.arch,
    imageOS: e.ImageOS,
    imageVersion: e.ImageVersion,
    nodeVersion: process.version,
    nodeSHA256: digest(await read(process.execPath, 256 * 1024 * 1024)),
  };
  const row = admit(policy, 'inspect', actual);
  if (
    row.imageVersion !== e.ImageVersion ||
    (row.imageOS !== null && row.imageOS !== e.ImageOS)
  )
    fail('ADMISSION_UNPROVEN');
  if (command === 'preflight') {
    if (policy.platforms.some((r) => !r.imageVersion || !r.nodeSHA256))
      fail('ADMISSION_UNPROVEN');
    process.stdout.write('SOURCE_BOUND\n');
    return;
  }
  if (
    actual.nodeVersion !== policy.nodeVersion ||
    actual.nodeSHA256 !== row.nodeSHA256
  )
    fail('ADMISSION_UNPROVEN');
  if (process.platform === 'win32') {
    // Read only the fixed tool chain. No executable or path comes from input.
    if (e.SystemRoot !== row.systemRoot) fail('POWERSHELL_UNPROVEN');
    const {
      resolveWindowsPowerShell,
    } = require('./api-music-windows-private-root.cjs');
    const tools = await resolveWindowsPowerShell({
      fsp,
      path,
      systemRoot: e.SystemRoot,
    });
    actual.systemRoot = tools.systemRoot;
    actual.powerShellFileVersion = verifyPowerShellIdentity(tools.powerShell, {
      spawnSync: cp.spawnSync,
      env: {
        SystemRoot: tools.systemRoot,
        PATH: path.dirname(process.execPath),
      },
      parent: e.RUNNER_TEMP,
    });
    actual.powerShellIdentity = 'MICROSOFT_AUTHENTICODE_VALID';
  }
  const { systemRoot, ...safeActual } = actual;
  const carrierTree = git('rev-parse', 'HEAD^{tree}');
  if (!head(carrierTree)) fail('SOURCE_UNPROVEN');
  const provenance = {
    sourceHead: policy.sourceHead,
    sourceTree: policy.sourceTree,
    carrierHead: e.GITHUB_SHA,
    carrierTree,
    registeredWorkflowId: '376634247',
    diagnosticRef: 'diagnostic/api-nonloopback-qualified-f2',
    workflowSHA256: e.EXPECTED_WORKFLOW_SHA256,
    helperSHA256: e.EXPECTED_HELPER_SHA256,
    policySHA256: e.EXPECTED_POLICY_SHA256,
    ...safeActual,
    systemRootMatches:
      process.platform === 'win32' ? systemRoot === row.systemRoot : null,
  };
  if (mode !== 'qualify') fail('ADMISSION_UNPROVEN');
  admit(policy, mode, actual);
  const {
    createPrivateTempDirectory,
    removeOwnedTemp,
    validatePlan,
  } = require('./qualify-api-music-nonloopback.cjs');
  const remove = (directory) =>
    removeOwnedTemp(directory, {
      remove: (v) =>
        fsp.rm(v, {
          recursive: true,
          force: true,
          maxRetries: 2,
          retryDelay: 100,
        }),
      setTimeout,
      clearTimeout,
    });
  const marker = {
    schema: 1,
    carrier: e.GITHUB_SHA,
    run: e.GITHUB_RUN_ID,
    attempt: e.GITHUB_RUN_ATTEMPT,
  };
  if (command === 'prepare') {
    const root = await createPrivateTempDirectory({
      fsp,
      path,
      runnerTemp: e.RUNNER_TEMP,
      platform: process.platform,
      setTimeout,
      clearTimeout,
      makeWindowsPrivateDirectory:
        process.platform === 'win32'
          ? (parent) =>
              require('./api-music-windows-private-root.cjs').createWindowsPrivateDirectory(
                parent,
                {
                  fsp,
                  path,
                  systemRoot: e.SystemRoot,
                  spawn: cp.spawn,
                  env: { PATH: path.dirname(process.execPath) },
                  setTimeout,
                  clearTimeout,
                  signalSource: process,
                  removeOwnedTemp,
                },
              )
          : undefined,
    });
    await fsp.writeFile(path.join(root, 'owner.json'), JSON.stringify(marker), {
      flag: 'wx',
      mode: 0o600,
    });
    await fsp.writeFile(path.join(root, 'empty-user.npmrc'), '', {
      flag: 'wx',
      mode: 0o600,
    });
    await fsp.writeFile(path.join(root, 'empty-global.npmrc'), '', {
      flag: 'wx',
      mode: 0o600,
    });
    await fsp.appendFile(
      e.GITHUB_ENV,
      'PEAR_MUSIC_CARRIER_PRIVATE_ROOT=' + root + '\n',
    );
    return;
  }
  const root = e.PEAR_MUSIC_CARRIER_PRIVATE_ROOT;
  if (
    typeof root !== 'string' ||
    path.dirname(root) !== path.resolve(e.RUNNER_TEMP) ||
    !path.basename(root).startsWith('pear-music-nonloopback-')
  )
    fail('OWNERSHIP_UNPROVEN');
  if (command === 'cleanup') {
    try {
      await fsp.lstat(root);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
  if (
    (await fsp.realpath(root)) !== root ||
    JSON.stringify(
      JSON.parse(await read(path.join(root, 'owner.json'), 1024)),
    ) !== JSON.stringify(marker)
  )
    fail('OWNERSHIP_UNPROVEN');
  if (command === 'cleanup') {
    // An interrupted/failed runner may retain descendants. Preserve its private
    // directory for disposable VM teardown, rather than deleting beneath it.
    if (fs.existsSync(path.join(root, 'reap-required'))) return;
    await remove(root);
    return;
  }
  if (command !== 'run') fail('HOST_UNPROVEN');
  await fsp.mkdir(safe, { recursive: false, mode: 0o700 });
  let result = {
    schema: 1,
    status: 'UNPROVEN',
    reason: 'CARRIER_FAILED',
    manifestScope: 'CARRIER_HEAD_TRACKED_FILES',
    provenance,
    processAbsence: 'UNPROVEN',
    outerReap: 'HOSTED_VM_AT_JOB_END',
  };
  let mayRemove = false;
  try {
    if (
      digest(await read(path.join(cwd, 'pnpm-lock.yaml'))) !==
        policy.lockSHA256 ||
      digest(
        await read(path.join(cwd, 'node_modules/@playwright/test/cli.js')),
      ) !== policy.cliSHA256
    )
      fail('DEPENDENCY_UNPROVEN');
    const installed = JSON.parse(
      await read(path.join(cwd, 'node_modules/@playwright/test/package.json')),
    );
    if (installed.version !== '1.61.1') fail('DEPENDENCY_UNPROVEN');
    const manifest = {};
    for (const file of names(git('ls-tree', '-r', '--name-only', 'HEAD'))) {
      if (
        !/^[A-Za-z0-9_.@/ -]+$/.test(file) ||
        file.split('/').some((p) => !p || p === '.' || p === '..')
      )
        fail('SOURCE_UNPROVEN');
      const target = path.join(cwd, file);
      if ((await fsp.realpath(target)) !== target) fail('SOURCE_UNPROVEN');
      manifest[file] = digest(await read(target));
    }
    // All current carrier HEAD files, including the fixed static SVG, are bound here. Only
    // that non-executable asset is omitted from the runner's stricter grammar.
    const completeBytes = Buffer.from(JSON.stringify(manifest));
    await fsp.writeFile(
      path.join(root, 'complete-carrier-manifest.json'),
      completeBytes,
      { flag: 'wx', mode: 0o600 },
    );
    const manifestBytes = Buffer.from(JSON.stringify(runnerManifest(manifest)));
    await fsp.writeFile(
      path.join(cwd, 'api-music-runtime-manifest.json'),
      manifestBytes,
      { flag: 'wx', mode: 0o600 },
    );
    const plan = makePlan(
      policy,
      row,
      e,
      {
        path: process.execPath,
        version: process.version,
        sha256: actual.nodeSHA256,
      },
      digest(manifestBytes),
      e.QUALIFICATION_JOB_ID,
    );
    validatePlan(plan);
    const planFile = path.join(root, 'plan.json');
    await fsp.writeFile(planFile, JSON.stringify(plan), {
      flag: 'wx',
      mode: 0o600,
    });
    const stdout = fs.openSync(path.join(root, 'runner.stdout'), 'wx', 0o600),
      stderr = fs.openSync(path.join(root, 'runner.stderr'), 'wx', 0o600);
    let child;
    try {
      child = cp.spawnSync(
        process.execPath,
        [
          path.join(__dirname, 'qualify-api-music-nonloopback.cjs'),
          '--execute-admitted-runner',
          planFile,
        ],
        {
          cwd,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', stdout, stderr],
          timeout: 215000,
          killSignal: 'SIGKILL',
          env: runnerEnvironment(e, path.dirname(process.execPath), root, path),
        },
      );
    } finally {
      fs.closeSync(stdout);
      fs.closeSync(stderr);
    }
    if (child.error || child.signal || child.status !== 0)
      fail('RUNNER_UNPROVEN');
    const qualified = safeRunner(
      JSON.parse(
        (await read(path.join(root, 'runner.stdout'), 65536)).toString('utf8'),
      ),
      plan,
    );
    if (qualified.status !== 'PASS') fail('RUNNER_UNPROVEN');
    // Source and key tool pins are checked again after the child, before PASS.
    if (
      git('status', '--porcelain', '--untracked-files=no') !== '' ||
      digest(await read(process.execPath, 256 * 1024 * 1024)) !==
        actual.nodeSHA256 ||
      digest(
        await read(path.join(cwd, 'node_modules/@playwright/test/cli.js')),
      ) !== policy.cliSHA256
    )
      fail('SOURCE_UNPROVEN');
    for (const [file, hash] of Object.entries(manifest))
      if (digest(await read(path.join(cwd, file))) !== hash)
        fail('SOURCE_UNPROVEN');
    if (
      names(git('ls-files', '--others', '--exclude-standard')).some(
        (file) =>
          ![
            'api-music-runtime-manifest.json',
            'api-music-nonloopback-safe/result.json',
          ].includes(file),
      )
    )
      fail('SOURCE_UNPROVEN');
    mayRemove = true;
    await remove(root);
    result = {
      ...result,
      status: 'PASS',
      reason: 'MEASURED_PROTOCOLS_AND_OWNED_DIRECTORY_CLEANUP',
      qualification: qualified,
      completeCarrierManifestSHA256: digest(completeBytes),
      runnerCarrierManifestSHA256: digest(manifestBytes),
      dependencyPolicy: {
        pnpmVersion: policy.pnpmVersion,
        lockSHA256: policy.lockSHA256,
        cliSHA256: policy.cliSHA256,
        installScripts: false,
        pnpmfile: false,
        browserDownload: false,
        electronDownload: false,
      },
    };
  } catch {
    if (!mayRemove)
      await fsp
        .writeFile(path.join(root, 'reap-required'), '1', {
          flag: 'wx',
          mode: 0o600,
        })
        .catch(() => {});
    result.reason = mayRemove
      ? 'CARRIER_CLEANUP_UNPROVEN'
      : 'CARRIER_RUN_UNPROVEN';
    process.exitCode = 1;
  }
  await fsp.writeFile(
    path.join(safe, 'result.json'),
    JSON.stringify(result, null, 2),
    { flag: 'wx', mode: 0o600 },
  );
}
