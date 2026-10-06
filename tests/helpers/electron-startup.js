import assert from 'node:assert/strict';
import { access, readFile, realpath, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

/** @typedef {{ pid: number, userData: string, visibleWindow: boolean }} StartupFacts */

/** @param {import('node:child_process').ChildProcess} child */
function assertRunning(child) {
  assert(
    child.exitCode === null && child.signalCode === null,
    `Electron exited before startup validation (code ${child.exitCode}, signal ${child.signalCode})`,
  );
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
    child.pid,
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
