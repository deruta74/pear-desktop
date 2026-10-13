import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = '6ea4de0341f45060b279b9c9a1de74024f86c860';
const original = 'tests/api-music-grants.test.ts';
const diagnostic = 'tests/api-music-grants-acl-diagnostic.test.ts';
const allowed = ['.github/workflows/tests.yml', diagnostic, 'scripts/diagnostics/api-grant-acl-windows.mjs'];
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const check = (value, label) => { if (!value) throw Error('Diagnostic integrity check failed: ' + label); };
const titles = ['private atomic ledger has owner permissions digest-only readback and revoke survives reload', 'stale native issue and concurrent revocation transactions do not mint or resurrect grants', 'malformed oversized ledger and non-private file fail closed without replacing it', 'Windows actual ACL rejects outsider-readable cached and fresh ledgers without repairing bytes or ACL'];
const stages = new Set(['script_start', 'input_json_before', 'input_json_after', 'current_sid_before', 'current_sid_after', 'parent_acl_before', 'parent_acl_after', 'parent_set_access_control_before', 'parent_set_access_control_after', 'parent_output_before', 'parent_output_after', 'parent_exit', 'inspect_acl_before', 'inspect_acl_after', 'outsider_set_access_control_before', 'outsider_set_access_control_after', 'inspect_output_before', 'inspect_output_after', 'inspect_exit']);
const local = process.argv.includes('--local-control');
const listing = process.argv.includes('--list-only');
const head = git('rev-parse', 'HEAD');
if (!local) {
  const expected = process.env.EXPECTED_DIAGNOSTIC_HEAD;
  check(typeof expected === 'string' && /^[a-f0-9]{40}$/.test(expected) && expected === head, 'exact requested head');
  check(process.platform === 'win32', 'Windows runner');
}
check(git('merge-base', base, 'HEAD') === base, 'selected base ancestry');
check(git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean).every(file => allowed.includes(file)), 'allowed committed delta');
const text = readFileSync(path.join(root, original), 'utf8');
const copy = readFileSync(path.join(root, diagnostic), 'utf8');
check(hash(text) === '3673e73fa4a402b75bedf9a87dd3f53fe3ed9f15de36843225e9409c3365e150', 'unchanged original');
check(hash(copy) === '1ffc1d2cacb851aa1440140f36e46eba97d2ecdf8d966554c4f3608c8b7c6540', 'frozen diagnostic copy');
check(hash(readFileSync(path.join(root, 'src/plugins/api-server/backend/windows-private-path.ts'))) === '9a7fa09bb4bf162af054b4edfd7d5d3eb6f736ed02c5a03ad08d6aee1f2d86f6', 'unchanged production');
const body = (source, title) => { const start = source.indexOf("test('" + title + "'"); check(start >= 0, 'case title'); const end = source.indexOf("\ntest('", start + 1); return source.slice(start, end < 0 ? undefined : end); };
for (const title of titles) check(body(text, title) === body(copy, title), 'exact case body');
const call = source => { const start = source.indexOf('  const output = execFileSync('); return source.slice(start, source.indexOf('\n  );', start) + 5); };
check(call(text) === call(copy) && hash(call(text)) === '844ed8b8cc8d327cd6f095f8213bf36e08e2ddc6bd80484ff4838804acfb44b2', 'exact command/options/env/input/8000ms');
for (const file of ['tests/api-music-queue.test.ts', 'tests/api-music-queue-native.test.ts']) check(hash(readFileSync(path.join(root, file))) === hash(execFileSync('git', ['show', base + ':' + file], { cwd: root })), 'unchanged Q1 control');
const integrity = { base, head, originalUnchanged: true, productionUnchanged: true, fourBodiesIdentical: true, queueControlsUnchanged: true, timeoutMs: 8000, diagnosticOnly: true };
console.log('ACL_DIAGNOSTIC_INTEGRITY ' + JSON.stringify(integrity));
if (process.argv.includes('--verify-only')) process.exit(0);
check(process.argv.includes('--collect') || local, 'explicit collection');
const directory = path.join(root, 'test-results/windows-grant-acl-diagnostic');
mkdirSync(directory, { recursive: true });
const grep = '(?:' + titles.join('|') + ')$';
const plans = [
  { name: 'unchanged_originals', files: [original], grep, repeat: 2, workers: 1, count: 8 },
  { name: 'instrumented_isolation', files: [diagnostic], grep, repeat: 2, workers: 1, count: 8 },
  { name: 'instrumented_q1_concurrency', files: [diagnostic, 'tests/api-music-queue.test.ts', 'tests/api-music-queue-native.test.ts'], grep: grep + '|api-music-queue(?:-native)?\\.test\\.ts', repeat: 1, workers: 2, count: 38 },
];
function observations(result) {
  const values = [];
  for (const stream of ['stdout', 'stderr']) for (const chunk of result[stream] ?? []) for (const line of (chunk.text ?? '').split(/\r?\n/)) {
    const match = /^(ACL_PHASE|ACL_EXCEPTION) ([a-z_]+) ([0-9]+)$/.exec(line.trim());
    if (match && stages.has(match[2])) values.push({ type: match[1], stage: match[2], elapsedMs: Number(match[3]) });
    if (!line.startsWith('ACL_DIAGNOSTIC ')) continue;
    try {
      const value = JSON.parse(line.slice(15));
      if (!['parent', 'inspect', 'outsider'].includes(value.operation) || !['start', 'complete', 'error'].includes(value.type)) continue;
      const item = { type: value.type, operation: value.operation, call: value.call };
      for (const key of ['elapsedMs', 'timeoutMs', 'status', 'errno']) if (typeof value[key] === 'number' || value[key] === null) item[key] = value[key];
      if (['ETIMEDOUT', 'ENOENT', 'EACCES', 'EIO', 'ENOBUFS', 'OTHER'].includes(value.code)) item.code = value.code;
      if (['SIGTERM', 'SIGKILL', 'SIGINT', null].includes(value.signal)) item.signal = value.signal;
      values.push(item);
    } catch { /* Never persist raw console output. */ }
  }
  return values;
}
function summarize(report, plan) {
  const tests = [];
  const walk = suites => { for (const suite of suites ?? []) { for (const spec of suite.specs ?? []) {
    const queue = plan.name === 'instrumented_q1_concurrency' && /api-music-queue(?:-native)?\.test\.ts$/.test(spec.file);
    check(titles.includes(spec.title) || queue, 'only selected cases');
    for (const test of spec.tests ?? []) {
      if (listing) tests.push({ title: spec.title, control: queue ? 'unchanged_Q1' : 'ACL_case', repeatEachIndex: test.repeatEachIndex, status: 'listed_not_executed' });
      for (const result of test.results ?? []) {
      const errors = (result.errors ?? []).map(error => error.message ?? '').join('\n');
      tests.push({ title: spec.title, control: queue ? 'unchanged_Q1' : 'ACL_case', repeatEachIndex: test.repeatEachIndex, status: result.status, retry: result.retry, startedMs: Date.parse(result.startTime), durationMs: result.duration, failureKind: /ETIMEDOUT/.test(errors) ? 'ETIMEDOUT' : /fixture ACL unavailable/.test(errors) ? 'fixture_acl_unavailable' : errors ? 'other_test_failure' : null, observations: observations(result) });
      }
    }
  } walk(suite.suites); } };
  walk(report.suites);
  const stats = {}; for (const key of ['duration', 'expected', 'unexpected', 'flaky', 'skipped']) if (typeof report.stats?.[key] === 'number') stats[key] = report.stats[key];
  return { stats, selectedResults: tests.length, collectorErrors: report.errors?.length ?? 0, tests };
}
const phases = [];
for (const plan of plans) {
  if (local && !listing && plan.workers === 2) continue; // Windows concurrency is not inferred from Mac controls.
  const started = performance.now();
  const args = ['node_modules/@playwright/test/cli.js', 'test', ...plan.files, '--grep', plan.grep, '--repeat-each=' + plan.repeat, '--workers=' + plan.workers, '--reporter=json', '--output=' + path.join(directory, plan.name)];
  if (listing) args.push('--list');
  const child = spawnSync(process.execPath, args, { cwd: root, env: process.env, encoding: 'utf8', timeout: 1200000, maxBuffer: 32 * 1024 * 1024 });
  const phase = { name: plan.name, exitCode: child.status, signal: child.signal, elapsedMs: Math.round(performance.now() - started), repeatEach: plan.repeat, workers: plan.workers, expectedResults: plan.count, listingOnly: listing, diagnosticOnly: true };
  try { Object.assign(phase, summarize(JSON.parse(child.stdout), plan)); phase.parsed = true; }
  catch { phase.parsed = false; phase.collectorFailure = child.error?.code === 'ETIMEDOUT' ? 'collector_timeout' : 'missing_or_invalid_report'; }
  phases.push(phase);
  writeFileSync(path.join(directory, plan.name + '.safe.json'), JSON.stringify(phase, null, 2) + '\n');
  console.log('ACL_DIAGNOSTIC_PHASE ' + JSON.stringify({ name: phase.name, exitCode: phase.exitCode, parsed: phase.parsed, selectedResults: phase.selectedResults, stats: phase.stats }));
}
const receipt = { mode: listing ? 'listing_only' : local ? 'local_non_windows_control' : 'manual_Windows_diagnostic', integrity, runtime: { platform: process.platform, architecture: process.arch, node: process.version, v8: process.versions.v8, osRelease: os.release() }, phases, noProductionAcceptance: true, noRawOutputOrFullEnvironmentPersisted: true };
writeFileSync(path.join(directory, 'receipt.safe.json'), JSON.stringify(receipt, null, 2) + '\n');
const complete = phases.every(phase => phase.parsed && phase.selectedResults === phase.expectedResults);
console.log('ACL_DIAGNOSTIC_COLLECTION ' + JSON.stringify({ complete, productionAcceptance: false }));
process.exit(complete ? 0 : 1);
