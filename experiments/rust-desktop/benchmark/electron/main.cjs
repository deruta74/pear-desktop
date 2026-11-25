'use strict';

const { app, BrowserWindow } = require('electron');
const { statSync } = require('node:fs');
const { isAbsolute } = require('node:path');

const args = process.argv.slice(2);
const profile = process.env.PEAR_BENCHMARK_DATA_DIR;
if (
  args.length !== 2 ||
  args[0] !== '--benchmark-url' ||
  !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(args[1]) ||
  !profile ||
  !isAbsolute(profile) ||
  !statSync(profile).isDirectory()
) {
  console.error('Launch this Electron host through benchmark.py.');
  process.exit(2);
}
const url = new URL(args[1]).href;

app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.commandLine.appendSwitch('disable-component-update');

let window;
app
  .whenReady()
  .then(async () => {
    window = new BrowserWindow({
      title: 'Pear Desktop Benchmark',
      width: 1200,
      height: 800,
      useContentSize: true,
      show: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, target) => {
      if (target !== url) event.preventDefault();
    });
    window.webContents.once('did-finish-load', () => {
      process.stdout.write('PEAR_READY\n');
    });
    await window.loadURL(url);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

app.on('window-all-closed', () => app.quit());
