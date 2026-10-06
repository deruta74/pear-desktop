const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('stage includes NSIS web outputs while excluding unpacked app files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-release-stage-'));
  try {
    const source = path.join(directory, 'pack');
    const destination = path.join(directory, 'assets');
    fs.mkdirSync(path.join(source, 'nsis-web'), { recursive: true });
    fs.mkdirSync(path.join(source, 'win-unpacked'), { recursive: true });
    fs.writeFileSync(path.join(source, 'YouTube Music 3.12.1.exe'), 'portable');
    fs.writeFileSync(path.join(source, 'nsis-web', 'YouTube Music Web Setup 3.12.1.exe'), 'installer');
    fs.writeFileSync(path.join(source, 'nsis-web', 'latest.yml'), 'metadata');
    fs.writeFileSync(path.join(source, 'nsis-web', 'youtube-music-3.12.1-x64.nsis.7z'), 'payload');
    fs.writeFileSync(path.join(source, 'win-unpacked', 'YouTube Music.exe'), 'application');
    fs.writeFileSync(path.join(source, 'builder-effective-config.yaml'), 'config');
    const result = spawnSync(process.execPath, [path.join(__dirname, 'verify-release.cjs'), 'stage', source, destination]);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.deepEqual(fs.readdirSync(destination).sort(), [
      'YouTube-Music-3.12.1.exe', 'YouTube-Music-Web-Setup-3.12.1.exe',
      'latest.yml', 'youtube-music-3.12.1-x64.nsis.7z',
    ].sort());
    assert.equal(fs.readFileSync(path.join(destination, 'YouTube-Music-Web-Setup-3.12.1.exe'), 'utf8'), 'installer');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stage rejects colliding names across root and NSIS outputs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-release-collision-'));
  try {
    const source = path.join(directory, 'pack');
    fs.mkdirSync(path.join(source, 'nsis-web'), { recursive: true });
    fs.writeFileSync(path.join(source, 'latest.yml'), 'one');
    fs.writeFileSync(path.join(source, 'nsis-web', 'latest.yml'), 'two');
    const result = spawnSync(process.execPath, [path.join(__dirname, 'verify-release.cjs'), 'stage', source, path.join(directory, 'assets')]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.toString(), /Asset name collision/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
