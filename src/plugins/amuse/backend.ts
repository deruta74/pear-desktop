import { randomUUID } from 'node:crypto';

import { serve } from '@hono/node-server';
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { t } from 'i18next';

import {
  MediaType,
  registerCallback,
  type SongInfo,
} from '@/providers/song-info';
import { createBackend } from '@/utils';

import type { AmuseSongInfo } from './types';

const amusePort = 9863;

const seconds = (value: number | undefined) =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : 0;
const humanTime = (value: number) =>
  `${Math.floor(value / 60)}:${(value % 60).toString().padStart(2, '0')}`;

// Complete 6K Labs contract adapted from upstream #4721 (@aashish254).
const formatSongInfo = (
  info: SongInfo | null,
  positionUpdatedAt: number,
  isAdvertisement: boolean,
): AmuseSongInfo => {
  const hasSong = !!(info?.artist && info.title);
  const elapsed = hasSong ? seconds(info.elapsedSeconds) : 0;
  const duration = hasSong ? seconds(info.songDuration) : 0;
  return {
    apiVersion: 2,
    player: {
      hasSong,
      isPaused: hasSong ? (info.isPaused ?? false) : true,
      volumePercent: 0,
      seekbarCurrentPosition: elapsed,
      seekbarCurrentPositionHuman: humanTime(elapsed),
      positionUpdatedAt: hasSong ? positionUpdatedAt : 0,
      statePercent:
        duration > 0
          ? Math.min(100, Math.round((elapsed / duration) * 100))
          : 0,
      likeStatus: 'INDIFFERENT',
      repeatType: 'NONE',
    },
    track: {
      duration,
      durationHuman: humanTime(duration),
      title: hasSong ? info.title : '',
      author: hasSong ? info.artist : '',
      album: hasSong ? (info.album ?? '') : '',
      cover: hasSong ? (info.imageSrc ?? '') : '',
      url: hasSong ? (info.url ?? '') : '',
      id: hasSong ? (info.videoId ?? '') : '',
      isVideo:
        hasSong &&
        [
          MediaType.OriginalMusicVideo,
          MediaType.UserGeneratedContent,
          MediaType.OtherVideo,
        ].includes(info.mediaType),
      isAdvertisement,
      inLibrary: false,
      mediaType: hasSong ? (info.mediaType ?? '') : '',
      playlistId: hasSong ? (info.playlistId ?? '') : '',
    },
  };
};

export default createBackend({
  app: null as Hono | null,
  server: null as ReturnType<typeof serve> | null,
  release: null as (() => void) | null,
  start({ ipc, window }) {
    this.release?.();
    this.server?.close();
    this.server = null;
    const contents = window.webContents;
    let songInfo: SongInfo | null = null;
    let positionUpdatedAt = 0;
    let isAdvertisement = false;
    let token = randomUUID();
    const isCurrentFrame = (event: IpcMainEvent | IpcMainInvokeEvent) =>
      event.sender === contents &&
      event.senderFrame !== null &&
      event.senderFrame === contents.mainFrame;
    const onPlayerReady = (event: IpcMainInvokeEvent) => {
      if (!isCurrentFrame(event)) return null;
      ipc.send('peard:setup-time-changed-listener');
      return token;
    };
    const onAdState = (event: IpcMainEvent, lease: unknown, value: unknown) => {
      if (
        lease === token &&
        typeof value === 'boolean' &&
        isCurrentFrame(event)
      )
        isAdvertisement = value;
    };
    const reset = () => {
      songInfo = null;
      isAdvertisement = false;
      positionUpdatedAt = 0;
      token = randomUUID();
    };
    let replaying = true;
    const unsubscribe = registerCallback(
      (info) => {
        songInfo = info;
        positionUpdatedAt =
          replaying || !Number.isFinite(info.elapsedSeconds) ? 0 : Date.now();
      },
      { replayCurrent: true },
    );
    replaying = false;
    ipcMain.handle('peard:amuse-player-ready', onPlayerReady);
    ipcMain.on('peard:amuse-ad-state', onAdState);
    contents.on('did-navigate', reset);
    contents.on('render-process-gone', reset);
    this.release = () => {
      unsubscribe();
      ipcMain.removeHandler('peard:amuse-player-ready');
      ipcMain.removeListener('peard:amuse-ad-state', onAdState);
      contents.removeListener('did-navigate', reset);
      contents.removeListener('render-process-gone', reset);
    };

    this.app = new Hono();
    this.app.use('*', cors());
    this.app.get('/', (ctx) =>
      ctx.body(t('plugins.amuse.response.query'), 200),
    );

    const queryAndApiHandler = (ctx: Context) => {
      return ctx.json(
        formatSongInfo(songInfo, positionUpdatedAt, isAdvertisement),
        200,
      );
    };

    this.app.get('/query', queryAndApiHandler);
    this.app.get('/api', queryAndApiHandler);

    try {
      this.server = serve({
        fetch: this.app.fetch.bind(this.app),
        port: amusePort,
      });
    } catch (err) {
      console.error(err);
    }
  },

  stop() {
    this.release?.();
    this.release = null;
    this.server?.close();
    this.server = null;
    this.app = null;
  },
});
