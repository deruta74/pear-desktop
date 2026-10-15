'use strict';

// Report-owned diagnostic proposal. Not installed or executed in Electron.
// The original promise/error/options and the qualified native observer survive.
if (!process.versions.electron && process.env.PEAR_EBUSY_REPORT_ROOT) {
  const fs = require('node:fs');
  const cp = require('node:child_process');
  const path = require('node:path');
  const { syncBuiltinESMExports } = require('node:module');
  const { promisify, TextDecoder } = require('node:util');
  const root = process.env.PEAR_EBUSY_REPORT_ROOT;
  const scope = process.env.PEAR_EBUSY_DIAGNOSTIC_SCOPE ?? 'scrobbler-window';
  const scopeValid = scope === 'scrobbler-window' || scope === 'music-native-c1-f2';
  const output = path.join(root, `worker-${process.pid}.jsonl`);
  const health = path.join(root, `worker-${process.pid}.diagnostic-error`);
  const append = fs.appendFileSync.bind(fs);
  let sequence = 0;
  const packetIds = new Map();
  const stamp = () => ({ utc: new Date().toISOString(), monoMs: performance.now() });
  const fixtureRoot = (value) => {
    if (typeof value !== 'string') return null;
    if (scope === 'music-native-c1-f2') {
      return value.match(/^(.*[\\/]pear-music-native-[A-Za-z0-9]{6})(?:[\\/]|$)/)?.[1] ?? null;
    }
    const match = value.match(/^(.*[\\/]pear-scrobbler-window-[^\\/]+)(?:[\\/]|$)/);
    return match?.[1] ?? null;
  };
  function log(event, data = {}, at = stamp()) {
    try {
      append(output, JSON.stringify({ schema: 1, hostPid: process.pid, sequence: ++sequence, event, ...at, ...data }) + '\n');
    } catch (error) {
      // Reporting cannot replace the original test error or throw in its handlers.
      try { append(health, scope === 'music-native-c1-f2' ? 'music-log-write-error\n' : String(error?.code ?? 'logger-error') + '\n'); } catch {}
    }
  }
  const failure = (e) => scope === 'music-native-c1-f2'
    ? { code: ['EBUSY', 'ENOTEMPTY', 'ENOENT', 'EPERM', 'EACCES', 'EIO', 'EINVAL'].includes(e?.code) ? e.code : 'unclassified-fs-error',
      syscall: ['rmdir', 'unlink', 'scandir', 'rm'].includes(e?.syscall) ? e.syscall : null,
      errno: Number.isSafeInteger(e?.errno) ? e.errno : null, name: e?.name === 'Error' ? 'Error' : 'unclassified-error' }
    : ({ code: e?.code ?? null, syscall: e?.syscall ?? null, errno: e?.errno ?? null, name: e?.name ?? null });
  log('preload-ready', { nodeVersion: process.versions.node, platform: process.platform, scope: scopeValid ? scope : 'invalid' });
  if (!scopeValid) { try { append(health, 'unsupported-scope\n'); } catch {} }
  if (scopeValid) {

  const originalMkdtemp = fs.promises.mkdtemp;
  fs.promises.mkdtemp = function (...args) {
    const promise = Reflect.apply(originalMkdtemp, this, args);
    if (typeof args[0] === 'string' && (scope === 'music-native-c1-f2'
      ? path.basename(args[0]) === 'pear-music-native-' : args[0].includes('pear-scrobbler-window-'))) {
      promise.then((directory) => {
        if (scope === 'music-native-c1-f2' && fixtureRoot(directory) !== directory) log('music-native-parser-error', { code: 'created-root-scope' });
        else log('fixture-created', { directory });
      }, () => {});
    }
    return promise;
  };
  const originalRm = fs.promises.rm;
  fs.promises.rm = function (...args) {
    const directory = fixtureRoot(args[0]);
    const at = stamp();
    const promise = Reflect.apply(originalRm, this, args);
    if (directory) {
      const operation = `${process.pid}:${sequence + 1}`;
      const options = args[1];
      log('rm-begin', { operation, directory, targetIsRoot: args[0] === directory, options: {
        recursive: options?.recursive, force: options?.force, maxRetries: options?.maxRetries, retryDelay: options?.retryDelay,
      } }, at);
      promise.then(
        () => log('rm-resolve', { operation, directory, elapsedMs: performance.now() - at.monoMs }),
        (error) => log('rm-reject', { operation, directory, elapsedMs: performance.now() - at.monoMs, error: failure(error) }),
      );
    }
    return promise; // Original promise identity, exact error, options and retries.
  };
  const originalReadFile = fs.promises.readFile;
  fs.promises.readFile = function (...args) {
    const promise = Reflect.apply(originalReadFile, this, args);
    const directory = fixtureRoot(args[0]);
    if (scope === 'scrobbler-window' && directory && path.basename(args[0]) === 'result.json') {
      promise.then((data) => {
        try {
          const packet = JSON.parse(String(data));
          if (packetIds.get(args[0]) === packet.id) return;
          packetIds.set(args[0], packet.id);
          const result = {};
          for (const key of ['closed', 'primaryGone', 'childGone', 'parentAlive']) {
            if (typeof packet.result?.[key] === 'boolean') result[key] = packet.result[key];
          }
          if (Object.keys(result).length || packet.ok === false) {
            log('native-result-read', { directory, taskId: packet.id, ok: packet.ok === true, result,
              errorName: packet.ok === false && /^[A-Za-z]{1,40}$/.test(packet.error) ? packet.error : null });
          }
        } catch {}
      }, () => {});
    }
    return promise;
  };

  function observe(child, event, data) {
    if (!child?.once) return;
    const childPid = scope === 'music-native-c1-f2' ? Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null : child.pid ?? null;
    const ended = (code, signal) => scope === 'music-native-c1-f2'
      ? { code: Number.isSafeInteger(code) ? code : null, signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV'].includes(signal) ? signal : null }
      : { code, signal };
    log(`${event}-spawn`, { ...data, childPid });
    child.once('exit', (code, signal) => log(`${event}-exit`, { ...data, childPid, ...ended(code, signal) }));
    child.once('close', (code, signal) => log(`${event}-close`, { ...data, childPid, ...ended(code, signal) }));
    // Adding an 'error' listener could suppress an original unhandled error: do not.
  }
  function observeMusic(child, directory) {
    const childPid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
    let resultSeen = false;
    const parserError = (code) => log('music-native-parser-error', { directory, code });
    const own = (value, key) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key);
    const field = (value, keys) => {
      for (const key of keys.split('.')) { if (!own(value, key)) return undefined; value = value[key]; }
      return value;
    };
    function result(line) {
      if (!line.startsWith('MUSIC_NATIVE ')) return;
      if (resultSeen) { parserError('duplicate-result'); return; }
      let value;
      try { value = JSON.parse(line.slice(13)); } catch { parserError('result-json'); return; }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) { parserError('result-object'); return; }
      resultSeen = true;
      const projection = {}; let validFields = 0;
      const copy = (key, valid) => { const item = field(value, key); projection[key] = valid(item) ? item : null; if (valid(item)) validFields++; };
      for (const key of ['coldBefore', 'coldAfter', 'canceledGetterCalls']) copy(key, x => Number.isSafeInteger(x) && x >= 0 && x <= 1000000);
      for (const key of ['firstA', 'firstB', 'secondB', 'oldStatus', 'replayB', 'firstC', 'secondC', 'replayC', 'firstD', 'failure', 'replayD']) copy(key, x => Number.isSafeInteger(x) && x >= 100 && x <= 599);
      for (const key of ['retiredBBeforeCurrentReentry', 'healthy', 'currentReentry.outerRefresh', 'currentReentry.retiredNested', 'metadata.isCurrent', 'metadata.retired']) copy(key, x => typeof x === 'boolean');
      for (const [left, right, key] of [['adoptedSourceC', 'currentReentry.nestedSource', 'sourceCMatchesNested'], ['adoptedSourceD', 'metadata.source', 'sourceDMatchesMetadata']]) {
        const a = field(value, left), b = field(value, right);
        const valid = typeof a === 'string' && a.length <= 256 && typeof b === 'string' && b.length <= 256;
        projection[key] = valid ? a === b : null; if (valid) validFields++;
      }
      log('music-native-result', { directory, childPid, validFields, projection });
      if (validFields !== 22) parserError('result-fields');
    }
    function error(line) {
      const header = line.match(/^Owned native music witness failed at ([^:]{1,80}): (.*)$/);
      if (!header) return;
      const stage = ['ready', 'task', 'shutdown'].includes(header[1]) ? header[1] : 'other';
      const classes = new Map([['Error: Missing owned reentry observation', 'missing-owned-reentry-observation'], ['Error: Explicit menu copy missing', 'explicit-menu-copy-missing'], ['Error: Unexpected recipe', 'unexpected-recipe'], ['Error: Unexpected native remote request', 'unexpected-native-remote-request']]);
      log('music-native-error', { directory, childPid, stage, errorClass: classes.get(header[2]) ?? 'unclassified-native-error' });
    }
    function lines(stream, receive) {
      if (!stream?.on) { parserError('missing-stream'); return; }
      const pending = Buffer.alloc(16384), decoder = new TextDecoder('utf-8', { fatal: true });
      let used = 0, dropping = false;
      stream.on('data', chunk => {
        try {
          if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') { parserError('stream-type'); return; }
          for (const byte of Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) {
            if (byte === 10) {
              if (!dropping) { try { receive(decoder.decode(pending.subarray(0, used)).replace(/\r$/, '')); } catch { parserError('stream-frame'); } }
              used = 0; dropping = false;
            } else if (!dropping) {
              if (used === pending.length) { parserError('stream-overflow'); used = 0; dropping = true; }
              else pending[used++] = byte;
            }
          }
        } catch { parserError('stream-observer'); }
      });
      stream.once('end', () => { if (used > 0 || dropping) parserError('incomplete-stream-line'); });
    }
    lines(child.stdout, result); lines(child.stderr, error);
  }
  const originalSpawn = cp.spawn;
  cp.spawn = function (...args) {
    const child = Reflect.apply(originalSpawn, this, args);
    const options = Array.isArray(args[1]) ? args[2] : args[1];
    const directory = fixtureRoot(options?.cwd);
    if (directory) {
      const basename = typeof args[0] === 'string' && !options?.shell ? path.basename(args[0]) : null;
      const executable = options?.shell ? 'shell-launch'
        : basename && /^[A-Za-z0-9._-]{1,80}$/.test(basename) ? basename : 'unknown-executable';
      observe(child, 'fixture-launcher', { directory, executable });
      if (scope === 'music-native-c1-f2') {
        try { observeMusic(child, directory); } catch { log('music-native-parser-error', { directory, code: 'observer-init' }); }
      }
    }
    return child;
  };
  const originalExecFile = cp.execFile;
  function observeExec(child, args) {
    if (scope === 'music-native-c1-f2') return;
    const executable = path.basename(String(args[0])).toLowerCase();
    const argv = Array.isArray(args[1]) ? args[1] : [];
    if (executable === 'taskkill.exe' && argv[0] === '/pid' && /^\d+$/.test(argv[1]) && argv[2] === '/T' && argv[3] === '/F') {
      observe(child, 'native-taskkill', { nativePid: Number(argv[1]), tree: true, force: true });
    }
    const command = argv[argv.indexOf('-Command') + 1];
    const query = executable === 'powershell.exe' && typeof command === 'string'
      ? command.match(/^Get-CimInstance Win32_Process -Filter 'ParentProcessId = (\d+)' \| Select-Object ProcessId, ExecutablePath \| ConvertTo-Json -Compress$/) : null;
    if (!query) return;
    const launcherPid = Number(query[1]);
    observe(child, 'native-pid-query', { launcherPid });
    let stdout = '';
    child.stdout?.on('data', (data) => { if (stdout.length < 65536) stdout += String(data).slice(0, 65536 - stdout.length); });
    child.once('close', () => {
      try {
        const parsed = JSON.parse(stdout);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        log('native-pid-query-records', { launcherPid, records: rows.slice(0, 10).map((r) => ({
          pid: Number.isSafeInteger(r.ProcessId) ? r.ProcessId : null,
          executable: typeof r.ExecutablePath === 'string' ? path.basename(r.ExecutablePath) : null,
        })) });
      } catch { log('native-pid-query-unparsed', { launcherPid }); }
    });
  }
  cp.execFile = function (...args) {
    const child = Reflect.apply(originalExecFile, this, args);
    observeExec(child, args);
    return child;
  };
  // Native execFile has a custom promisifier. Preserve its original promise.child.
  if (originalExecFile[promisify.custom]) {
    cp.execFile[promisify.custom] = function (...args) {
      const promise = Reflect.apply(originalExecFile[promisify.custom], this, args);
      observeExec(promise.child, args);
      return promise;
    };
  }
  syncBuiltinESMExports();
  }
}
