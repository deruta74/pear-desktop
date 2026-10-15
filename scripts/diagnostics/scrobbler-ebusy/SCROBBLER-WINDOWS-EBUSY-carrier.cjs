'use strict';

// Host Node only. This script NEVER loads the preload itself: NODE_OPTIONS
// must already have loaded the exact canonical report-owned preload.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const expectedKeys = ['--expected-exit', '--node-major', '--preload', '--literal', '--literal-backslash', '--grep', '--output'];
assert.equal(args.length, expectedKeys.length * 2);
for (let i = 0; i < expectedKeys.length; i++) assert.equal(args[i * 2], expectedKeys[i]);
const values = Object.fromEntries(expectedKeys.map((key, i) => [key, args[i * 2 + 1]]));
const code = Number(values['--expected-exit']);
assert(code === 0 || code === 7);
const expectedMajor = Number(values['--node-major']);
assert(Number.isSafeInteger(expectedMajor) && expectedMajor > 0);
assert.equal(Number(process.versions.node.split('.')[0]), expectedMajor);
assert.equal(process.versions.electron, undefined);
assert.equal(values['--literal'], 'owned argument with spaces');
assert.equal(values['--literal-backslash'], 'owned\\argument');
assert.equal(values['--grep'], 'a guestless SSO child load failure while still owned retires authentication$');
const preload = values['--preload'];
assert(path.isAbsolute(preload));
assert(!preload.includes('\\'), 'NODE_OPTIONS carrier uses a forward-slash absolute path');
assert.equal(path.basename(preload), 'SCROBBLER-WINDOWS-EBUSY-preload.cjs');
const resolved = require.resolve(preload); // Resolves only; does not load it.
assert(require.cache[resolved]?.loaded === true, 'exact actual preload already loaded by NODE_OPTIONS');
assert.equal(fs.realpathSync(resolved), fs.realpathSync(preload));
const report = process.env.PEAR_EBUSY_REPORT_ROOT;
assert(report && path.isAbsolute(report));
assert.equal(values['--output'], path.join(report, 'playwright-output'));
assert.equal(fs.realpathSync(path.dirname(preload)), fs.realpathSync(report));
const log = path.join(report, `worker-${process.pid}.jsonl`);
const first = JSON.parse(fs.readFileSync(log, 'utf8').split('\n')[0]);
assert.equal(first.event, 'preload-ready');
assert.equal(first.hostPid, process.pid);
assert.equal(first.nodeVersion, process.versions.node);
assert(!fs.existsSync(path.join(report, `worker-${process.pid}.diagnostic-error`)));
const trace = { schema: 1, mode: 'host-node-carrier-only', healthy: true, expectedExit: code,
  nodeVersion: process.versions.node, expectedNodeMajor: expectedMajor, hostPid: process.pid,
  loadedExactPreload: true, preloadRequireCacheKey: resolved, forwardSlashPreloadPath: preload,
  workerReadyObserved: true, literalArgumentMatched: true, backslashLiteralMatched: true, grepArgumentMatched: true, outputArgumentMatched: true,
  nativeFixtureOrElectronStarted: false, rawEnvironmentOrCommandLineDumped: false };
fs.writeFileSync(path.join(report, `host-carrier-${code}.json`), JSON.stringify(trace, null, 2) + '\n');
console.log(JSON.stringify(trace));
process.exitCode = code;
