'use strict';

// SOURCE ONLY until root separately admits a disposable runner, exact input/pins,
// dependency setup and execution. Importing this module reads no runtime state.
const TEST_FILE = 'tests/api-music-remote-http.test.ts';
const TEST_TITLE =
  'runtime-admitted nonloopback HTTP and TLS require actual direct peers';
const CERT_SHA256 =
  '597b4509e1ad0c12b69402bc0cff55bcb3f28603dea13a36623eb38891d109a3';
const LEAF_FINGERPRINT =
  'fb6e906aa7015cfe4194ac90bd771a3b4f4d2eecef8ba4614b079a59138f35b1';
const CHECKPOINTS = Object.freeze([
  'actual_nonempty_socket_facts',
  'search100plus51_replay',
  'distinct_grants_default_disabled',
  'namespace_headers',
  'accepted_receipt_exact_replay',
  'terminal_owner_cursor_receipt',
  'two_client_logical_cancel_physical_hold',
  'bounded_cleanup',
]);
const ENVIRONMENTS = Object.freeze({
  linux: 'Linux',
  darwin: 'macOS',
  win32: 'Windows',
});
const MAX_OUTPUT = 2 * 1024 * 1024; // Combined stdout/stderr, including JSON report.
const WALL_MS = 145_000; // Plus 3s TERM and 2s KILL close grace: child bound 150s.
const TERM_MS = 3_000;
const KILL_MS = 2_000;
const fail = (code) => {
  throw Error(code);
};
const plain = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) =>
  plain(value) &&
  Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const sha = (value) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function selectAssignedIPv4(interfaces) {
  if (!plain(interfaces) || Object.keys(interfaces).length > 256)
    fail('TOPOLOGY_UNAVAILABLE');
  const candidates = new Set();
  let rows = 0;
  for (const entries of Object.values(interfaces)) {
    if (!Array.isArray(entries)) continue;
    for (const row of entries) {
      if (++rows > 1024) fail('TOPOLOGY_UNAVAILABLE');
      if (
        !plain(row) ||
        row.internal !== false ||
        !['IPv4', 4].includes(row.family)
      )
        continue;
      if (
        typeof row.address !== 'string' ||
        !/^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/.test(row.address)
      )
        continue;
      const octets = row.address.split('.').map(Number);
      if (
        octets.some((n) => n > 255) ||
        octets[0] === 0 ||
        octets[0] === 127 ||
        octets[0] >= 224 ||
        (octets[0] === 169 && octets[1] === 254)
      )
        continue;
      candidates.add(row.address);
    }
  }
  const selected = [...candidates].sort((a, b) => {
    const left = a.split('.').map(Number),
      right = b.split('.').map(Number);
    for (let i = 0; i < 4; i++)
      if (left[i] !== right[i]) return left[i] - right[i];
    return 0;
  })[0];
  if (!selected) fail('TOPOLOGY_UNAVAILABLE');
  return selected;
}

function validatePlan(plan) {
  const keys = [
    'schema',
    'disposableRunner',
    'platform',
    'arch',
    'image',
    'repository',
    'runId',
    'attempt',
    'jobId',
    'expectedHead',
    'expectedTree',
    'sourceManifestSHA256',
    'node',
    'cliSHA256',
    'lockSHA256',
  ];
  if (
    !exactKeys(plan, keys) ||
    plan.schema !== 1 ||
    plan.disposableRunner !== true ||
    !Object.hasOwn(ENVIRONMENTS, plan.platform) ||
    !['x64', 'arm64'].includes(plan.arch)
  )
    fail('INVALID_PLAN');
  if (
    typeof plan.image !== 'string' ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(plan.image) ||
    !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/.test(
      plan.repository,
    )
  )
    fail('INVALID_PLAN');
  for (const field of ['runId', 'attempt', 'jobId'])
    if (
      typeof plan[field] !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(plan[field])
    )
      fail('INVALID_PLAN');
  for (const field of ['expectedHead', 'expectedTree'])
    if (typeof plan[field] !== 'string' || !/^[a-f0-9]{40}$/.test(plan[field]))
      fail('INVALID_PLAN');
  for (const field of ['sourceManifestSHA256', 'cliSHA256', 'lockSHA256'])
    if (!sha(plan[field])) fail('INVALID_PLAN');
  if (
    !exactKeys(plan.node, ['path', 'version', 'sha256']) ||
    typeof plan.node.path !== 'string' ||
    plan.node.path.length > 1024 ||
    /[\x00-\x1f]/.test(plan.node.path) ||
    !/^(\/|[A-Za-z]:[\\/])/.test(plan.node.path) ||
    !/^v24\.[0-9]+\.[0-9]+$/.test(plan.node.version) ||
    !sha(plan.node.sha256)
  )
    fail('INVALID_PLAN');
}

