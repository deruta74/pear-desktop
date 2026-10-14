'use strict';

// Report-owned diagnostic proposal. Not installed or executed in Electron.
// The original promise/error/options and the qualified native observer survive.
if (!process.versions.electron && process.env.PEAR_EBUSY_REPORT_ROOT) {
  const fs = require('node:fs');
  const cp = require('node:child_process');
  const path = require('node:path');
  const { syncBuiltinESMExports } = require('node:module');
  const { promisify } = require('node:util');
  const root = process.env.PEAR_EBUSY_REPORT_ROOT;
  const output = path.join(root, `worker-${process.pid}.jsonl`);
  const health = path.join(root, `worker-${process.pid}.diagnostic-error`);
  const append = fs.appendFileSync.bind(fs);
  let sequence = 0;
  const packetIds = new Map();
  const stamp = () => ({ utc: new Date().toISOString(), monoMs: performance.now() });
  const fixtureRoot = (value) => {
    if (typeof value !== 'string') return null;
    const match = value.match(/^(.*[\\/]pear-scrobbler-window-[^\\/]+)(?:[\\/]|$)/);
    return match?.[1] ?? null;
  };
  function log(event, data = {}, at = stamp()) {
    try {
      append(output, JSON.stringify({ schema: 1, hostPid: process.pid, sequence: ++sequence, event, ...at, ...data }) + '\n');
    } catch (error) {
      // Reporting cannot replace the original test error or throw in its handlers.
      try { append(health, String(error?.code ?? 'logger-error') + '\n'); } catch {}
    }
  }
  const failure = (e) => ({ code: e?.code ?? null, syscall: e?.syscall ?? null, errno: e?.errno ?? null, name: e?.name ?? null });
  log('preload-ready', { nodeVersion: process.versions.node, platform: process.platform });

  const originalMkdtemp = fs.promises.mkdtemp;
  fs.promises.mkdtemp = function (...args) {
    const promise = Reflect.apply(originalMkdtemp, this, args);
    if (typeof args[0] === 'string' && args[0].includes('pear-scrobbler-window-')) {
      promise.then((directory) => log('fixture-created', { directory }), () => {});
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
    if (directory && path.basename(args[0]) === 'result.json') {
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
    log(`${event}-spawn`, { ...data, childPid: child.pid ?? null });
    child.once('exit', (code, signal) => log(`${event}-exit`, { ...data, childPid: child.pid ?? null, code, signal }));
    child.once('close', (code, signal) => log(`${event}-close`, { ...data, childPid: child.pid ?? null, code, signal }));
    // Adding an 'error' listener could suppress an original unhandled error: do not.
  }
  const originalSpawn = cp.spawn;
  cp.spawn = function (...args) {
    const child = Reflect.apply(originalSpawn, this, args);
    const options = Array.isArray(args[1]) ? args[2] : args[1];
    const directory = fixtureRoot(options?.cwd);
    if (directory) observe(child, 'fixture-launcher', { directory, executable: path.basename(String(args[0])) });
    return child;
  };
  const originalExecFile = cp.execFile;
  function observeExec(child, args) {
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
