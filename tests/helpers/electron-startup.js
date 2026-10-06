import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);

/** @typedef {{ pid: number, userData: string, visibleWindow: boolean }} StartupFacts */

/** @param {import('node:child_process').ChildProcess} child */
function assertRunning(child) {
  assert(
    child.exitCode === null && child.signalCode === null,
    `Electron exited before startup validation (code ${child.exitCode}, signal ${child.signalCode})`,
  );
}

/**
 * @param {unknown} records
 * @param {string} executable
 */
export async function selectNativeStartupPid(records, executable) {
  assert(Array.isArray(records), 'Invalid native Electron process query');
  const canonical = await realpath(executable);
  /** @param {string} value */
  const normalize = (value) =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  /** @type {number[]} */
  const matches = [];
  for (const record of /** @type {unknown[]} */ (records)) {
    if (
      typeof record !== 'object' ||
      record === null ||
      !('ProcessId' in record) ||
      !('ExecutablePath' in record) ||
      typeof record.ProcessId !== 'number' ||
      !Number.isSafeInteger(record.ProcessId) ||
      record.ProcessId <= 0 ||
      typeof record.ExecutablePath !== 'string'
    )
      continue;
    if (
      normalize(await realpath(record.ExecutablePath)) === normalize(canonical)
    )
      matches.push(record.ProcessId);
  }
  assert.equal(
    matches.length,
    1,
    'Expected exactly one owned native Electron process',
  );
  assert(typeof matches[0] === 'number', 'Missing native Electron process PID');
  return matches[0];
}

/** @param {import('node:child_process').ChildProcess} child */
export async function nativeStartupPid(child) {
  assertRunning(child);
  const launcherPid = child.pid;
  assert(
    typeof launcherPid === 'number' &&
      Number.isSafeInteger(launcherPid) &&
      launcherPid > 0,
    'Missing launcher PID',
  );
  let pid = launcherPid;
  if (process.platform === 'win32') {
    // Playwright 1.61 launches through cmd.exe on Windows. Query its direct
    // children independently of observer facts; never fall back to a claimed PID.
    const { stdout } = await executeFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${launcherPid}' | Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress`,
      ],
      { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true },
    );
    const records = /** @type {unknown} */ (
      stdout.trim() ? JSON.parse(stdout) : []
    );
    pid = await selectNativeStartupPid(
      Array.isArray(records) ? records : [records],
      /** @type {string} */ (require('electron')),
    );
  }
  assertRunning(child);
  process.kill(pid, 0);
  return pid;
}

/** @param {import('node:child_process').ChildProcess} child */
export async function terminateStartupProcess(child) {
  const pid = await nativeStartupPid(child);
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
  if (process.platform === 'win32') {
    await executeFile('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
      timeout: 5000,
      windowsHide: true,
    });
  } else {
    // Playwright launches a detached process group on POSIX.
    process.kill(-pid, 'SIGKILL');
  }
  await exited;
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} factsPath
 * @param {number} timeout
 * @returns {Promise<StartupFacts>}
 */
export async function waitForStartupFacts(child, factsPath, timeout = 10_000) {
  const deadline = performance.now() + timeout;
  while (true) {
    assertRunning(child);
    try {
      return /** @type {StartupFacts} */ (
        JSON.parse(await readFile(factsPath, 'utf8'))
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
    }
    assert(
      performance.now() < deadline,
      'No startup facts from a native visible window',
    );
    await setTimeout(20);
  }
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} factsPath
 * @param {number} timeout
 * @returns {Promise<StartupFacts>}
 */
export async function refreshStartupFacts(child, factsPath, timeout = 10_000) {
  assertRunning(child);
  const requestPath = `${factsPath}.request`;
  await writeFile(requestPath, '', { flag: 'wx' });
  const deadline = performance.now() + timeout;
  while (true) {
    assertRunning(child);
    try {
      await access(requestPath);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
      const facts = /** @type {StartupFacts} */ (
        JSON.parse(await readFile(factsPath, 'utf8'))
      );
      assertRunning(child);
      return facts;
    }
    assert(
      performance.now() < deadline,
      'No refreshed startup facts acknowledgement',
    );
    await setTimeout(20);
  }
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {StartupFacts} facts
 * @param {string} profile
 */
export async function assertStartupFacts(child, facts, profile) {
  assertRunning(child);
  assert.equal(
    facts.pid,
    await nativeStartupPid(child),
    'Startup facts came from a different process',
  );
  assert.equal(facts.visibleWindow, true, 'No native visible window');
  assert.equal(
    typeof facts.userData,
    'string',
    'Missing userData startup fact',
  );
  assert.equal(
    await realpath(facts.userData),
    await realpath(profile),
    'Incorrect userData profile',
  );
  assertRunning(child);
}
