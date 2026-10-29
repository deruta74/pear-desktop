'use strict';
// Public hosted-tool measurements only. Importing this module performs no collection.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const LIMITS = Object.freeze({ entries: 30000, file: 64 * 1024 * 1024, total: 256 * 1024 * 1024, ms: 60000 });
const fail = () => { throw Error('OBSERVATION_UNPROVEN'); };
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const bytewise = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
async function read(file, limit) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > limit) fail();
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) fail();
      offset += bytesRead;
    }
    if ((await handle.stat()).size !== data.length) fail();
    return data;
  } finally { await handle.close(); }
}
const defaultIO = {
  path, now: Date.now, realpath: fs.realpath, readdir: fs.readdir, read, hash,
  stat: async (file) => {
    const stat = await fs.lstat(file);
    return { kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', size: stat.size };
  },
};
// Record format, ordering and symlink handling match the accepted carrier scanTree.
async function scanTree(roots, limits = LIMITS, io = defaultIO) {
  const records = [], seen = new Map(), start = io.now(); let entries = 0, files = 0, bytes = 0;
  const rootRows = Object.entries(roots).sort(([a], [b]) => bytewise(a, b));
  const locate = (file) => { const row = rootRows.find(([, root]) => inside(root, file)); if (!row) fail(); return row[0] + (file === row[1] ? '' : '/' + io.path.relative(row[1], file)); };
  const pending = rootRows.map(([label, root]) => [root, label, true]);
  while (pending.length) {
    if (io.now() - start > limits.ms) fail();
    const [file, label, isRoot] = pending.pop(), stat = await io.stat(file);
    if (!isRoot && ++entries > limits.entries) fail();
    const canonical = await io.realpath(file); locate(canonical);
    if (stat.kind === 'symlink') { records.push([label, 'symlink', locate(canonical)]); continue; }
    if (canonical !== file) fail();
    if (stat.kind === 'directory') {
      const names = await io.readdir(file);
      if (!Array.isArray(names) || names.length > limits.entries || names.some((n) => typeof n !== 'string' || !n || /[\\/\x00-\x1f]/.test(n) || n === '.' || n === '..')) fail();
      for (const name of names.sort(bytewise).reverse()) pending.push([io.path.join(file, name), label + '/' + name, false]);
    } else if (stat.kind === 'file') {
      if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > limits.file) fail();
      if (seen.has(canonical)) { records.push([label, 'reference', seen.get(canonical)]); continue; }
      if (bytes + stat.size > limits.total) fail();
      const data = await io.read(file, limits.file);
      if (data.length !== stat.size) fail();
      bytes += data.length; files++; seen.set(canonical, label); records.push([label, 'file', io.hash(data)]);
    } else fail();
  }
  if (io.now() - start > limits.ms) fail();
  records.sort((a, b) => bytewise(a[0], b[0]));
  return { sha256: io.hash(Buffer.from(JSON.stringify(records))), entries, files, bytes };
}
async function measureTree(root) {
  let timer;
  try {
    return await Promise.race([scanTree({ pnpm: root }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('OBSERVATION_UNPROVEN')), LIMITS.ms); })]);
  } finally { clearTimeout(timer); }
}
function publicText(value, max = 1024) {
  if (typeof value !== 'string' || !value || value.length > max || /[^\x20-\x7e]/.test(value)) fail();
  return value;
}
async function resolvePnpm(commandPath, dest, binDest) {
  for (const value of [commandPath, dest, binDest]) {
    publicText(value);
    if (!path.isAbsolute(value) || path.resolve(value) !== value) fail();
  }
  if (binDest !== path.join(dest, 'node_modules', '.bin') || commandPath !== path.join(binDest, 'pnpm')) fail();
  const destination = publicText(await fs.realpath(dest)), binDestination = publicText(await fs.realpath(binDest));
  if (binDestination !== path.join(destination, 'node_modules', '.bin')) fail();
  const canonicalCommandPath = publicText(await fs.realpath(commandPath));
  if (!inside(destination, canonicalCommandPath) || !(await fs.stat(canonicalCommandPath)).isFile()) fail();
  const packageRoot = publicText(await fs.realpath(path.join(dest, 'node_modules', 'pnpm')));
  if (!inside(destination, packageRoot) || !(await fs.stat(packageRoot)).isDirectory()) fail();
  const canonicalEntryPath = publicText(await fs.realpath(path.join(packageRoot, 'bin', 'pnpm.cjs')));
  if (canonicalEntryPath !== path.join(packageRoot, 'bin', 'pnpm.cjs')) fail();
  const manifestPath = path.join(packageRoot, 'package.json');
  if (await fs.realpath(manifestPath) !== manifestPath) fail();
  const manifest = JSON.parse(await read(manifestPath, 1024 * 1024));
  if (manifest.name !== 'pnpm' || manifest.version !== '11.28.6') fail();
  return { version: manifest.version, commandPath, canonicalCommandPath, destination, binDestination, packageRoot, canonicalEntryPath };
}
async function collect() {
  if (!((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64')) ||
      process.platform !== process.env.OBSERVE_PLATFORM || process.arch !== process.env.OBSERVE_ARCH || process.version !== 'v24.22.0') fail();
  const image = { ImageOS: publicText(process.env.ImageOS, 128), ImageVersion: publicText(process.env.ImageVersion, 128) };
  const nodePath = publicText(process.execPath), nodeCanonicalPath = publicText(await fs.realpath(nodePath));
  // Resolve the provisioned command without executing pnpm or any project code.
  const commandPath = publicText(execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', 'command -v pnpm'], { encoding: 'utf8', timeout: 5000, maxBuffer: 2048, stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  // The action exposes a shell shim; derive the package entry from its explicit outputs.
  const pnpm = await resolvePnpm(commandPath, process.env.OBSERVE_PNPM_DEST, process.env.OBSERVE_PNPM_BIN_DEST);
  return {
    schemaVersion: 1, status: 'observed', platform: process.platform, arch: process.arch, image,
    node: { version: process.version, execPath: nodePath, canonicalPath: nodeCanonicalPath, sha256: hash(await read(nodeCanonicalPath, 256 * 1024 * 1024)) },
    pnpm: { ...pnpm, entrySHA256: hash(await read(pnpm.canonicalEntryPath, LIMITS.file)), packageClosure: await measureTree(pnpm.packageRoot) },
  };
}
async function main() {
  let receipt;
  try { receipt = await collect(); }
  catch { receipt = { schemaVersion: 1, status: 'failed', code: 'OBSERVATION_UNPROVEN' }; process.exitCode = 1; }
  await fs.mkdir('posix-tool-observation', { recursive: true });
  await fs.writeFile('posix-tool-observation/result.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(receipt.status === 'observed' ? 'Public tool receipt written.' : 'Tool observation failed; no raw diagnostics emitted.');
}
module.exports = { scanTree, defaultIO, LIMITS, resolvePnpm };
if (require.main === module) main().catch(() => { console.error('Tool receipt could not be written.'); process.exitCode = 1; });
