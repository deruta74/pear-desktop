// Source-only diagnostic: no application startup, fixture hooks or child processes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'source-module-identity-result.json');
const sourceCommit = '7af9a022dc06fe674e7f199575cddff4be399c23';
const sourceTree = 'a458015c6b540b480cf3c2b08006543780260db6';
// Digest of sorted relative source filenames and their byte hashes in the
// unchanged public fixture graph. ID spellings are NOT canonicalized in graph
// observations; slashes are canonicalized only for this file-content binding.
const expectedSourceGraphSha256 = '905564e9a9256ae1a6b7267b7a95a0f0139ed4c322359e4b11bdaaf31b98a933';
const sourceHashes = Object.freeze({
  'tests/helpers/filter-bundle.ts': '1043184db4653a9d9162bbb6b9b3eaa42d77577bb8fb53c2f724b9457a403518',
  'src/providers/music-actions.ts': 'fdd727a6382d3d4d138fca36f649fd6bca3ab3fde0bc03489ec0feebb4aa5cd4',
  'src/providers/playback-owner.ts': '86cfbf6d5f3444e1cd494f83cd533fe2bf9d83c0723c77b4af3cc8b4d4900cdd',
  'src/plugins/utils/renderer/playback-filter.ts': 'b67273d283781ffc63af7e2b0d1e567dc1b375527b20704b5b715c3e111e601d',
  'package.json': '5abad56df6cb88c0e3f5750db206b66029d1764bcef3472ab8d94f2cdbefa677',
  'pnpm-lock.yaml': '3ed6dfde1bf9f12bab158c790176223bc275afb27eee8aa377b62f79ea3d745c',
});
const targets = Object.freeze({
  musicActions: ['src/providers/music-actions.ts', 'getMusicActionsOwner'],
  playbackOwner: ['src/providers/playback-owner.ts', 'adoptPlaybackOwner'],
  playbackFilter: ['src/plugins/utils/renderer/playback-filter.ts', 'createPlaybackFilter'],
});
const slash = (value) => value.replaceAll('\\', '/');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const shared = (values) => values.every((value) => value === values[0]);
const styles = (ids) => [...new Set(ids.map((id) =>
  id.includes('\\') ? (id.includes('/') ? 'MIXED' : 'BACKSLASH') : 'FORWARD_SLASH'))].sort();

export function summarizeTiny(routes, evaluationCount) {
  assert.ok(routes.length === 2 || routes.length === 3);
  for (const route of routes) {
    assert.equal(typeof route.put, 'function');
    assert.equal(typeof route.get, 'function');
    assert.equal(typeof route.identity, 'object');
  }
  const key = {}, value = {};
  routes[0].put(key, value);
  return {
    objectIdentity: shared(routes.map((route) => route.identity)),
    functionIdentity: shared(routes.map((route) => route.get)) && shared(routes.map((route) => route.put)),
    weakMapVisible: routes.every((route) => route.get(key) === value),
    evaluationCount,
  };
}

export function assessOutcome(e) {
  if (e.platform !== 'win32') return 'UNPROVED_POSIX_ONLY';
  if (!e.addedRoutesPreservedGraph) return 'UNPROVED';
  if (!e.baselineDuplicate && e.actualShared && e.tinyShared)
    return 'FALSIFIED_FIXTURE_IDENTITY';
  if (e.baselineDuplicate && !e.actualShared && !e.tinyShared &&
      e.normalizedActualShared && e.normalizedTinyShared && e.normalizedActualCanonical)
    return 'SUPPORTED_FIXTURE_IDENTITY';
  return 'UNPROVED';
}

export function relativeSpecifier(entry, target, pathApi = path) {
  const relative = pathApi.relative(pathApi.dirname(entry), target);
  if (pathApi.isAbsolute(relative)) return null;
  const id = slash(relative);
  return id.startsWith('.') ? id : `./${id}`;
}

