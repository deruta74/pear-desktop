import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { assessOutcome, relativeSpecifier, summarizeTiny } from './source-module-identity-probe.mjs';

test('cross-drive path is unavailable, never a fabricated relative import', () => {
  assert.equal(relativeSpecifier('C:/temp/entry.ts', 'D:/repo/src/state.ts', path.win32), null);
  assert.equal(relativeSpecifier('D:/temp/entry.ts', 'D:/repo/src/state.ts', path.win32), '../repo/src/state.ts');
  assert.equal(relativeSpecifier('/temp/entry.ts', '/repo/src/state.ts', path.posix), '../repo/src/state.ts');
});

test('identity detector distinguishes shared references and WeakMap state from copies', () => {
  const shared = { identity: {}, set: new WeakMap() };
  const route = (state) => ({
    identity: state.identity,
    put: (key, value) => state.set.set(key, value),
    get: (key) => state.set.get(key),
  });
  const a = route(shared);
  const same = summarizeTiny([a, a, a], 1);
  assert.equal(same.objectIdentity, true);
  assert.equal(same.functionIdentity, true);
  assert.equal(same.weakMapVisible, true);
  assert.equal(same.evaluationCount, 1);
  assert.deepEqual(summarizeTiny([a, a], 1), same);
  const split = summarizeTiny([a, route({ identity: {}, set: new WeakMap() }), a], 2);
  assert.equal(split.objectIdentity, false);
  assert.equal(split.functionIdentity, false);
  assert.equal(split.weakMapVisible, false);
  assert.equal(split.evaluationCount, 2);
});

const evidence = (overrides = {}) => ({
  platform: 'win32', baselineDuplicate: true, addedRoutesPreservedGraph: true,
  actualShared: false, tinyShared: false, normalizedActualShared: true,
  normalizedTinyShared: true, normalizedActualCanonical: true, ...overrides,
});

test('support requires Windows baseline duplication, state loss and targeted closure', () => {
  assert.equal(assessOutcome(evidence()), 'SUPPORTED_FIXTURE_IDENTITY');
  for (const key of ['baselineDuplicate', 'addedRoutesPreservedGraph',
    'normalizedActualShared', 'normalizedTinyShared', 'normalizedActualCanonical']) {
    assert.equal(assessOutcome(evidence({ [key]: false })), 'UNPROVED');
  }
  assert.equal(assessOutcome(evidence({ platform: 'darwin' })), 'UNPROVED_POSIX_ONLY');
});

test('canonical Windows baseline with shared routes and state falsifies identity hypothesis', () => {
  assert.equal(assessOutcome(evidence({ baselineDuplicate: false, actualShared: true,
    tinyShared: true })), 'FALSIFIED_FIXTURE_IDENTITY');
  assert.equal(assessOutcome(evidence({ baselineDuplicate: false, actualShared: true,
    tinyShared: true, addedRoutesPreservedGraph: false })), 'UNPROVED');
});
