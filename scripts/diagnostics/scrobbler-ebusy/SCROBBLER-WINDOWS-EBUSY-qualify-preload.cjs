'use strict';

// Pure host-Node contract qualification with baseline stubs; no Electron,
// native PID query, taskkill, dependency install, or native probe is performed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { promisify } = require('node:util');
const report = process.argv[2];
if (!report || !path.isAbsolute(report)) throw Error('Pass an existing absolute report-owned qualification directory');
const directory = path.join(report, 'pear-scrobbler-window-qual01');
const originalError = Object.assign(Error('qualification error'), { code: 'EBUSY', syscall: 'rmdir', errno: -1 });
const rmResolved = Promise.resolve(undefined);
let rmRejected;
const mkdtempResolved = Promise.resolve(directory);
const readResolved = Promise.resolve(JSON.stringify({ id: 1, ok: true, result: { closed: true, primaryGone: true, childGone: true, parentAlive: true } }));
const child = Object.assign(new EventEmitter(), { pid: 60001, stdout: new EventEmitter() });
const queryChild = Object.assign(new EventEmitter(), { pid: 60002, stdout: new EventEmitter() });
const customPromise = Object.assign(Promise.resolve({ stdout: '', stderr: '' }), { child: queryChild });
const originalAppend = fs.appendFileSync;
let loggerMode = 'normal';
const calls = [];