function parseProtocolTelemetry(value, protocol) {
  const integer = (v, min, max) =>
    Number.isSafeInteger(v) && v >= min && v <= max;
  const group = (v, keys) => {
    if (!exactKeys(v, keys)) fail('INVALID_REPORT');
  };
  group(value, [
    'version',
    'endpoint',
    'tls',
    'pages',
    'ownership',
    'counts',
    'cleanup',
  ]);
  if (value.version !== 1) fail('INVALID_REPORT');
  const {
    endpoint: e,
    tls: t,
    pages: p,
    ownership: o,
    counts: c,
    cleanup: k,
  } = value;
  group(e, [
    'label',
    'family',
    'observations',
    'port',
    'nonloopback',
    'peerMatchesAdmission',
    'localMatchesAdmission',
    'owned',
    'epochs',
  ]);
  if (
    e.label !== 'owned-v4' ||
    e.family !== 4 ||
    !integer(e.observations, 1, 256) ||
    !integer(e.port, 1, 65535) ||
    [
      e.nonloopback,
      e.peerMatchesAdmission,
      e.localMatchesAdmission,
      e.owned,
    ].some((v) => v !== true) ||
    !Array.isArray(e.epochs) ||
    e.epochs.length !== 4
  )
    fail('INVALID_REPORT');
  const labels = ['disabled', 'A', 'B', 'configured'];
  let observed = 0;
  for (let i = 0; i < labels.length; i++) {
    const epoch = e.epochs[i];
    group(epoch, ['label', 'observations']);
    if (epoch.label !== labels[i] || !integer(epoch.observations, 1, 256))
      fail('INVALID_REPORT');
    observed += epoch.observations;
  }
  if (observed !== e.observations) fail('INVALID_REPORT');
  group(t, [
    'encrypted',
    'versions',
    'verifiedResponses',
    'peerLeafFingerprint256',
  ]);
  if (
    !Array.isArray(t.versions) ||
    !integer(t.verifiedResponses, 0, e.observations)
  )
    fail('INVALID_REPORT');
  if (protocol === 'HTTP') {
    if (
      t.encrypted !== false ||
      t.versions.length ||
      t.verifiedResponses !== 0 ||
      t.peerLeafFingerprint256 !== null
    )
      fail('INVALID_REPORT');
  } else if (
    protocol !== 'TLS' ||
    t.encrypted !== true ||
    t.versions.length < 1 ||
    t.versions.length > 2 ||
    new Set(t.versions).size !== t.versions.length ||
    t.versions.some((v) => !['TLSv1.2', 'TLSv1.3'].includes(v)) ||
    t.verifiedResponses < 1 ||
    t.peerLeafFingerprint256 !== LEAF_FINGERPRINT
  )
    fail('INVALID_REPORT');
  group(p, [
    'firstItems',
    'secondItems',
    'nativeFetchesForPaging',
    'replayNativeDelta',
  ]);
  if (
    p.firstItems !== 100 ||
    p.secondItems !== 51 ||
    p.nativeFetchesForPaging !== 1 ||
    p.replayNativeDelta !== 0
  )
    fail('INVALID_REPORT');
  group(o, ['retiredA', 'distinctAB', 'oldCursorStatus', 'oldReceiptStatus']);
  if (
    o.retiredA !== true ||
    o.distinctAB !== true ||
    o.oldCursorStatus !== 404 ||
    o.oldReceiptStatus !== 409
  )
    fail('INVALID_REPORT');
  group(c, [
    'requests',
    'nativeReadPackets',
    'controlsAfterAccepted',
    'controlsAfterReplay',
    'controlsFinal',
    'cancelPackets',
    'holdsBeforeLoss',
    'holdsAfterLoss',
    'holdsAfterSettlement',
  ]);
  if (
    c.requests !== e.observations ||
    !integer(c.nativeReadPackets, 5, 128) ||
    c.nativeReadPackets > c.requests ||
    c.controlsAfterAccepted !== 1 ||
    c.controlsAfterReplay !== 1 ||
    c.controlsFinal !== 2 ||
    c.cancelPackets !== 1 ||
    c.holdsBeforeLoss !== 2 ||
    c.holdsAfterLoss !== 2 ||
    c.holdsAfterSettlement !== 0
  )
    fail('INVALID_REPORT');
  group(k, [
    'serverListening',
    'brokerDispatched',
    'brokerQueued',
    'openRequestClients',
    'openServerSockets',
    'held',
    'ownedStoreRemoval',
  ]);
  if (
    k.serverListening !== false ||
    [
      k.brokerDispatched,
      k.brokerQueued,
      k.openRequestClients,
      k.openServerSockets,
      k.held,
    ].some((v) => v !== 0) ||
    k.ownedStoreRemoval !== 'completed'
  )
    fail('INVALID_REPORT');
  return JSON.parse(JSON.stringify(value));
}