function routeExports(base, entry, mode, tiny = false, primaryKeys = []) {
  const specifications = tiny ? { tiny: ['src/probe-state.ts', '*'] } : targets;
  const lines = [];
  let routeIndices = mode === 'primary' ? [0, 1] : null;
  let relativeRoute = mode === 'primary' ? 'SKIPPED_PRIMARY' : 'NOT_USED';
  for (const [key, [relative, symbol]] of Object.entries(specifications)) {
    if (mode === 'primary' && !primaryKeys.includes(key)) continue;
    const absolute = path.join(base, relative);
    // On Windows OS TEMP and checkout can be on different drives. Such a
    // path is absolute, not a relative route: never invent './D:/...'.
    const relativeId = relativeSpecifier(entry, absolute);
    const relativeAvailable = relativeId !== null;
    const ids = [absolute, `@/${relative.slice(4, -3)}`, relativeId];
    if (mode === 'explicit') ids.fill(absolute);
    if (mode === 'alias') ids.fill(ids[1]);
    if (mode === 'posix') ids[0] = slash(absolute);
    if (mode === 'split') {
      ids[1] = path.join(base, 'src/probe-state-b.ts');
      ids[2] = path.join(base, 'src/probe-state-c.ts');
    }
    if (mode === 'primary') ids.length = 2;
    if (['mixed', 'posix'].includes(mode))
      relativeRoute = relativeAvailable ? 'AVAILABLE' : 'SKIPPED_CROSS_DRIVE';
    const indices = ids.flatMap((id, index) => id === null ? [] : [index]);
    if (routeIndices) assert.deepEqual(indices, routeIndices);
    else routeIndices = indices;
    ids.forEach((id, index) => {
      if (id !== null) lines.push(tiny
        ? `export * as ${key}${index} from ${JSON.stringify(id)};`
        : `export {${symbol} as ${key}${index}} from ${JSON.stringify(id)};`);
    });
  }
  return { source: lines.join('\n'), routeIndices, relativeRoute };
}

function evaluate(code, tiny, primaryKeys, routeIndices) {
  // The source graph has been checked before this point. No host require,
  // process, environment, timers, network or DOM is supplied to this VM.
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  vm.runInContext(`globalThis.__probeEvaluations=0;
    globalThis.__probeCryptoCalls=0;
    globalThis.crypto=Object.freeze({getRandomValues(array){
      globalThis.__probeCryptoCalls++;
      for(let i=0;i<array.length;i++)array[i]=(i+globalThis.__probeCryptoCalls)%256;
      return array;
    }});`, context, { timeout: 1000 });
  vm.runInContext(code, context, { timeout: 5000 });
  const fixture = context.FilterFixture;
  assert.ok(fixture && typeof fixture === 'object');
  if (tiny) return summarizeTiny(routeIndices.map((i) => fixture[`tiny${i}`]), context.__probeEvaluations);
  const result = { functionIdentity: {}, playbackOwnerEvaluationCount: context.__probeCryptoCalls,
    weakMapVisibility: 'NOT_INVOKED' };
  for (const key of Object.keys(targets)) {
    if (primaryKeys && !primaryKeys.includes(key)) {
      result.functionIdentity[key] = null;
      continue;
    }
    const functions = routeIndices.map((i) => fixture[`${key}${i}`]);
    assert.ok(functions.every((fn) => typeof fn === 'function'));
    result.functionIdentity[key] = shared(functions);
  }
  return result;
}

