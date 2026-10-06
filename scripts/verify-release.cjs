// Check the complete official desktop matrix before uploading a release.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const builderRequire = createRequire(require.resolve('electron-builder'));
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const yaml = appBuilderRequire('js-yaml');
const { version } = require('../package.json');
const [mode, directory, destination] = process.argv.slice(2);
const fail = (message) => { throw new Error(message); };
const extensions = /\.(AppImage|dmg|blockmap|freebsd|7z|gz|flatpak|rpm|exe|deb|snap|zip|yml)$/;

if (mode === 'stage') {
  fs.mkdirSync(destination, { recursive: true });
  for (const file of fs.readdirSync(directory)) {
    if (extensions.test(file) && !file.startsWith('builder-') && fs.statSync(path.join(directory, file)).isFile()) {
      fs.copyFileSync(path.join(directory, file), path.join(destination, file));
    }
  }
} else if (mode === 'verify') {
  const expected = [
    'latest-linux-arm.yml', 'latest-linux-arm64.yml', 'latest-linux.yml', 'latest-mac.yml', 'latest.yml',
    `YouTube-Music-${version}-arm64.AppImage`, `YouTube-Music-${version}-arm64.dmg`,
    `YouTube-Music-${version}-arm64.dmg.blockmap`, `youtube-music-${version}-arm64.freebsd`,
    `youtube-music-${version}-arm64.nsis.7z`, `youtube-music-${version}-arm64.tar.gz`,
    `YouTube-Music-${version}-armv7l.AppImage`, `youtube-music-${version}-armv7l.freebsd`,
    `youtube-music-${version}-armv7l.tar.gz`, `youtube-music-${version}-ia32.nsis.7z`,
    `youtube-music-${version}-x64.nsis.7z`, `YouTube-Music-${version}-x86_64.flatpak`,
    `youtube-music-${version}.aarch64.rpm`, `YouTube-Music-${version}.AppImage`,
    `YouTube-Music-${version}.dmg`, `YouTube-Music-${version}.dmg.blockmap`,
    `YouTube-Music-${version}.exe`, `youtube-music-${version}.freebsd`,
    `youtube-music-${version}.tar.gz`, `youtube-music-${version}.x86_64.rpm`,
    `YouTube-Music-Web-Setup-${version}.exe`, `youtube-music_${version}_amd64.deb`,
    `youtube-music_${version}_amd64.snap`, `youtube-music_${version}_arm64.deb`,
    `youtube-music_${version}_armv7l.deb`,
    `YouTube-Music-${version}-mac.zip`, `YouTube-Music-${version}-arm64-mac.zip`,
  ];
  for (const file of expected) {
    const full = path.join(directory, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile() || fs.statSync(full).size === 0) fail(`Missing/empty asset: ${file}`);
  }
  const hash = (file, algorithm, encoding) => new Promise((resolve, reject) => {
    const digest = crypto.createHash(algorithm);
    fs.createReadStream(file).on('error', reject).on('data', chunk => digest.update(chunk))
      .on('end', () => resolve(digest.digest(encoding)));
  });
  const checkFile = async (name, metadata) => {
    if (typeof name !== 'string' || path.basename(name) !== name) fail(`Unsafe updater path: ${name}`);
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) fail(`Updater asset missing: ${name}`);
    if (metadata.size !== undefined && fs.statSync(file).size !== metadata.size) fail(`Size mismatch: ${name}`);
    if (!metadata.sha512 || await hash(file, 'sha512', 'base64') !== metadata.sha512) fail(`SHA512 mismatch: ${name}`);
  };
  (async () => {
    for (const name of expected.filter(file => file.endsWith('.yml'))) {
      const metadata = yaml.load(fs.readFileSync(path.join(directory, name), 'utf8'));
      if (metadata.version !== version || !metadata.files?.length) fail(`Invalid updater metadata: ${name}`);
      for (const file of metadata.files) await checkFile(file.url, file);
      if (metadata.path) await checkFile(metadata.path, metadata);
      for (const info of Object.values(metadata.packages || {})) await checkFile(info.path, info);
    }
    const files = fs.readdirSync(directory).filter(file => extensions.test(file)).sort();
    const sums = [];
    for (const file of files) sums.push(`${await hash(path.join(directory, file), 'sha256', 'hex')}  ${file}`);
    fs.writeFileSync(path.join(directory, 'SHA256SUMS'), sums.join('\n') + '\n');
    console.log(`Validated ${files.length} release files for v${version}`);
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  fail('Usage: verify-release.cjs stage SOURCE DEST | verify DIRECTORY');
}