function parseEvidence(report) {
  try {
    if (
      !plain(report) ||
      !Array.isArray(report.errors) ||
      report.errors.length ||
      !plain(report.stats) ||
      report.stats.expected !== 1 ||
      ['unexpected', 'flaky', 'skipped'].some((key) => report.stats[key] !== 0)
    )
      fail('INVALID_REPORT');
    const specs = [];
    let count = 0;
    function walk(suites, depth = 0) {
      if (!Array.isArray(suites) || depth > 8) fail('INVALID_REPORT');
      for (const suite of suites) {
        if (++count > 64 || !plain(suite)) fail('INVALID_REPORT');
        if (suite.specs) {
          if (!Array.isArray(suite.specs)) fail('INVALID_REPORT');
          specs.push(...suite.specs);
        }
        if (suite.suites) walk(suite.suites, depth + 1);
      }
    }
    walk(report.suites);
    if (specs.length !== 1) fail('INVALID_REPORT');
    const spec = specs[0];
    if (
      spec.file !== TEST_FILE ||
      spec.title !== TEST_TITLE ||
      spec.ok !== true ||
      !Array.isArray(spec.tests) ||
      spec.tests.length !== 1
    )
      fail('INVALID_REPORT');
    const test = spec.tests[0];
    if (
      test.expectedStatus !== 'passed' ||
      test.status !== 'expected' ||
      !Array.isArray(test.results) ||
      test.results.length !== 1
    )
      fail('INVALID_REPORT');
    const result = test.results[0];
    if (
      result.status !== 'passed' ||
      result.retry !== 0 ||
      result.workerIndex !== 0 ||
      result.error ||
      result.errors?.length ||
      !Array.isArray(result.attachments) ||
      result.attachments.length !== 2
    )
      fail('INVALID_REPORT');
    return ['HTTP', 'TLS'].map((protocol) => {
      const attachments = result.attachments.filter(
        (a) => a.name === `runtime-${protocol}-checkpoints`,
      );
      if (attachments.length !== 1) fail('INVALID_REPORT');
      const attachment = attachments[0];
      if (
        attachment.contentType !== 'application/json' ||
        attachment.path !== undefined ||
        typeof attachment.body !== 'string' ||
        attachment.body.length > 5464 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          attachment.body,
        )
      )
        fail('INVALID_REPORT');
      const body = JSON.parse(
        Buffer.from(attachment.body, 'base64').toString('utf8'),
      );
      if (Buffer.from(attachment.body, 'base64').length > 4096)
        fail('INVALID_REPORT');
      if (
        !exactKeys(body, ['protocol', 'checkpoints', 'outcome', 'telemetry']) ||
        body.protocol !== protocol ||
        body.outcome !== 'PASS' ||
        !Array.isArray(body.checkpoints) ||
        body.checkpoints.length !== CHECKPOINTS.length ||
        !CHECKPOINTS.every(
          (checkpoint, index) => body.checkpoints[index] === checkpoint,
        )
      )
        fail('INVALID_REPORT');
      return {
        protocol,
        checkpoints: [...CHECKPOINTS],
        outcome: 'PASS',
        telemetry: parseProtocolTelemetry(body.telemetry, protocol),
      };
    });
  } catch {
    fail('INVALID_REPORT');
  }
}

