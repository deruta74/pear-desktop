'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { scanTree, defaultIO, LIMITS, resolvePnpm } = require('./observe-posix-tools.cjs');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'posix-tools-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('closure hashes bytewise sorted file and internal symlink records', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'bin'));
  await fs.writeFile(path.join(root, 'z'), 'z');
  await fs.writeFile(path.join(root, 'bin', 'a'), 'abc');
  await fs.symlink('bin/a', path.join(root, 'link'));
  await fs.writeFile(path.join(root, 'ä'), 'a');
  const records = [['pnpm/bin/a', 'file', hash('abc')], ['pnpm/link', 'symlink', 'pnpm/bin/a'], ['pnpm/z', 'file', hash('z')], ['pnpm/ä', 'file', hash('a')]];
  assert.deepEqual(await scanTree({ pnpm: root }), { sha256: hash(JSON.stringify(records)), entries: 5, files: 3, bytes: 5 });
});

test('closure rejects symlinks outside the measured package', async (t) => {
  const root = await fixture(t);
  await fs.symlink(os.tmpdir(), path.join(root, 'escape'));
  await assert.rejects(scanTree({ pnpm: root }), /OBSERVATION_UNPROVEN/);
});

test('closure rejects entry, file, total byte and elapsed time overruns', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'a'), 'abc');
  for (const limits of [{ entries: 0 }, { file: 2 }, { total: 2 }]) {
    await assert.rejects(scanTree({ pnpm: root }, { ...LIMITS, ...limits }), /OBSERVATION_UNPROVEN/);
  }
  let clock = 0;
  await assert.rejects(scanTree({ pnpm: root }, LIMITS, { ...defaultIO, now: () => clock++ * 60001 }), /OBSERVATION_UNPROVEN/);
});

test('closure rejects noncanonical roots and does not follow symlink directories', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'dir'));
  await fs.writeFile(path.join(root, 'dir', 'a'), 'a');
  await fs.symlink('dir', path.join(root, 'alias'));
  const result = await scanTree({ pnpm: root });
  assert.equal(result.files, 1);
  assert.equal(result.entries, 3);
  await assert.rejects(scanTree({ pnpm: path.join(root, 'alias') }), /OBSERVATION_UNPROVEN/);
});

test('closure rejects ambiguous filename separators and control characters', async (t) => {
  for (const name of ['bad\\name', 'bad\x01name']) {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, name), 'a');
    await assert.rejects(scanTree({ pnpm: root }), /OBSERVATION_UNPROVEN/);
  }
});

async function shimLayout(t) {
  const root = await fixture(t), dest = path.join(root, 'setup-pnpm');
  const binDest = path.join(dest, 'node_modules', '.bin');
  const packageRoot = path.join(dest, 'node_modules', '.pnpm', 'pnpm@11.28.6', 'node_modules', 'pnpm');
  await fs.mkdir(path.join(packageRoot, 'bin'), { recursive: true });
  await fs.mkdir(binDest, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'pnpm', version: '11.28.6' }));
  await fs.writeFile(path.join(packageRoot, 'bin', 'pnpm.cjs'), 'data-only entry');
  await fs.symlink('.pnpm/pnpm@11.28.6/node_modules/pnpm', path.join(dest, 'node_modules', 'pnpm'));
  const commandPath = path.join(binDest, 'pnpm');
  await fs.writeFile(commandPath, '#!/bin/sh\nexit 97\n');
  return { root, dest, binDest, commandPath, packageRoot };
}

test('action shell shim resolves separately from the canonical isolated package entry without execution', async (t) => {
  const { dest, binDest, commandPath, packageRoot } = await shimLayout(t);
  assert.equal(await fs.realpath(commandPath), commandPath);
  assert.deepEqual(await resolvePnpm(commandPath, dest, binDest), {
    version: '11.28.6', commandPath, canonicalCommandPath: commandPath,
    destination: dest, binDestination: binDest, packageRoot,
    canonicalEntryPath: path.join(packageRoot, 'bin', 'pnpm.cjs'),
  });
});

test('action layout rejects a foreign command, mismatched destination and wrong package version', async (t) => {
  const { root, dest, binDest, commandPath, packageRoot } = await shimLayout(t);
  await assert.rejects(resolvePnpm(path.join(root, 'pnpm'), dest, binDest), /OBSERVATION_UNPROVEN/);
  await assert.rejects(resolvePnpm(commandPath, path.join(root, 'foreign'), binDest), /OBSERVATION_UNPROVEN/);
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'pnpm', version: '11.28.9' }));
  await assert.rejects(resolvePnpm(commandPath, dest, binDest), /OBSERVATION_UNPROVEN/);
});

test('action layout rejects command and package symlinks escaping the action destination', async (t) => {
  const layout = await shimLayout(t);
  const outside = path.join(layout.root, 'foreign');
  await fs.writeFile(outside, 'outside');
  await fs.unlink(layout.commandPath);
  await fs.symlink(outside, layout.commandPath);
  await assert.rejects(resolvePnpm(layout.commandPath, layout.dest, layout.binDest), /OBSERVATION_UNPROVEN/);
  await fs.unlink(layout.commandPath);
  await fs.writeFile(layout.commandPath, 'shim');
  await fs.unlink(path.join(layout.dest, 'node_modules', 'pnpm'));
  await fs.symlink(layout.root, path.join(layout.dest, 'node_modules', 'pnpm'));
  await assert.rejects(resolvePnpm(layout.commandPath, layout.dest, layout.binDest), /OBSERVATION_UNPROVEN/);
});
