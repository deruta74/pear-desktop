import type { App, BrowserWindow } from 'electron';

export const setupCloseToHide = (app: App, win: BrowserWindow): void => {
  let forceQuit = false;
  let leavingFullscreen = false;

  const onBeforeQuit = () => {
    forceQuit = true;
  };
  const hideAfterFullscreen = () => {
    leavingFullscreen = false;
    if (!forceQuit && !win.isDestroyed()) win.hide();
  };

  app.on('before-quit', onBeforeQuit);
  win.once('closed', () => {
    app.removeListener('before-quit', onBeforeQuit);
    win.removeListener('leave-full-screen', hideAfterFullscreen);
  });

  win.on('close', (event) => {
    if (forceQuit) return;

    // Keep playback running when closing the main window.
    event.preventDefault();
    if (leavingFullscreen) return;

    if (process.platform === 'darwin' && win.isFullScreen()) {
      // On macOS, wait for the fullscreen Space to close before hiding.
      leavingFullscreen = true;
      win.once('leave-full-screen', hideAfterFullscreen);
      win.setFullScreen(false);
    } else {
      win.hide();
    }
  });
};