function evidenceBase(plan) {
  // Only validated, bounded nonsecret provenance. HEAD/tree are root expectations;
  // the separate immutable manifest verifies on-disk bytes without a git child.
  return {
    schema: 1,
    status: 'UNPROVEN',
    reason: 'NOT_RUN',
    protocols: [],
    platform: plan.platform,
    arch: plan.arch,
    image: plan.image,
    expectedHead: plan.expectedHead,
    expectedTree: plan.expectedTree,
    sourceManifestSHA256: plan.sourceManifestSHA256,
    nodeVersion: plan.node.version,
    nodeSHA256: plan.node.sha256,
    cliSHA256: plan.cliSHA256,
    lockSHA256: plan.lockSHA256,
    certSHA256: CERT_SHA256,
    runURL: `https://github.com/${plan.repository}/actions/runs/${plan.runId}/attempts/${plan.attempt}`,
    jobId: plan.jobId,
    endpointLabel: 'runner-owned-v4',
  };
}

async function runQualification(plan, deps) {
  try {
    validatePlan(plan);
  } catch {
    return {
      schema: 1,
      status: 'UNPROVEN',
      reason: 'INVALID_PLAN',
      protocols: [],
    };
  }
  const evidence = evidenceBase(plan);
  let directory, child;
  let stage = 'PIN_MISMATCH';
  const checkCancellation = () => {
    if (deps.isCancelled?.()) {
      stage = 'CANCELLED';
      fail('CANCELLED');
    }
  };
  try {
    checkCancellation();
    await deps.verifyPins(plan);
    checkCancellation();
    stage = 'TOPOLOGY_UNAVAILABLE';
    // Exactly one runner inventory read. No fallback probes, DNS or other peers.
    const address = selectAssignedIPv4(deps.readInterfaces());
    checkCancellation();
    stage =
      plan.platform === 'win32'
        ? 'WINDOWS_PRIVATE_TEMP_UNPROVEN'
        : 'PRIVATE_TEMP_FAILED';
    directory = await deps.createPrivateTemp();
    checkCancellation();
    stage = 'ADMISSION_WRITE_FAILED';
    await deps.writeAdmission(directory, {
      environment: ENVIRONMENTS[plan.platform],
      bindAddress: address,
      clientAddress: address,
      certSHA256: CERT_SHA256,
    });
    checkCancellation();
    stage = 'CHILD_FAILED';
    child = await deps.execute({
      command: plan.node.path,
      args: [
        'node_modules/@playwright/test/cli.js',
        'test',
        TEST_FILE,
        '--grep',
        `(?:^| )${TEST_TITLE}$`,
        '--workers=1',
        '--retries=0',
        '--reporter=json',
        '--timeout=120000',
        '--global-timeout=120000',
        `--output=${directory}/playwright`,
      ],
      directory,
    });
    checkCancellation();
    if (!child.closed) {
      stage = 'CHILD_NO_CLOSE';
      fail('CHILD_FAILED');
    }
    if (
      child.reason &&
      [
        'TIMEOUT',
        'OUTPUT_LIMIT',
        'CANCELLED',
        'SPAWN_FAILED',
        'LOG_FAILED',
      ].includes(child.reason)
    )
      stage = 'CHILD_' + child.reason;
    if (child.code !== 0 || child.signal || child.reason) fail('CHILD_FAILED');
    stage = 'INVALID_REPORT';
    if (
      typeof child.stdout !== 'string' ||
      Buffer.byteLength(child.stdout) > MAX_OUTPUT
    )
      fail('INVALID_REPORT');
    evidence.protocols = parseEvidence(JSON.parse(child.stdout));
    evidence.status = 'PASS';
    evidence.reason = 'CHECKPOINTS_COMPLETE';
  } catch (error) {
    // Only this fixed internal cleanup result may refine the stage. Never emit
    // filesystem error text, paths or diagnostics from an initialization fault.
    evidence.reason =
      ['PRIVATE_TEMP_FAILED', 'WINDOWS_PRIVATE_TEMP_UNPROVEN'].includes(
        stage,
      ) && error?.message === 'CLEANUP_FAILED'
        ? 'CLEANUP_FAILED'
        : stage;
    if (
      stage === 'WINDOWS_PRIVATE_TEMP_UNPROVEN' &&
      error?.code === 'WINDOWS_HELPER_NO_CLOSE'
    ) {
      evidence.reason = 'WINDOWS_HELPER_NO_CLOSE';
      evidence.cleanup = 'UNPROVEN';
      evidence.outerReapRequired = true;
    }
  } finally {
    if (directory) {
      try {
        await deps.removeTemp(directory);
      } catch {
        evidence.status = 'UNPROVEN';
        evidence.reason = 'CLEANUP_FAILED';
      }
    }
  }
  if (deps.isCancelled?.() && evidence.reason !== 'CLEANUP_FAILED') {
    evidence.status = 'UNPROVEN';
    evidence.reason = 'CANCELLED';
  }
  if (evidence.status !== 'PASS') evidence.protocols = [];
  return evidence;
}