(async () => {
  const esm = await import('node:fs/promises');
  // Baselines exist BEFORE the wrapper is installed; compare exact identity.
  fs.promises.mkdtemp = (...args) => { calls.push(['mkdtemp', args]); return mkdtempResolved; };
  fs.promises.readFile = (...args) => { calls.push(['readFile', args]); return readResolved; };
  fs.promises.rm = (...args) => { calls.push(['rm', args]); return args[0].endsWith('reject') ? rmRejected : rmResolved; };
  cp.spawn = (...args) => { calls.push(['spawn', args]); return child; };
  const execBaseline = (...args) => { calls.push(['execFile', args]); return queryChild; };
  execBaseline[promisify.custom] = (...args) => { calls.push(['execFile-custom', args]); return customPromise; };
  cp.execFile = execBaseline;
  fs.appendFileSync = (...args) => {
    const workerLog = path.basename(String(args[0])) === `worker-${process.pid}.jsonl`;
    if (loggerMode === 'all-appends-fail' || (loggerMode === 'worker-log-fails' && workerLog)) {
      throw Object.assign(Error('logger fail-open qualification'), { code: 'EACCES' });
    }
    return originalAppend(...args);
  };
  process.env.PEAR_EBUSY_REPORT_ROOT = report;
  require('./SCROBBLER-WINDOWS-EBUSY-preload.cjs');

  assert.equal(esm.rm, fs.promises.rm, 'syncBuiltinESMExports updated preloaded ESM rm binding');
  assert.equal(esm.mkdtemp, fs.promises.mkdtemp, 'ESM mkdtemp binding updated');
  assert.equal(esm.readFile, fs.promises.readFile, 'ESM readFile binding updated');
  assert.equal(fs.promises.mkdtemp(path.join(report, 'pear-scrobbler-window-')), mkdtempResolved);
  assert.equal(fs.promises.readFile(path.join(directory, 'result.json'), 'utf8'), readResolved);
  const options = Object.freeze({ recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  assert.equal(fs.promises.rm(directory, options), rmResolved);
  const spawnOptions = Object.freeze({ cwd: directory });
  assert.equal(cp.spawn('cmd.exe', ['/d'], spawnOptions), child);
  assert.equal(cp.execFile('taskkill.exe', ['/pid', '60003', '/T', '/F']), queryChild);
  const custom = promisify(cp.execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter 'ParentProcessId = 60001' | Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress"]);
  assert.equal(custom, customPromise); assert.equal(custom.child, queryChild);
  queryChild.stdout.emit('data', '[{"ProcessId":60003,"ExecutablePath":"electron.exe"}]');
  child.emit('exit', 0, null); child.emit('close', 0, null);
  queryChild.emit('exit', 0, null); queryChild.emit('close', 0, null);
  await Promise.resolve();
  rmRejected = Promise.reject(originalError);
  const rejected = fs.promises.rm(path.join(directory, 'reject'), options);
  assert.equal(rejected, rmRejected);
  await assert.rejects(rejected, (error) => error === originalError);
  // R2: main JSONL fails, but fallback marker append remains usable.
  loggerMode = 'worker-log-fails';
  const fallbackResolved = fs.promises.rm(directory, options);
  assert.equal(fallbackResolved, rmResolved);
  const fallbackRejected = fs.promises.rm(path.join(directory, 'reject'), options);
  assert.equal(fallbackRejected, rmRejected);
  await assert.rejects(fallbackRejected, (error) => error === originalError);
  assert.equal(cp.spawn('cmd.exe', ['/d'], spawnOptions), child);
  const fallbackCustom = promisify(cp.execFile)('taskkill.exe', ['/pid', '60003', '/T', '/F']);
  assert.equal(fallbackCustom, customPromise); assert.equal(fallbackCustom.child, queryChild);
  await fallbackResolved; await Promise.resolve();
  const markerPath = path.join(report, `worker-${process.pid}.diagnostic-error`);
  const visibleMarker = fs.readFileSync(markerPath, 'utf8');
  const markerCodes = visibleMarker.trim().split('\n');
  assert(markerCodes.length > 0 && markerCodes.every((code) => code === 'EACCES'), 'safe EACCES fallback marker visible');

  // Original all-append-failure control remains: no marker can be written,
  // but original promises/errors/options/children must still survive.
  loggerMode = 'all-appends-fail';
  assert.equal(fs.promises.rm(directory, options), rmResolved, 'logger failure preserves original promise');
  const allFailedRejected = fs.promises.rm(path.join(directory, 'reject'), options);
  assert.equal(allFailedRejected, rmRejected);
  await assert.rejects(allFailedRejected, (error) => error === originalError);
  assert.equal(cp.spawn('cmd.exe', ['/d'], spawnOptions), child);
  const allFailedCustom = promisify(cp.execFile)('taskkill.exe', ['/pid', '60003', '/T', '/F']);
  assert.equal(allFailedCustom, customPromise); assert.equal(allFailedCustom.child, queryChild);
  await rmResolved; await Promise.resolve();
  assert.equal(fs.readFileSync(markerPath, 'utf8'), visibleMarker, 'all-append failure leaves existing marker unchanged');
  loggerMode = 'normal';
  assert.equal(calls.find((r) => r[0] === 'rm')[1][1], options);
  assert(calls.filter((r) => r[0] === 'rm').every((r) => r[1][1] === options), 'options preserved through both logger failure modes');
  assert.equal(calls.find((r) => r[0] === 'spawn')[1][2], spawnOptions);
  const lines = fs.readFileSync(path.join(report, `worker-${process.pid}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  for (const event of ['preload-ready', 'fixture-created', 'rm-begin', 'rm-resolve', 'rm-reject', 'native-result-read', 'fixture-launcher-close', 'native-taskkill-close', 'native-pid-query-records']) {
    assert(lines.some((r) => r.event === event), `missing ${event}`);
  }
  assert(lines.some((r) => r.event === 'native-result-read' && r.result.parentAlive === true));
  const result = { mode: 'pure-host-node stub qualification', pass: true, nativeOrElectronExecuted: false,
    checks: ['original promise identity', 'original error identity', 'original options identity', 'original child identity', 'custom execFile promisifier and promise.child', 'ESM binding updates', 'safe packet/process/cleanup event emission', 'selective worker-log failure exposes EACCES fallback marker', 'all-append-failure control preserves fail-open behavior'],
    loggerHealth: { selectiveFailureMarkerVisible: true, safeCode: 'EACCES', markerCodesObserved: markerCodes.length, allAppendFailureControlPassed: true },
    limitations: ['No Windows runtime, filesystem-lock, process-tree, or actual Electron compatibility validation.'] };
  fs.writeFileSync(path.join(report, 'qualification.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
})().catch((error) => { console.error(error); process.exitCode = 1; });
