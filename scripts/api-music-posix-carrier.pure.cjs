'use strict';
// Direct finite entry. No fs/process/network/worker calls; all carrier effects injected.
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const qualifier = require('./qualify-api-music-nonloopback.cjs');
const api = require('./api-music-posix-carrier.cjs');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const blob = (b) => crypto.createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex');
const H = 'a'.repeat(40), T = 'b'.repeat(40), C = 'c'.repeat(40), CT = 'd'.repeat(40);
const SVG = 'assets/generated/icons/mac/icon.icon/Assets/SVG Image.svg';
// Public test certificate only. Private-key fixtures below are synthetic data.
const certificate = Buffer.from(`-----BEGIN CERTIFICATE-----
MIIDDjCCAfagAwIBAgIJAKbywh/tCKsiMA0GCSqGSIb3DQEBCwUAMCUxIzAhBgNV
BAMMGm11c2ljLWh0dHAuZml4dHVyZS5pbnZhbGlkMB4XDTI2MTAxNTIyMTgzMFoX
DTM2MTAxMjIyMTgzMFowJTEjMCEGA1UEAwwabXVzaWMtaHR0cC5maXh0dXJlLmlu
dmFsaWQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDOev1UQytj9Krk
4IXqZH50xHF6YVUY2MeXNujbDUNp9mEg74X8mssIocAvZA8MHsUGsaGK9t8Y+aT6
+p+1p/E7plrpEe7SS3dK0plD7ov+Ps1iiPVjGiHQlqNaBOQu3KBe7ah6Fi+4pBjD
6/Ge5UUI8eLL366RS4vpQfb//kQGtkQ7nqynNmZ2f4ShexE8TE9Lwn3saCjMiaUh
I42xWdrsteqPXVU7Z5K4hKfwwrQhYbfqaodP5BdBNjeorjPzJTn1/C/ceM33ipe5
VR3ecEW6uWLwDS39t261a8XP1rh2u/YCPY32rKsdFv7uQ1a3Is05GvFcT5B+xBv5
/dkUzMKNAgMBAAGjQTA/MD0GA1UdEQQ2MDSCGm11c2ljLWh0dHAuZml4dHVyZS5p
bnZhbGlkhwR/AAABhxAAAAAAAAAAAAAAAAAAAAABMA0GCSqGSIb3DQEBCwUAA4IB
AQBNA2tGA4z9W2eKG5lfkfDxlGkY/bmRtsXmhks5dErGnP442SBIxfrVptbSuTm/
375hSrO1a87R6DGTTxd0UcXsy4ZapzsOb1tCwgEyoQ6kagGU7FhdeuTQzjGFnUx7
muccOXphM++ys7+3DpY7Elqcnp+F7PjtfU2Ff180wboCPm8tmW3PVz1qpih1OGT9
AOveGqUoZt6AFvlBriuHZcxTOJ3AHOvtCiW8vsk3HlF9ciAwCK/0H1s0bQjnHtT+
+leY3z3UwjALlUcrsJLzZP5txxgYo0aF9sLvfVpYmKi2RnJ5HL7EsN/337cbieyr
04jhQNRNHZZ2gdF2X9zhXfkt
-----END CERTIFICATE-----
`);
function fixture() {
  const files = new Map(), modes = new Map(), dirs = new Set(['/carrier', '/source', '/runner/temp']);
  const effects = [], calls = [], timers = [];
  const put = (p, b, mode = 0o644) => { files.set(p, Buffer.isBuffer(b) ? b : Buffer.from(b)); modes.set(p, mode); };
  const sourceNames = [SVG, 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'scripts/qualify-api-music-nonloopback.cjs', 'scripts/api-music-windows-private-root.cjs',
    'tests/api-music-remote-http.test.ts', 'tests/helpers/api-music-remote-http.ts',
    'tests/fixtures/api-music-http-tls/cert.pem', 'tests/fixtures/api-music-http-tls/key.pem'];
  while (sourceNames.length < 947) sourceNames.push('src/fixture-' + sourceNames.length + '.ts');
  sourceNames.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const n of sourceNames) put('/source/' + n, n.endsWith('cert.pem') ? certificate : n);
  const entries = sourceNames.map((p) => ({path: p, mode: '100644', type: 'blob', blob: blob(files.get('/source/' + p))}));
  const sourceBytes = Buffer.from(JSON.stringify({head: H, tree: T, trackedCount: 947, entries}));
  const row = {platform: 'linux', arch: 'x64', runnerLabelCandidate: 'ubuntu-24.04', imageOS: 'ubuntu24', imageVersion: '20261028.1',
    nodeSHA256: hash(Buffer.from('node')), pnpmEntrySHA256: hash(Buffer.from('pnpm')), pnpmPackageClosureSHA256: hash(Buffer.from(JSON.stringify([
      ['pnpm/bin/pnpm.cjs', 'file', hash(Buffer.from('pnpm'))],
      ['pnpm/package.json', 'file', hash(Buffer.from('{"version":"11.28.6"}'))],
    ]))), cliSHA256: hash(Buffer.from('cli')), nodeVersion: 'v24.22.0', nodeCanonicalPathExpected: '/tools/node/bin/node', pnpmVersion: '11.28.6',
    pnpmCanonicalEntryPathExpected: '/tools/pnpm/bin/pnpm.cjs', playwrightVersion: '1.61.1'};
  const policy = {schema: 1, source: {head: H, tree: T, trackedCount: 947, runnerCount: 946, sourceInventorySHA256: hash(sourceBytes),
    lockSHA256: hash(files.get('/source/pnpm-lock.yaml')), packageSHA256: hash(files.get('/source/package.json')),
    certificateSHA256: '597b4509e1ad0c12b69402bc0cff55bcb3f28603dea13a36623eb38891d109a3',
    leafFingerprint256: 'fb6e906aa7015cfe4194ac90bd771a3b4f4d2eecef8ba4614b079a59138f35b1', staticOmission: SVG},
    platforms: [row, {...row, platform: 'darwin', arch: 'arm64', runnerLabelCandidate: 'macos-26', imageOS: 'macos26'}]};
  put('/carrier/scripts/api-music-posix-source.json', sourceBytes);
  put('/carrier/scripts/api-music-posix-policy.json', JSON.stringify(policy));
  put('/carrier/scripts/api-music-posix-carrier.cjs', 'helper'); put('/carrier/.github/workflows/tests.yml', 'workflow');
  put('/tools/node/bin/node', 'node'); put('/tools/pnpm/bin/pnpm.cjs', 'pnpm'); put('/tools/pnpm/package.json', '{"version":"11.28.6"}');
  dirs.add('/tools/pnpm'); dirs.add('/tools/pnpm/bin');
  const env = {GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'deruta74/pear-desktop',
    GITHUB_SHA: C, GITHUB_WORKFLOW_SHA: C, GITHUB_REF: 'refs/heads/qa/api-posix-carrier-source-oct28',
    GITHUB_WORKFLOW_REF: 'deruta74/pear-desktop/.github/workflows/tests.yml@refs/heads/qa/api-posix-carrier-source-oct28',
    GITHUB_RUN_ID: '71', GITHUB_RUN_ATTEMPT: '2', EXPECTED_CARRIER_SHA: C, EXPECTED_CARRIER_TREE: CT,
    EXPECTED_REF: 'refs/heads/qa/api-posix-carrier-source-oct28', EXPECTED_REGISTERED_WORKFLOW_ID: '42',
    EXPECTED_WORKFLOW_SHA256: hash(Buffer.from('workflow')), EXPECTED_HELPER_SHA256: hash(Buffer.from('helper')),
    EXPECTED_POLICY_SHA256: hash(files.get('/carrier/scripts/api-music-posix-policy.json')),
    PEAR_SOURCE_ROOT: '/source', RUNNER_TEMP: '/runner/temp', GITHUB_ENV: '/runner/env', ImageOS: row.imageOS, ImageVersion: row.imageVersion,
    PATH: '/untrusted', NODE_OPTIONS: '--import=private', NODE_TLS_REJECT_UNAUTHORIZED: '0', GH_TOKEN: 'private'};
  const runtime = {platform: 'linux', arch: 'x64', version: 'v24.22.0', execPath: '/tools/node/bin/node', uid: 501, cwd: '/carrier', sourceRoot: '/source'};
  let plan;
  const io = {path, hash, blob, runtime, qualifier, now: () => 0, signalSource: new EventEmitter(),
    read: async (p, max = Infinity) => { effects.push(['read', p]); if (!files.has(p)) throw Object.assign(Error('missing'), {code: 'ENOENT'}); const b = files.get(p); if (b.length > max) throw Error('FILE_UNPROVEN'); return b; },
    write: async (p, b, options = {}) => { effects.push(['write', p]); if (options.flag === 'wx' && files.has(p)) throw Error('EEXIST'); put(p, b, options.mode || 0o600); if (p.endsWith('/plan.json')) plan = JSON.parse(b); },
    openState: async (p) => ({read: () => io.read(p,1024*1024), write: (b) => io.write(p,b,{mode:0o600}), close: async () => {}}),
    append: async (p, text) => { if (p === '/runner/env') env.PEAR_POSIX_PRIVATE_ROOT = text.trim().split('=')[1]; },
    realpath: async (p) => p,
    stat: async (p) => { if (dirs.has(p)) return {kind: 'directory', mode: 0o700, uid: 501, size: 0}; if (!files.has(p)) throw Error('ENOENT'); return {kind: 'file', mode: modes.get(p), uid: 501, size: files.get(p).length}; },
    readdir: async (p) => [...new Set([...files.keys(), ...dirs].filter((n) => path.dirname(n) === p).map((n) => path.basename(n)))],
    mkdir: async (p) => { effects.push(['mkdir', p]); if (dirs.has(p)) throw Error('EEXIST'); dirs.add(p); },
    mkdtemp: async (prefix) => { const p = prefix + 'owned'; dirs.add(p); return p; }, chmod: async () => {},
    rm: async (p) => { effects.push(['rm', p]); for (const n of files.keys()) if (n.startsWith(p + '/')) files.delete(n); dirs.delete(p); },
    git: async (cwd, args) => {
      effects.push(['git', cwd, ...args]);
      if (args.join(' ') === 'rev-parse HEAD') return cwd === '/carrier' ? C : H;
      if (args.join(' ') === 'rev-parse HEAD^{tree}') return cwd === '/carrier' ? CT : T;
      if (args[0] === 'status') return '';
      if (args[0] === 'ls-tree') return entries.map((r) => `${r.mode} ${r.type} ${r.blob}\t${r.path}\0`).join('');
      throw Error('unexpected git');
    },
    api: async (route) => {
      effects.push(['api', route]);
      if (route.endsWith('/jobs?per_page=100')) return {total_count: 1, jobs: [{id: 91, run_id: 71, run_attempt: 2, head_sha: C, name: 'current-posix-api-linux', status: 'in_progress'}]};
      return {id: 71, run_attempt: 2, workflow_id: 42, head_sha: C, repository: {full_name: 'deruta74/pear-desktop'}};
    },
    setTimeout: (fn, ms) => { const t = {fn, ms, active: true}; timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.active = false; },
    spawn: (command, args, options) => {
      calls.push({command, args, options}); const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; child.unref = () => {};
      child.stdout.destroy = child.stderr.destroy = () => {};
      queueMicrotask(() => {
        if (args.includes('install')) {
          dirs.add('/source/node_modules'); dirs.add('/source/node_modules/@playwright'); dirs.add('/source/node_modules/@playwright/test');
          put('/source/node_modules/@playwright/test/cli.js', 'cli'); put('/source/node_modules/@playwright/test/package.json', '{"version":"1.61.1"}');
        } else child.stdout.emit('data', Buffer.from(JSON.stringify(evidence(plan))));
        child.emit('close', 0, null);
      }); return child;
    }};
  return {io, env, files, modes, dirs, effects, calls, timers, policy, row, put, entries,
    refreshPolicy: () => { put('/carrier/scripts/api-music-posix-policy.json', JSON.stringify(policy)); env.EXPECTED_POLICY_SHA256 = hash(files.get('/carrier/scripts/api-music-posix-policy.json')); }};
}
function evidence(p) {
  const checkpoints = ['actual_nonempty_socket_facts', 'search100plus51_replay', 'distinct_grants_default_disabled', 'namespace_headers', 'accepted_receipt_exact_replay', 'terminal_owner_cursor_receipt', 'two_client_logical_cancel_physical_hold', 'bounded_cleanup'];
  return {schema: 1, status: 'PASS', reason: 'CHECKPOINTS_COMPLETE', platform: p.platform, arch: p.arch, image: p.image, expectedHead: p.expectedHead, expectedTree: p.expectedTree,
    sourceManifestSHA256: p.sourceManifestSHA256, nodeVersion: p.node.version, nodeSHA256: p.node.sha256, cliSHA256: p.cliSHA256, lockSHA256: p.lockSHA256,
    certSHA256: '597b4509e1ad0c12b69402bc0cff55bcb3f28603dea13a36623eb38891d109a3', runURL: `https://github.com/${p.repository}/actions/runs/${p.runId}/attempts/${p.attempt}`, jobId: p.jobId, endpointLabel: 'runner-owned-v4',
    protocols: ['HTTP', 'TLS'].map((protocol) => ({protocol, outcome: 'PASS', checkpoints,
      telemetry: {version: 1, endpoint: {label: 'owned-v4', family: 4, observations: 8, port: 65535, nonloopback: true, peerMatchesAdmission: true, localMatchesAdmission: true, owned: true,
        epochs: ['disabled', 'A', 'B', 'configured'].map((label) => ({label, observations: 2}))},
        tls: {encrypted: protocol === 'TLS', versions: protocol === 'TLS' ? ['TLSv1.2', 'TLSv1.3'] : [], verifiedResponses: protocol === 'TLS' ? 8 : 0,
          peerLeafFingerprint256: protocol === 'TLS' ? 'fb6e906aa7015cfe4194ac90bd771a3b4f4d2eecef8ba4614b079a59138f35b1' : null},
        pages: {firstItems: 100, secondItems: 51, nativeFetchesForPaging: 1, replayNativeDelta: 0}, ownership: {retiredA: true, distinctAB: true, oldCursorStatus: 404, oldReceiptStatus: 409},
        counts: {requests: 8, nativeReadPackets: 8, controlsAfterAccepted: 1, controlsAfterReplay: 1, controlsFinal: 2, cancelPackets: 1, holdsBeforeLoss: 2, holdsAfterLoss: 2, holdsAfterSettlement: 0},
        cleanup: {serverListening: false, brokerDispatched: 0, brokerQueued: 0, openRequestClients: 0, openServerSockets: 0, held: 0, ownedStoreRemoval: 'completed'}}}))};
}
async function through(f, last = 'qualify') {
  for (const c of ['bind-source', 'prepare', 'install', 'qualify', 'cleanup']) { await api.handle(c, f.io, f.env); if (c === last) break; }
}
const failure = (fn, code) => assert.rejects(fn, (e) => e.message === code);
test('all five actual handlers bind separate source, install once, qualify once and finalize after removal', async () => {
  const f = fixture(); await through(f, 'cleanup'); const result = JSON.parse(f.files.get('/carrier/api-music-posix-safe/result.json'));
  assert.equal(result.status, 'PASS'); assert.equal(result.adoptableCells, 2); assert.equal(result.source.completeCount, 947); assert.equal(result.source.runnerCount, 946);
  assert.equal(result.processAbsence, 'UNPROVEN'); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].command, '/tools/node/bin/node'); assert.ok(f.calls[0].args.includes('--frozen-lockfile')); assert.ok(f.calls[0].args.includes('--ignore-scripts'));
  assert.ok(f.calls[1].args.includes('/source/scripts/qualify-api-music-nonloopback.cjs'));
  assert.equal(f.calls[0].options.env.GH_TOKEN, undefined); assert.equal(f.calls[0].options.env.NODE_OPTIONS, undefined); assert.equal(f.calls[0].options.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(f.calls[0].options.env.HOME, '/runner/temp/pear-api-posix-owned/home');
  assert.equal(f.calls[0].options.shell, false); assert.equal(result.cleanup.furtherOuterDeletion, 'COMPLETED');
  assert.ok(f.effects.findIndex((r) => r[0] === 'rm') < f.effects.findIndex((r) => r[1] === '/carrier/api-music-posix-safe/result.json'));
  assert.equal(JSON.stringify(result).includes('/runner'), false); assert.equal(JSON.stringify(result).includes('private'), false);
});
test('unsupported OS or arch rejects before every injected effect', async () => {
  const f = fixture(); f.io.runtime.platform = 'win32'; await failure(() => api.handle('prepare', f.io, f.env), 'HOST_UNPROVEN'); assert.equal(f.effects.length, 0);
  f.io.runtime.platform = 'linux'; f.io.runtime.arch = 'arm64'; await failure(() => api.handle('prepare', f.io, f.env), 'HOST_UNPROVEN'); assert.equal(f.effects.length, 0);
});
test('unknown static pin and changed external carrier seal reject before installation', async () => {
  const f = fixture(); f.policy.platforms[1].nodeSHA256 = null; f.refreshPolicy(); await failure(() => api.handle('install', f.io, f.env), 'ADMISSION_UNPROVEN'); assert.equal(f.calls.length, 0);
  const g = fixture(); g.env.EXPECTED_CARRIER_TREE = H; await failure(() => api.handle('install', g.io, g.env), 'SOURCE_UNPROVEN'); assert.equal(g.calls.length, 0);
});
test('actual source byte, mode, complete count and second parser omission drift reject', async () => {
  for (const kind of ['bytes', 'mode', 'count', 'space']) {
    const f = fixture();
    if (kind === 'bytes') f.put('/source/src/fixture-10.ts', 'changed');
    if (kind === 'mode') f.modes.set('/source/src/fixture-10.ts', 0o755);
    if (kind === 'count') f.entries.pop();
    if (kind === 'space') f.entries[0].path = 'second space.svg';
    await failure(() => api.handle('bind-source', f.io, f.env), 'SOURCE_UNPROVEN'); assert.equal(f.calls.length, 0);
  }
});
test('pnpm closure and canonical tool path drift block the fixed installer', async () => {
  const f = fixture(); await through(f, 'prepare'); f.put('/tools/pnpm/bin/pnpm.cjs', 'changed'); await failure(() => api.handle('install', f.io, f.env), 'DEPENDENCY_UNPROVEN'); assert.equal(f.calls.length, 0);
  const g = fixture(); await through(g, 'prepare'); g.io.realpath = async (p) => p === '/tools/node/bin/node' ? '/foreign/node' : p; await failure(() => api.handle('install', g.io, g.env), 'ADMISSION_UNPROVEN'); assert.equal(g.calls.length, 0);
});
test('duplicate/foreign/paginated/missing allocated API job facts reject before qualifier spawn', async () => {
  for (const kind of ['duplicate', 'foreign', 'page', 'missing']) {
    const f = fixture(); await through(f, 'install'); const get = f.io.api;
    f.io.api = async (route) => { const v = await get(route); if (v.jobs) { if (kind === 'duplicate') { v.jobs.push({...v.jobs[0]}); v.total_count++; } if (kind === 'page') v.total_count = 101; if (kind === 'missing') v.jobs[0].id = 0; } else if (kind === 'foreign') v.run_attempt = 1; return v; };
    await failure(() => api.handle('qualify', f.io, f.env), 'ADMISSION_UNPROVEN'); assert.equal(f.calls.length, 1);
  }
});
test('nonzero and strict protocol/report failure cannot publish PASS', async () => {
  for (const kind of ['nonzero', 'protocol']) {
    const f = fixture(); await through(f, 'install'); const spawn = f.io.spawn;
    f.io.spawn = (...args) => { const c = spawn(...args); const emit = c.emit.bind(c); c.emit = (name, ...v) => emit(name, ...(name === 'close' && kind === 'nonzero' ? [1, null] : v));
      if (kind === 'protocol') c.stdout.on('data', () => {}); // Replace returned byte at the real output boundary.
      const data = c.stdout.emit.bind(c.stdout); c.stdout.emit = (name, b) => { if (name === 'data' && kind === 'protocol') { const v = JSON.parse(b); v.protocols[1].telemetry.cleanup.held = 1; return data(name, Buffer.from(JSON.stringify(v))); } return data(name, b); }; return c; };
    await failure(() => api.handle('qualify', f.io, f.env), kind === 'nonzero' ? 'RUNNER_UNPROVEN' : 'RUNNER_EVIDENCE_REJECTED');
    await api.handle('cleanup', f.io, f.env); const result = JSON.parse(f.files.get('/carrier/api-music-posix-safe/result.json')); assert.equal(result.status, 'UNPROVEN'); assert.equal(result.adoptableCells, 0);
  }
});
test('outer no-close preserves inherited inner effects as unknown and withholds further root deletion', async () => {
  const f = fixture(); await through(f, 'install'); let child;
  f.io.spawn = () => { child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; child.unref = () => {}; child.stdout.destroy = child.stderr.destroy = () => {}; return child; };
  const pending = api.handle('qualify', f.io, f.env); for (let i = 0; i < 25000 && !child; i++) await Promise.resolve(); assert.ok(child);
  for (const ms of [210000, 3000, 2000]) { const t = f.timers.find((v) => v.active && v.ms === ms); assert.ok(t); t.active = false; t.fn(); }
  await failure(() => pending, 'RUNNER_UNPROVEN'); await api.handle('cleanup', f.io, f.env);
  const value = JSON.parse(f.files.get('/carrier/api-music-posix-safe/result.json')); assert.equal(value.cleanup.innerEffects, 'UNKNOWN'); assert.equal(value.cleanup.furtherOuterDeletion, 'WITHHELD');
  assert.equal(f.effects.some((v) => v[0] === 'rm'), false);
});
test('dependency inventory normalizes internal links and rejects escape and traversal time overflow', async () => {
  const f = fixture(); await through(f, 'install'); const stats = f.io.stat, real = f.io.realpath;
  f.dirs.add('/store');
  f.io.readdir = async (p) => p === '/store' ? ['link'] : [];
  f.io.stat = async (p) => p === '/store/link' ? {kind: 'symlink', size: 0} : stats(p);
  f.io.realpath = async (p) => p === '/store/link' ? '/foreign/key' : real(p);
  await failure(() => api.measureTree({store: '/store'}, {entries: 250000, file: 536870912, total: 8589934592, ms: 60000}, f.io), 'DEPENDENCY_UNPROVEN');
  f.io.now = (() => { let n = 0; return () => n++ ? 60001 : 0; })();
  await failure(() => api.measureTree({store: '/store'}, {entries: 250000, file: 536870912, total: 8589934592, ms: 60000}, f.io), 'DEPENDENCY_UNPROVEN');
});
test('cleanup watchdog bounds waiting but does not cancel recursive deletion or later effects', async () => {
  const f = fixture(); await through(f, 'qualify'); let complete; f.io.rm = () => new Promise((resolve) => { complete = resolve; });
  const pending = api.handle('cleanup', f.io, f.env); for (let i = 0; i < 150; i++) await Promise.resolve();
  const t = f.timers.find((v) => v.active && v.ms === 5000); assert.ok(t); t.fn(); await pending;
  const before = f.files.get('/carrier/api-music-posix-safe/result.json').toString(); const value = JSON.parse(before);
  assert.equal(value.adoptableCells, 0); assert.equal(value.cleanup.furtherOuterDeletion, 'UNKNOWN_AFTER_TIMEOUT'); complete(); await Promise.resolve();
  assert.equal(f.files.get('/carrier/api-music-posix-safe/result.json').toString(), before);
});
test('compact cap accepts exactly8192 UTF8 bytes and refuses8193; absent final file means no proof', () => {
  assert.equal(Buffer.byteLength(api.formatResult({value: 'x'.repeat(8180)})), 8192);
  assert.throws(() => api.formatResult({value: 'x'.repeat(8181)}), /FILE_UNPROVEN/);
  assert.equal(fixture().files.has('/carrier/api-music-posix-safe/result.json'), false);
});
test('no arbitrary command or address text reaches effects', async () => {
  const f = fixture(); await failure(() => api.handle('curl 192.0.2.1', f.io, f.env), 'HOST_UNPROVEN'); assert.equal(f.effects.length, 0);
});
test('combined installer output cap, spawn error and cancellation withhold deletion without retry', async () => {
  for (const fault of ['output','spawn','cancel']) {
    const f=fixture(); await through(f,'prepare'); let child;
    f.io.spawn=()=>{if(fault==='spawn')throw Error('/private/token');child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};return child;};
    const pending=api.handle('install',f.io,f.env);
    if(fault!=='spawn') {
      for(let i=0;i<25000&&!child;i++)await Promise.resolve(); assert.ok(child);
      if(fault==='output'){child.stdout.emit('data',Buffer.alloc(2*1024*1024));child.stderr.emit('data',Buffer.from('x'));}
      else f.io.signalSource.emit('SIGTERM');
      child.emit('close',0,null);
    }
    await failure(()=>pending,'DEPENDENCY_UNPROVEN');await api.handle('cleanup',f.io,f.env);
    const value=JSON.parse(f.files.get('/carrier/api-music-posix-safe/result.json'));
    assert.equal(value.adoptableCells,0);assert.equal(value.cleanup.furtherOuterDeletion,'WITHHELD');assert.equal(JSON.stringify(value).includes('/private'),false);
  }
});
test('inventory canonical content is hashed once and every independent traversal bound rejects', async () => {
  const f=fixture();f.dirs.add('/deps');f.dirs.add('/store');f.put('/store/a','a');let reads=0;
  const stat=f.io.stat,read=f.io.read;f.io.stat=async(p)=>p==='/deps/link'?{kind:'symlink',size:0}:stat(p);
  f.io.realpath=async(p)=>p==='/deps/link'?'/store/a':p;
  f.io.readdir=async(p)=>p==='/deps'?['link']:p==='/store'?['a']:[];
  f.io.read=async(...v)=>{reads++;return read(...v);};
  const value=await api.measureTree({dependencies:'/deps',store:'/store'},{entries:3,file:1,total:1,ms:60000},f.io);
  assert.equal(value.files,1);assert.equal(value.bytes,1);assert.equal(reads,1);
  assert.equal(value.sha256,hash(Buffer.from(JSON.stringify([['dependencies/link','symlink','store/a'],['store/a','file',hash(Buffer.from('a'))]]))));
  for(const limits of [{entries:1,file:1,total:1,ms:60000},{entries:3,file:0,total:1,ms:60000},{entries:3,file:1,total:0,ms:60000}])
    await failure(()=>api.measureTree({dependencies:'/deps',store:'/store'},limits,f.io),'DEPENDENCY_UNPROVEN');
  f.io.readdir=()=>new Promise(()=>{});const pending=api.measureTree({dependencies:'/deps'},{entries:3,file:1,total:1,ms:60000},f.io);
  for(let i=0;i<20;i++)await Promise.resolve();const t=f.timers.find((v)=>v.active&&v.ms===60000);assert.ok(t);t.fn();await failure(()=>pending,'DEPENDENCY_UNPROVEN');
});
test('captured inner no-close retains inherited finally-rm attempt and unknown effects', async () => {
  const f=fixture();await through(f,'install');const spawn=f.io.spawn;
  f.io.spawn=(...args)=>{const c=spawn(...args),emit=c.stdout.emit.bind(c.stdout),close=c.emit.bind(c);
    c.stdout.emit=(name,b)=>{if(name==='data'){const v=JSON.parse(b);v.status='UNPROVEN';v.reason='CHILD_NO_CLOSE';v.protocols=[];
      v.childFailure=qualifier.summarizeChildFailure('CHILD_NO_CLOSE','RETURNED',{closed:false,code:null,signal:null,reason:null,stdout:''},'/source');
      return emit(name,Buffer.from(JSON.stringify(v)));}return emit(name,b);};
    c.emit=(name,...v)=>close(name,...(name==='close'?[1,null]:v));return c;};
  await failure(()=>api.handle('qualify',f.io,f.env),'RUNNER_UNPROVEN');await api.handle('cleanup',f.io,f.env);
  const value=JSON.parse(f.files.get('/carrier/api-music-posix-safe/result.json'));
  assert.equal(value.cleanup.innerAttempt,'ATTEMPTED');assert.equal(value.cleanup.innerEffects,'UNKNOWN');assert.equal(value.cleanup.furtherOuterDeletion,'WITHHELD');
});
test('maximal success and failure artifacts remain compact, allowlisted and within8192 bytes', async () => {
  const counts=[];
  for(const fail of [false,true]) {
    const f=fixture();f.policy.platforms[0].imageOS='i'.repeat(100);f.policy.platforms[0].imageVersion='v'.repeat(100);
    f.env.ImageOS=f.policy.platforms[0].imageOS;f.env.ImageVersion=f.policy.platforms[0].imageVersion;
    f.env.EXPECTED_REF='refs/heads/'+ 'q'.repeat(150);f.env.GITHUB_REF=f.env.EXPECTED_REF;f.env.GITHUB_WORKFLOW_REF='deruta74/pear-desktop/.github/workflows/tests.yml@'+f.env.EXPECTED_REF;f.refreshPolicy();
    await through(f,'install');const spawn=f.io.spawn;
    f.io.spawn=(...args)=>{const c=spawn(...args),emit=c.stdout.emit.bind(c.stdout),close=c.emit.bind(c);
      c.stdout.emit=(name,b)=>{if(name==='data'){const v=JSON.parse(b);for(const p of v.protocols){p.telemetry.endpoint.observations=256;p.telemetry.endpoint.epochs.forEach((r)=>{r.observations=64;});p.telemetry.counts.requests=256;p.telemetry.counts.nativeReadPackets=128;if(p.protocol==='TLS')p.telemetry.tls.verifiedResponses=256;}
        if(fail){v.status='UNPROVEN';v.reason='CHILD_FAILED';v.protocols=[];v.childFailure=qualifier.summarizeChildFailure('CHILD_FAILED','RETURNED',{closed:true,code:4294967295,signal:'SIGTERM',reason:null,stdout:''},'/source');}
        return emit(name,Buffer.from(JSON.stringify(v)));}return emit(name,b);};c.emit=(name,...v)=>close(name,...(name==='close'&&fail?[1,null]:v));return c;};
    if(fail)await failure(()=>api.handle('qualify',f.io,f.env),'RUNNER_UNPROVEN');else await api.handle('qualify',f.io,f.env);
    await api.handle('cleanup',f.io,f.env);const bytes=f.files.get('/carrier/api-music-posix-safe/result.json'),v=JSON.parse(bytes);counts.push(bytes.length);
    assert.equal(v.adoptableCells,fail?0:2);assert.ok(bytes.length<=8192);assert.equal(bytes.includes(Buffer.from('/runner')),false);
  }
  console.log(JSON.stringify({maximalSuccessBytes:counts[0],maximalFailureBytes:counts[1],cap:8192}));
});
(async () => {
  let passed = 0;
  for (const [name, fn] of tests) { try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + e.message); } }
  console.log(JSON.stringify({tests: tests.length, passed, failed: tests.length - passed})); process.exitCode = passed === tests.length ? 0 : 1;
})();