// This adapter is also tested entirely with fake fs/clock/child/signal inputs.
// A no-close/abnormal result never qualifies cleanup of a CLI's descendants;
// the disposable job remains responsible for its final process/container reap.
function runOwnedChild(spec, io) {
  return new Promise((resolve) => {
    let child,
      done = false,
      reason = null,
      bytes = 0;
    const output = [];
    const fds = [],
      timers = new Set(),
      handlers = new Map();
    const later = (fn, ms) => {
      const id = io.setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
      return id;
    };
    const finish = (closed, code = null, signal = null) => {
      if (done) return;
      done = true;
      for (const id of timers) io.clearTimeout(id);
      timers.clear();
      for (const [signalName, handler] of handlers)
        io.signalSource.removeListener(signalName, handler);
      for (const fd of fds) {
        try {
          io.fs.closeSync(fd);
        } catch {
          reason = 'LOG_FAILED';
        }
      }
      if (!closed) {
        child?.stdout?.destroy?.();
        child?.stderr?.destroy?.();
        child?.unref?.();
      }
      resolve({
        closed,
        code,
        signal,
        reason,
        stdout: Buffer.concat(output).toString('utf8'),
      });
    };
    const terminate = (why) => {
      if (done || reason) return;
      reason = why;
      for (const id of timers) io.clearTimeout(id);
      timers.clear();
      try {
        child?.kill('SIGTERM');
      } catch {
        /* Still bound the close wait. */
      }
      later(() => {
        if (done) return;
        try {
          child?.kill('SIGKILL');
        } catch {
          /* No cleanup claim without close. */
        }
        later(() => finish(false), KILL_MS);
      }, TERM_MS);
    };
    try {
      fds.push(io.fs.openSync(`${spec.directory}/stdout.raw`, 'wx', 0o600));
      fds.push(io.fs.openSync(`${spec.directory}/stderr.raw`, 'wx', 0o600));
      child = io.spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      reason = 'SPAWN_FAILED';
      finish(true);
      return;
    }
    const consume = (index, chunk) => {
      if (done || reason) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes + buffer.length > MAX_OUTPUT) {
        terminate('OUTPUT_LIMIT');
        return;
      }
      bytes += buffer.length;
      try {
        io.fs.writeSync(fds[index], buffer);
      } catch {
        terminate('LOG_FAILED');
        return;
      }
      if (index === 0) output.push(buffer);
    };
    child.stdout.on('data', (chunk) => consume(0, chunk));
    child.stderr.on('data', (chunk) => consume(1, chunk));
    child.stdout.on('error', () => terminate('LOG_FAILED'));
    child.stderr.on('error', () => terminate('LOG_FAILED'));
    child.once('error', () => terminate('SPAWN_FAILED'));
    child.once('close', (code, signal) => finish(true, code, signal));
    for (const signalName of ['SIGINT', 'SIGTERM']) {
      const handler = () => terminate('CANCELLED');
      handlers.set(signalName, handler);
      io.signalSource.on(signalName, handler);
    }
    later(() => terminate('TIMEOUT'), WALL_MS);
  });
}

