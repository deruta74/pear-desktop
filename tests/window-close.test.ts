import { test, expect } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { setupCloseToHide } from '../src/providers/window-close.ts';

class FixtureWindow extends EventEmitter {
  fullscreen = true;
  destroyed = false;
  hides = 0;
  exits = 0;
  isFullScreen() {
    return this.fullscreen;
  }
  isDestroyed() {
    return this.destroyed;
  }
  hide() {
    this.hides++;
  }
  setFullScreen(value: boolean) {
    this.exits++;
    this.fullscreen = value;
  }
  close() {
    let prevented = false;
    this.emit('close', {
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  }
}

test('fullscreen close exits once and hides after leaving fullscreen', () => {
  test.skip(process.platform !== 'darwin', 'macOS fullscreen Spaces');
  const app = new EventEmitter();
  const win = new FixtureWindow();
  setupCloseToHide(app as never, win as never);
  expect(win.close()).toBe(true);
  expect(win.exits).toBe(1);
  expect(win.hides).toBe(0);
  expect(win.close()).toBe(true);
  expect(win.exits).toBe(1);
  expect(win.listenerCount('leave-full-screen')).toBe(1);
  win.emit('leave-full-screen');
  expect(win.hides).toBe(1);
});

test('quitting during fullscreen exit allows close and cancels pending hide', () => {
  test.skip(process.platform !== 'darwin', 'macOS fullscreen Spaces');
  const app = new EventEmitter();
  const quitting = new FixtureWindow();
  setupCloseToHide(app as never, quitting as never);
  expect(quitting.close()).toBe(true);
  expect(quitting.exits).toBe(1);
  app.emit('before-quit');
  expect(quitting.close()).toBe(false);
  quitting.emit('leave-full-screen');
  expect(quitting.hides).toBe(0);
  quitting.emit('closed');
  expect(app.listenerCount('before-quit')).toBe(0);
});

test('a destroyed fullscreen window is not hidden', () => {
  test.skip(process.platform !== 'darwin', 'macOS fullscreen Spaces');
  const destroyedApp = new EventEmitter();
  const destroyed = new FixtureWindow();
  setupCloseToHide(destroyedApp as never, destroyed as never);
  destroyed.close();
  destroyed.destroyed = true;
  destroyed.emit('leave-full-screen');
  expect(destroyed.hides).toBe(0);
});

test('normal close hides and before-quit allows close', () => {
  const trayApp = new EventEmitter();
  const tray = new FixtureWindow();
  tray.fullscreen = false;
  setupCloseToHide(trayApp as never, tray as never);
  expect(tray.close()).toBe(true);
  expect(tray.hides).toBe(1);
  trayApp.emit('before-quit');
  expect(tray.close()).toBe(false);
  expect(tray.hides).toBe(1);
});