async function main() {
  const report = {
    schema: 1, status: 'PROBE_UNAVAILABLE', phase: 'PREFLIGHT',
    platform: ['darwin', 'linux', 'win32'].includes(process.platform) ? process.platform : 'OTHER',
    node: process.versions.node === '24.22.0' ? '24.22.0' : 'UNEXPECTED',
    sourceCommit, sourceTree, sourceHashes, vite: '8.1.0', rolldown: '1.1.3',
    expectedSourceGraphSha256,
    sourceNoteSha256: '64a30318b52b28c0631d12d75616c73448eebb2a8dd0afd577120d7883967189',
    outcome: 'UNPROVED', failure: 'NONE', runs: [],
  };
  let owned;
  const bridgeKey = Symbol.for('pear.source-module-identity.build');
  try {
    assert.equal(report.node, '24.22.0');
    assert.notEqual(report.platform, 'OTHER');
    for (const [file, hash] of Object.entries(sourceHashes))
      assert.equal(digest(await readFile(path.join(root, file))), hash);
    const { version: viteVersion } = JSON.parse(await readFile(path.join(root, 'node_modules/vite/package.json')));
    // pnpm keeps Rolldown under Vite's dependency tree, not at repository root.
    // This resolver only locates package metadata; it is never supplied to VM.
    const viteRequire = createRequire(import.meta.resolve('vite'));
    const { version: rolldownVersion } = JSON.parse(await readFile(viteRequire.resolve('rolldown/package.json')));
    assert.equal(viteVersion, report.vite);
    assert.equal(rolldownVersion, report.rolldown);
    const { build } = await import('vite');
    owned = await mkdtemp(path.join(root, '.source-module-identity-'));
    const wrapper = path.join(owned, 'vite-wrapper.mjs');
    await writeFile(wrapper, `export const build=globalThis[Symbol.for('pear.source-module-identity.build')];`);
    const helperSource = await readFile(path.join(root, 'tests/helpers/filter-bundle.ts'), 'utf8');
    const importLine = "import { build } from 'vite';";
    assert.equal(helperSource.split(importLine).length, 2);
    const adaptedHelper = helperSource.replace(importLine, `import { build } from ${JSON.stringify(pathToFileURL(wrapper).href)};`);
    const helperPath = path.join(owned, 'filter-bundle.mjs');
    await writeFile(helperPath, adaptedHelper);
    report.helperAdaptation = 'VITE_IMPORT_ONLY';
    report.helperAdaptedSha256 = digest(adaptedHelper);
    let active;
    globalThis[bridgeKey] = async (config) => {
      const run = active;
      const entry = config.build.lib.entry;
      // macOS /var is a symlink. This is an observer allowlist comparison only;
      // neither spelling is returned to the resolver or used to merge graph IDs.
      const physicalEntry = slash(await realpath(entry));
      run.entrySource = await readFile(entry, 'utf8');
      run.physicalEntry = physicalEntry;
      if (run.tiny || run.routes) {
        const original = run.tiny ? '' : await readFile(entry, 'utf8');
        const routes = routeExports(config.root, physicalEntry, run.mode, run.tiny, run.primaryKeys);
        run.routeIndices = routes.routeIndices;
        run.relativeRoute = routes.relativeRoute;
        await writeFile(entry, `${original}\n${routes.source}`);
      }
      // Only these labelled controls alter resolution. The baseline plugin's
      // resolveId/load functions are never edited or replaced in baseline runs.
      if (run.normalize) {
        const plugin = config.plugins[0], original = plugin.resolveId;
        plugin.resolveId = function (...args) {
          const id = original.apply(this, args);
          return typeof id === 'string' && !id.startsWith('\0') ? slash(id) : id;
        };
      }
      if (run.builtin) {
        assert.equal(run.tiny, true);
        config.plugins = [];
        config.resolve = { alias: { '@': slash(path.join(config.root, 'src')) } };
      }
      config.plugins.push({
        name: 'source-module-identity-read-only',
        generateBundle() {
          run.ids = [...this.getModuleIds()].sort();
          run.edges = new Map();
          for (const id of run.ids) {
            const info = this.getModuleInfo(id);
            assert.ok(info);
            assert.notEqual(info.isExternal, true);
            assert.ok(Array.isArray(info.importedIds));
            run.edges.set(id, [...info.importedIds]);
            if (id.startsWith('\0')) {
              assert.ok(['\0@/utils', '\0@/i18n', '\0@/providers/song-info-front',
                '\0custom-electron-prompt', '\0@/providers/prompt-options'].includes(id) || id.startsWith('\0style:'));
            } else {
              const canonical = slash(id);
              assert.ok(canonical === slash(entry) || canonical === physicalEntry || canonical.startsWith(`${slash(config.root)}/src/`));
              assert.ok(!/\/src\/index\.[cm]?[jt]sx?$/.test(canonical));
            }
          }
        },
      });
      return build(config);
    };
    const { filterBundle } = await import(pathToFileURL(helperPath).href);
    const tinyRoot = path.join(owned, 'tiny');
    await mkdir(path.join(tinyRoot, 'src'), { recursive: true });
    const tinySource = `globalThis.__probeEvaluations++;
      export const identity={}; const state=new WeakMap();
      export const put=(key,value)=>state.set(key,value);
      export const get=key=>state.get(key);`;
    for (const file of ['probe-state.ts', 'probe-state-b.ts', 'probe-state-c.ts'])
      await writeFile(path.join(tinyRoot, 'src', file), tinySource);
    async function run(phase, options = {}) {
      report.phase = phase;
      active = { mode: 'mixed', ...options };
      const base = active.tiny ? tinyRoot : root;
      const code = await filterBundle(base);
      assert.ok(active.ids?.length);
      const sourceIds = active.ids.filter((id) => !id.startsWith('\0') && slash(id).startsWith(`${slash(base)}/src/`));
      const styleFiles = active.ids.filter((id) => id.startsWith('\0style:'))
        .map((id) => slash(id.slice(7, -3)));
      const sourceFiles = [...new Set([...sourceIds.map(slash), ...styleFiles])].sort();
      const bindings = await Promise.all(sourceFiles.map(async (file) =>
        `${slash(path.relative(base, file))}\0${digest(await readFile(file))}`));
      const sourceGraphSha256 = digest(bindings.join('\n'));
      if (!active.tiny) assert.equal(sourceGraphSha256, expectedSourceGraphSha256);
      const targetIds = {};
      const graph = {};
      const definitions = active.tiny ? { tiny: ['src/probe-state.ts'] } : targets;
      for (const [key, [relative]] of Object.entries(definitions)) {
        const target = slash(path.join(base, relative));
        const ids = active.ids.filter((id) => slash(id) === target);
        assert.ok(ids.length > 0);
        targetIds[key] = ids;
        graph[key] = { moduleCount: ids.length, spellingStyles: styles(ids) };
      }
      const record = { phase, moduleCount: active.ids.length, graph, sourceGraphSha256,
        relativeRoute: active.relativeRoute ?? 'NOT_ADDED',
        identity: active.tiny || active.routes ? evaluate(code, !!active.tiny, active.primaryKeys, active.routeIndices) : null };
      report.runs.push(record);
      return { targetIds, record, edges: active.edges, entrySource: active.entrySource,
        physicalEntry: active.physicalEntry, sourceIds: active.ids.filter((id) =>
        id.startsWith('\0') || slash(id).startsWith(`${slash(base)}/src/`)) };
    }
    // Observe the unchanged actual fixture before introducing any probe imports.
    const baseline = await run('ACTUAL_BASELINE');
    const primaryKeys = [];
    report.primaryCoverage = {};
    // Fixed pinned runtime imports: no new relative consumer or previously
    // unused symbol route is invented for PRIMARY. SECONDARY retains coverage.
    const aliasConsumers = {
      musicActions: ['src/plugins/utils/renderer/playback-filter.ts',
        "import { getMusicActionsOwner } from '@/providers/music-actions';"],
      playbackFilter: ['src/plugins/blocklist/index.ts',
        "import { createPlaybackFilter } from '@/plugins/utils/renderer/playback-filter';"],
    };
    for (const [key, [relative, symbol]] of Object.entries(targets)) {
      const target = slash(path.join(root, relative));
      const hasEdge = (importer) => [...baseline.edges].some(([id, imports]) =>
        slash(id) === importer && imports.some((imported) => slash(imported) === target));
      const absolute = baseline.entrySource.includes(symbol) && hasEdge(baseline.physicalEntry);
      let alias = false;
      if (aliasConsumers[key]) {
        const [consumer, exactImport] = aliasConsumers[key];
        alias = (await readFile(path.join(root, consumer), 'utf8')).includes(exactImport) &&
          hasEdge(slash(path.join(root, consumer)));
      }
      report.primaryCoverage[key] = {
        absolute: absolute ? 'OBSERVED' : 'SKIPPED',
        alias: alias ? 'OBSERVED' : 'SKIPPED', relative: 'SKIPPED',
      };
      if (absolute && alias) primaryKeys.push(key);
    }
    const primary = await run('ACTUAL_PRIMARY_ROUTES', { routes: true, mode: 'primary', primaryKeys });
    const actual = await run('ACTUAL_ROUTES', { routes: true });
    const addedRoutesPreservedGraph = JSON.stringify(baseline.sourceIds) === JSON.stringify(actual.sourceIds);
    const tiny = await run('TINY_BASELINE', { tiny: true });
    const controls = [];
    controls.push(await run('TINY_ALL_EXPLICIT', { tiny: true, mode: 'explicit' }));
    controls.push(await run('TINY_ALL_ALIAS', { tiny: true, mode: 'alias' }));
    controls.push(await run('TINY_BUILTIN_ALIAS', { tiny: true, builtin: true }));
    await run('TINY_POSIX_SPECIFIERS', { tiny: true, mode: 'posix' });
    const split = await run('TINY_DETECTOR_SPLIT', { tiny: true, mode: 'split' });
    for (const control of controls) assert.deepEqual(control.record.identity, {
      objectIdentity: true, functionIdentity: true, weakMapVisible: true, evaluationCount: 1,
    });
    assert.deepEqual(split.record.identity, {
      objectIdentity: false, functionIdentity: false, weakMapVisible: false, evaluationCount: 3,
    });
    // This single-return-value counterfactual follows every unchanged baseline.
    const normalized = await run('ACTUAL_NORMALIZED_RETURN', { routes: true, normalize: true });
    const normalizedTiny = await run('TINY_NORMALIZED_RETURN', { tiny: true, normalize: true });
    const actualShared = (result) => Object.values(result.record.identity.functionIdentity).every(Boolean);
    const tinyShared = (result) => result.record.identity.objectIdentity && result.record.identity.functionIdentity &&
      result.record.identity.weakMapVisible && result.record.identity.evaluationCount === 1;
    report.evidence = {
      platform: report.platform,
      baselineDuplicate: Object.values(baseline.record.graph).some((item) => item.moduleCount > 1),
      addedRoutesPreservedGraph, actualShared: actualShared(actual), tinyShared: tinyShared(tiny),
      normalizedActualShared: actualShared(normalized), normalizedTinyShared: tinyShared(normalizedTiny),
      normalizedActualCanonical: Object.values(normalized.record.graph).every((item) => item.moduleCount === 1),
    };
    report.outcome = assessOutcome(report.evidence);
    report.primaryEvidence = {
      platform: report.platform,
      baselineDuplicate: primaryKeys.some((key) => baseline.record.graph[key].moduleCount > 1),
      addedRoutesPreservedGraph: primaryKeys.length > 0 &&
        JSON.stringify(baseline.sourceIds) === JSON.stringify(primary.sourceIds),
      actualShared: primaryKeys.length > 0 && primaryKeys.every((key) => primary.record.identity.functionIdentity[key]),
      tinyShared: tinyShared(tiny),
      normalizedActualShared: primaryKeys.length > 0 &&
        primaryKeys.every((key) => normalized.record.identity.functionIdentity[key]),
      normalizedTinyShared: tinyShared(normalizedTiny),
      normalizedActualCanonical: primaryKeys.length > 0 &&
        primaryKeys.every((key) => normalized.record.graph[key].moduleCount === 1),
    };
    report.primaryOutcome = assessOutcome(report.primaryEvidence);
    report.phase = 'COMPLETE';
    report.status = 'PASS_PROBE_EXECUTED';
  } catch {
    // Raw paths/errors/stacks/environment and tool exceptions never enter output.
    report.failure = report.phase === 'PREFLIGHT' ? 'PIN_OR_DEPENDENCY_UNAVAILABLE' : 'BUILD_VM_OR_CONTRACT_FAILED';
    process.exitCode = 1;
  } finally {
    delete globalThis[bridgeKey];
    if (owned) {
      try { await rm(owned, { recursive: true, force: true }); }
      catch { report.status = 'PROBE_UNAVAILABLE'; report.failure = 'OWNED_TEMP_CLEANUP_FAILED'; process.exitCode = 1; }
    }
    const json = `${JSON.stringify(report, null, 2)}\n`;
    assert.ok(Buffer.byteLength(json) <= 65536);
    await writeFile(output, json);
    process.stdout.write(`${report.status} ${report.phase} ${report.outcome}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