async function verifyRuntimePins(plan, io) {
  const { path, cwd, readBounded, digest, realpath } = io;
  if (
    io.version !== plan.node.version ||
    io.platform !== plan.platform ||
    io.arch !== plan.arch ||
    (await realpath(io.execPath)) !== (await realpath(plan.node.path)) ||
    digest(await readBounded(plan.node.path, 256 * 1024 * 1024)) !==
      plan.node.sha256
  )
    fail('PIN_MISMATCH');
  const manifestBytes = await readBounded(
    path.join(cwd, 'api-music-runtime-manifest.json'),
  );
  if (digest(manifestBytes) !== plan.sourceManifestSHA256) fail('PIN_MISMATCH');
  const manifest = JSON.parse(manifestBytes);
  if (
    !plain(manifest) ||
    Object.keys(manifest).length < 7 ||
    Object.keys(manifest).length > 10_000
  )
    fail('PIN_MISMATCH');
  for (const [file, expected] of Object.entries(manifest)) {
    if (
      !/^[A-Za-z0-9_.@/-]+$/.test(file) ||
      path.isAbsolute(file) ||
      file.split('/').some((part) => !part || part === '..' || part === '.') ||
      !sha(expected)
    )
      fail('PIN_MISMATCH');
    const target = path.join(cwd, file);
    if (
      (await realpath(target)) !== target ||
      digest(await readBounded(target, 16 * 1024 * 1024)) !== expected
    )
      fail('PIN_MISMATCH');
  }
  for (const file of [
    TEST_FILE,
    'tests/helpers/api-music-remote-http.ts',
    'scripts/qualify-api-music-nonloopback.cjs',
    'scripts/api-music-windows-private-root.cjs',
    'pnpm-lock.yaml',
    'tests/fixtures/api-music-http-tls/cert.pem',
    'tests/fixtures/api-music-http-tls/key.pem',
  ])
    if (!Object.hasOwn(manifest, file)) fail('PIN_MISMATCH');
  if (
    digest(await readBounded(path.join(cwd, 'pnpm-lock.yaml'))) !==
      plan.lockSHA256 ||
    digest(
      await readBounded(path.join(cwd, 'node_modules/@playwright/test/cli.js')),
    ) !== plan.cliSHA256 ||
    digest(
      await readBounded(
        path.join(cwd, 'tests/fixtures/api-music-http-tls/cert.pem'),
      ),
    ) !== CERT_SHA256
  )
    fail('PIN_MISMATCH');
  const cliPackage = JSON.parse(
    await readBounded(
      path.join(cwd, 'node_modules/@playwright/test/package.json'),
    ),
  );
  if (cliPackage.version !== '1.61.1') fail('PIN_MISMATCH');
}

