// Loaded only by the test launch's CLI --require, before the real app entry.
// oxlint-disable typescript/no-require-imports -- Synchronous Node --require preload.
const {
  existsSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
} = require('node:fs');
const { basename, dirname } = require('node:path');

const { app, BrowserWindow } = require('electron');

const factsPath = process.env.PEAR_TEST_STARTUP_FACTS;
if (process.type !== 'browser' || !factsPath) {
  throw new Error(
    'Startup observer requires a test-owned main-process facts path',
  );
}

let published = false;

function capture(refresh = false) {
  if ((!refresh && published) || !app.isReady()) return;
  const visibleWindow = BrowserWindow.getAllWindows().some(
    (window) => !window.isDestroyed() && window.isVisible(),
  );
  if (!refresh && !visibleWindow) return;
  const facts = {
    pid: process.pid,
    userData: app.getPath('userData'),
    visibleWindow,
  };
  const temporary = `${factsPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(facts), { flag: 'wx' });
  renameSync(temporary, factsPath);
  published = true;
  return true;
}

app.on('browser-window-created', (_event, window) => {
  window.on('show', () => capture());
  capture();
});
app.whenReady().then(() => capture());

// A request after public page readiness samples current native state. Removing
// it acknowledges that the atomic facts publication has completed.
const requestPath = `${factsPath}.request`;
watch(dirname(factsPath), (_event, filename) => {
  if (String(filename) !== basename(requestPath) || !existsSync(requestPath))
    return;
  if (capture(true)) unlinkSync(requestPath);
});