async function createPrivateTempDirectory(io) {
  const { fsp, path, runnerTemp, platform } = io;
  // chmod does not attest Windows DACLs. Only the admitted main selects the
  // fixed internal callback; direct users without it remain failed closed.
  // The callback verifies exactly its newly created owned root before return.
  if (
    platform === 'win32' &&
    typeof io.makeWindowsPrivateDirectory !== 'function'
  )
    fail('WINDOWS_PRIVATE_TEMP_UNPROVEN');
  const directory =
    platform === 'win32'
      ? await io.makeWindowsPrivateDirectory(runnerTemp)
      : await fsp.mkdtemp(path.join(runnerTemp, 'pear-music-nonloopback-'));
  if (
    typeof directory !== 'string' ||
    !path.isAbsolute(directory) ||
    path.dirname(directory) !== path.resolve(runnerTemp) ||
    !path.basename(directory).startsWith('pear-music-nonloopback-')
  )
    fail('PRIVATE_TEMP_FAILED');
  try {
    if (platform !== 'win32') await fsp.chmod(directory, 0o700);
    await fsp.mkdir(path.join(directory, 'tmp'), { mode: 0o700 });
    return directory;
  } catch {
    await removeOwnedTemp(directory, {
      remove: (owned) =>
        fsp.rm(owned, {
          recursive: true,
          force: true,
          maxRetries: 2,
          retryDelay: 100,
        }),
      setTimeout: io.setTimeout,
      clearTimeout: io.clearTimeout,
    });
    fail('PRIVATE_TEMP_FAILED');
  }
}

async function removeOwnedTemp(directory, io) {
  let timer;
  try {
    await Promise.race([
      io.remove(directory),
      new Promise((_, reject) => {
        timer = io.setTimeout(() => reject(Error('CLEANUP_FAILED')), 5000);
      }),
    ]);
  } finally {
    io.clearTimeout(timer);
  }
}

module.exports = {
  selectAssignedIPv4,
  validatePlan,
  parseEvidence,
  runQualification,
  runOwnedChild,
  verifyRuntimePins,
  createPrivateTempDirectory,
  removeOwnedTemp,
};

// Deliberate executable entry point. No action, including builtin imports, occurs
// at source import. Future root execution is distinct from source fake tests.
if (typeof require !== 'undefined' && require.main === module) {
  main().then(
    (evidence) => {
      process.stdout.write(JSON.stringify(evidence) + '\n');
      process.exitCode = evidence.status === 'PASS' ? 0 : 1;
    },
    () => {
      process.stdout.write(
        '{"schema":1,"status":"UNPROVEN","reason":"BOOTSTRAP_FAILED","protocols":[]}\n',
      );
      process.exitCode = 1;
    },
  );
}

async function main() {
  // Root must create a reviewed plan and immutable file manifest, not pass a
  // command, address, environment override, install action or output path.
  if (
    process.argv.length !== 4 ||
    process.argv[2] !== '--execute-admitted-runner' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
  )
    fail('RUNNER_NOT_ADMITTED');
  const fs = require('node:fs');
  const fsp = fs.promises;
  const path = require('node:path');
  const crypto = require('node:crypto');
  const os = require('node:os');
  const childProcess = require('node:child_process');
  const cwd = path.resolve(__dirname, '..');
  const digest = (buffer) =>
    crypto.createHash('sha256').update(buffer).digest('hex');
  const readBounded = async (file, max = 2 * 1024 * 1024) => {
    const handle = await fsp.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > max) fail('PIN_MISMATCH');
      const buffer = await handle.readFile();
      if (buffer.length > max) fail('PIN_MISMATCH');
      return buffer;
    } finally {
      await handle.close();
    }
  };
  const plan = JSON.parse(await readBounded(process.argv[3], 16 * 1024));
  validatePlan(plan);
  const runnerTemp = process.env.RUNNER_TEMP;
  const systemRoot = process.env.SystemRoot;
  if (
    !runnerTemp ||
    !path.isAbsolute(runnerTemp) ||
    process.platform !== plan.platform ||
    process.arch !== plan.arch ||
    process.env.GITHUB_REPOSITORY !== plan.repository ||
    process.env.GITHUB_RUN_ID !== plan.runId ||
    process.env.GITHUB_RUN_ATTEMPT !== plan.attempt ||
    process.env.ImageVersion !== plan.image
  )
    fail('RUNNER_NOT_ADMITTED');
  const deps = {
    verifyPins: () =>
      verifyRuntimePins(plan, {
        path,
        cwd,
        readBounded,
        digest,
        realpath: (file) => fsp.realpath(file),
        version: process.version,
        platform: process.platform,
        arch: process.arch,
        execPath: process.execPath,
      }),
    readInterfaces: () => os.networkInterfaces(),
    createPrivateTemp: () =>
      createPrivateTempDirectory({
        fsp,
        path,
        runnerTemp,
        platform: process.platform,
        setTimeout,
        clearTimeout,
        makeWindowsPrivateDirectory:
          process.platform === 'win32'
            ? (parent) => {
                // Lazy, fixed source import after pin/topology checks. No command or
                // executable program comes from the plan, environment or caller.
                const {
                  createWindowsPrivateDirectory,
                } = require('./api-music-windows-private-root.cjs');
                return createWindowsPrivateDirectory(parent, {
                  fsp,
                  path,
                  systemRoot,
                  spawn: childProcess.spawn,
                  env: { PATH: path.dirname(plan.node.path) },
                  setTimeout,
                  clearTimeout,
                  signalSource: process,
                  removeOwnedTemp,
                  isCancelled: () => deps.isCancelled?.() === true,
                });
              }
            : undefined,
      }),
    writeAdmission: (directory, input) =>
      fsp.writeFile(
        path.join(directory, 'admission.json'),
        JSON.stringify(input),
        { flag: 'wx', mode: 0o600 },
      ),
    execute: (spec) => {
      // Do not inherit credentials, NODE_OPTIONS, report redirection or TLS trust
      // overrides. The public fixture CA/servername remains the sole TLS input.
      const env = {
        CI: '1',
        PATH: path.dirname(plan.node.path),
        TMPDIR: path.join(spec.directory, 'tmp'),
        TMP: path.join(spec.directory, 'tmp'),
        TEMP: path.join(spec.directory, 'tmp'),
        HOME: spec.directory,
        USERPROFILE: spec.directory,
        PEAR_MUSIC_RUNTIME_ADMISSION: path.join(
          spec.directory,
          'admission.json',
        ),
      };
      if (process.platform === 'win32') env.SystemRoot = systemRoot;
      return runOwnedChild(
        { ...spec, cwd, env },
        {
          spawn: childProcess.spawn,
          fs,
          setTimeout,
          clearTimeout,
          signalSource: process,
        },
      );
    },
    removeTemp: (directory) =>
      removeOwnedTemp(directory, {
        remove: (owned) =>
          fsp.rm(owned, {
            recursive: true,
            force: true,
            maxRetries: 2,
            retryDelay: 100,
          }),
        setTimeout,
        clearTimeout,
      }),
  };
  let cancelled = false;
  const markCancelled = () => {
    cancelled = true;
  };
  deps.isCancelled = () => cancelled;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, markCancelled);
  try {
    return await runQualification(plan, deps);
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.removeListener(signal, markCancelled);
  }
}
