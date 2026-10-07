import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Mutex } from 'async-mutex';
import { BG, type BgConfig } from 'bgutils-js';
import {
  app,
  type BrowserWindow,
  dialog,
  ipcMain,
  Notification,
} from 'electron';
import is from 'electron-is';
import filenamify from 'filenamify';
import lazyVar from 'lazy-var';
import NodeID3 from 'node-id3';
import {
  Innertube,
  UniversalCache,
  Utils,
  YTNodes,
  Platform,
  type YT,
  type YTMusic,
  type Types,
} from '\u0079\u006f\u0075\u0074\u0075\u0062\u0065i.js';

import { t } from '@/i18n';
import { getNetFetchAsFetch } from '@/plugins/utils/main';
import {
  registerCallback,
  cleanupName,
  getImage,
  MediaType,
  type SongInfo,
  SongInfoEvent,
} from '@/providers/song-info';

import {
  createDownloaderInitialization,
  type DownloaderInitialization,
} from './initialization';
import {
  cropMaxWidth,
  clearErrorFeedback,
  getFolder,
  sendErrorFeedback,
  sendFeedback as sendFeedback_,
  setBadge,
} from './utils';

import { DefaultPresetList, type Preset, VideoFormatList } from '../types';

import type { DownloaderPluginConfig } from '../index';
import type { BackendContext } from '@/types/contexts';
import type { GetPlayerResponse } from '@/types/get-player-response';

type CustomSongInfo = SongInfo & { trackId?: string };

const ffmpeg = lazyVar.lazy(async () =>
  (await import('@ffmpeg.wasm/main')).createFFmpeg({
    log: false,
    logger() {}, // Console.log,
    progress() {}, // Console.log,
  }),
);
const ffmpegMutex = new Mutex();

Platform.shim.eval = (
  data: Types.BuildScriptResult,
  env: Record<string, Types.VMPrimative>,
) => {
  const properties = [];

  if (env.n) {
    properties.push(`n: exportedVars.nFunction("${env.n}")`);
  }

  if (env.sig) {
    properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
  }

  const code = `${data.output}\nreturn { ${properties.join(', ')} }`;

  // oxlint-disable-next-line typescript/no-unsafe-return,typescript/no-implied-eval,typescript/no-unsafe-call
  return new Function(code)();
};

let win: BrowserWindow;
let playingUrl: string;
let lastErrorNotification: Notification | undefined;

const isPremium = async (targetWindow: BrowserWindow) => {
  // If signed out, it is understood as non-premium
  const isSignedIn = (await targetWindow.webContents.executeJavaScript(
    '!!yt.config_.LOGGED_IN',
  )) as boolean;

  if (!isSignedIn) return false;

  // If signed in, check if the upgrade button is present
  const upgradeBtnIconPathData =
    (await targetWindow.webContents.executeJavaScript(
      'document.querySelector(\'iron-iconset-svg[name="yt-sys-icons"] #\u0079\u006f\u0075\u0074\u0075\u0062\u0065_music_monochrome\')?.firstChild?.getAttribute("d")?.substring(0, 15)',
    )) as string | null;

  // Fallback to non-premium if the icon is not found
  if (!upgradeBtnIconPathData) return false;

  const upgradeButton = `ytmusic-guide-entry-renderer:has(> tp-yt-paper-item > yt-icon path[d^="${upgradeBtnIconPathData}"])`;

  return (await targetWindow.webContents.executeJavaScript(
    `!document.querySelector('${upgradeButton}')`,
  )) as boolean;
};

const sendError = (rejection: unknown, source?: string) => {
  const errorOwner = backend;
  const error =
    rejection instanceof Error ? rejection : new Error(String(rejection));
  const songNameMessage = source ? `\nin ${source}` : '';
  const cause = error.cause
    ? `\n\n${
        // oxlint-disable-next-line typescript/no-base-to-string,typescript/restrict-template-expressions
        error.cause instanceof Error ? error.cause.toString() : error.cause
      }`
    : '';
  const message = `${error.toString()}${songNameMessage}${cause}`;

  console.error(message);
  console.trace(error);
  try {
    setBadge(0);
  } catch (badgeError) {
    console.warn('Could not clear downloader badge', badgeError);
  }
  const targetWindow = win;
  if (targetWindow.isDestroyed()) return;
  targetWindow.setProgressBar(-1);
  const title = t('plugins.downloader.backend.dialog.error.title');
  const compact =
    `${t('plugins.downloader.backend.dialog.error.message')}: ${error.message}`
      .replace(/\s+/g, ' ')
      .trim();
  let feedback = compact;
  if (compact.length > 200) {
    feedback = '';
    const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const { segment } of segments.segment(compact)) {
      if (feedback.length + segment.length > 199) break;
      feedback += segment;
    }
    feedback += '…';
  }
  if (targetWindow.isFocused()) {
    clearErrorFeedback(targetWindow);
    const failedDialog = (dialogError: unknown) => {
      console.warn('Could not show downloader error dialog', dialogError);
      if (isCurrentBinding(errorOwner))
        sendErrorFeedback(targetWindow, feedback);
    };
    try {
      dialog
        .showMessageBox(targetWindow, {
          type: 'info',
          buttons: [t('plugins.downloader.backend.dialog.error.buttons.ok')],
          title,
          message: t('plugins.downloader.backend.dialog.error.message'),
          detail: message,
        })
        .catch(failedDialog);
    } catch (dialogError) {
      failedDialog(dialogError);
    }
    return;
  }
  sendErrorFeedback(targetWindow, feedback);
  try {
    if (!Notification.isSupported()) return;
    lastErrorNotification?.close();
    lastErrorNotification = new Notification({
      title,
      body: feedback,
      silent: true,
    });
    lastErrorNotification.on('failed', (_, notificationError) => {
      console.warn('Could not show downloader notification', notificationError);
    });
    lastErrorNotification.show();
  } catch (notificationError) {
    console.warn('Could not show downloader notification', notificationError);
  }
};

export const getCookieFromWindow = async (win: BrowserWindow) => {
  return (
    await win.webContents.session.cookies.get({
      url: 'https://music.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com',
    })
  )
    .map((it) => it.name + '=' + it.value)
    .join(';');
};

let config: DownloaderPluginConfig;

interface DownloaderBinding {
  context: BackendContext<DownloaderPluginConfig>;
  session: Electron.Session;
  initialization: DownloaderInitialization<Innertube>;
  disposed: boolean;
  ready: boolean;
  cleanup: (() => void)[];
}
let backend: DownloaderBinding | undefined;
const botguardMutex = new Mutex();
const isOwnedBinding = (
  owner: DownloaderBinding | undefined,
): owner is DownloaderBinding =>
  !!owner &&
  backend === owner &&
  !owner.disposed &&
  !owner.context.window.isDestroyed() &&
  !owner.context.window.webContents.isDestroyed() &&
  owner.context.window.webContents.session === owner.session;
const isCurrentBinding = (
  owner: DownloaderBinding | undefined,
): owner is DownloaderBinding => isOwnedBinding(owner) && owner.ready;
const assertCurrentBinding = (owner: DownloaderBinding) => {
  if (!isCurrentBinding(owner))
    throw new Error('Downloader backend is no longer active');
};
const disposeBinding = (owner: DownloaderBinding | undefined) => {
  if (!owner || owner.disposed) return;
  owner.disposed = true;
  owner.initialization.dispose();
  for (const dispose of owner.cleanup) dispose();
  owner.cleanup = [];
  if (backend === owner) {
    setBadge(0);
    if (!owner.context.window.isDestroyed())
      owner.context.window.setProgressBar(-1);
    backend = undefined;
    playingUrl = '';
  }
};

const initializeDownloader = async (
  owner: DownloaderBinding,
  signal: AbortSignal,
) => {
  const targetWindow = owner.context.window;
  const cookie = await getCookieFromWindow(targetWindow);
  assertCurrentBinding(owner);
  const nativeFetch = getNetFetchAsFetch();
  const ownedFetch: typeof fetch = async (input, init) => {
    assertCurrentBinding(owner);
    const requestSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return nativeFetch(input, {
      ...init,
      signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal,
    });
  };
  const client = await Innertube.create({
    cache: new UniversalCache(false),
    cookie,
    generate_session_locally: true,
    fetch: ownedFetch,
  });
  assertCurrentBinding(owner);
  const visitorData = client.session.context.client.visitorData;
  if (visitorData) {
    // Botguard temporarily uses process globals; retired work restores them
    // before a new backend enters this section.
    await botguardMutex.runExclusive(async () => {
      assertCurrentBinding(owner);
      const previousWindow = Object.getOwnPropertyDescriptor(
        globalThis,
        'window',
      );
      const previousDocument = Object.getOwnPropertyDescriptor(
        globalThis,
        'document',
      );
      // Never invoke prior accessors, and do not partially overlay immutable
      // globals. PoToken setup remains optional in that environment.
      if (
        previousWindow?.configurable === false ||
        previousDocument?.configurable === false
      )
        return;
      try {
        const [width, height] = targetWindow.getSize();
        const window = new (await import('happy-dom')).Window({
          width,
          height,
          console,
        });
        const document = window.document;
        assertCurrentBinding(owner);
        Object.defineProperties(globalThis, {
          window: {
            value: window,
            writable: true,
            configurable: true,
            enumerable: previousWindow?.enumerable ?? true,
          },
          document: {
            value: document,
            writable: true,
            configurable: true,
            enumerable: previousDocument?.enumerable ?? true,
          },
        });
        const bgConfig: BgConfig = {
          fetch: ownedFetch,
          globalObj: globalThis,
          identifier: visitorData,
          requestKey: 'O43z0dpjhgX20SCx4KAo',
        };
        const bgChallenge = await BG.Challenge.create(bgConfig);
        assertCurrentBinding(owner);
        const interpreterJavascript =
          bgChallenge?.interpreterJavascript
            .privateDoNotAccessOrElseSafeScriptWrappedValue;
        if (interpreterJavascript) {
          // Preserve the existing Botguard interpreter path.
          // oxlint-disable-next-line typescript/no-implied-eval,typescript/no-unsafe-call
          new Function(interpreterJavascript)();
          const token = await BG.PoToken.generate({
            program: bgChallenge.program,
            globalName: bgChallenge.globalName,
            bgConfig,
          });
          assertCurrentBinding(owner);
          client.session.po_token = token.poToken;
        }
      } catch {
        // A missing PoToken stays optional; backend retirement is terminal.
        assertCurrentBinding(owner);
      } finally {
        if (previousWindow)
          Object.defineProperty(globalThis, 'window', previousWindow);
        else Reflect.deleteProperty(globalThis, 'window');
        if (previousDocument)
          Object.defineProperty(globalThis, 'document', previousDocument);
        else Reflect.deleteProperty(globalThis, 'document');
      }
    });
  }
  assertCurrentBinding(owner);
  return client;
};

export const onMainLoad = async (
  context: BackendContext<DownloaderPluginConfig>,
) => {
  disposeBinding(backend);
  let owner: DownloaderBinding;
  const initialization = createDownloaderInitialization(
    () => isCurrentBinding(owner),
    (signal) => initializeDownloader(owner, signal),
  );
  owner = {
    context,
    session: context.window.webContents.session,
    initialization,
    disposed: false,
    ready: false,
    cleanup: [],
  };
  backend = owner;
  const closed = () => disposeBinding(owner);
  context.window.once('closed', closed);
  owner.cleanup.push(() => context.window.removeListener('closed', closed));
  try {
    const loadedConfig = await context.getConfig();
    if (!isOwnedBinding(owner)) return;
    win = context.window;
    config = loadedConfig;
    playingUrl = '';
    owner.ready = true;
    const { ipc } = context;
    ipc.handle('download-song', (url: string) =>
      isCurrentBinding(owner) ? downloadSong(url) : undefined,
    );
    owner.cleanup.push(() => ipc.removeHandler('download-song'));
    const sourceChanged = (
      _event: Electron.IpcMainEvent,
      data: GetPlayerResponse,
    ) => {
      if (isCurrentBinding(owner))
        playingUrl = data.microformat.microformatDataRenderer.urlCanonical;
    };
    ipcMain.on('peard:video-src-changed', sourceChanged);
    owner.cleanup.push(() =>
      ipcMain.removeListener('peard:video-src-changed', sourceChanged),
    );
    ipc.handle('download-playlist-request', (url: string) =>
      isCurrentBinding(owner) ? downloadPlaylist(url) : undefined,
    );
    owner.cleanup.push(() => ipc.removeHandler('download-playlist-request'));
    owner.cleanup.push(downloadSongOnFinishSetup(context, owner));
  } catch (error) {
    disposeBinding(owner);
    throw error;
  }
};

export const onMainStop = ({
  window,
}: BackendContext<DownloaderPluginConfig>) => {
  if (backend?.context.window === window) disposeBinding(backend);
};

export const onConfigChange = (newConfig: DownloaderPluginConfig) => {
  if (isCurrentBinding(backend)) config = newConfig;
};

const resolvePreset = (selected: string | undefined): Preset => {
  const name = selected ?? 'mp3 (256kbps)';
  if (name === 'Custom')
    return config.customPresetSetting ?? DefaultPresetList['Custom'];
  return Object.hasOwn(DefaultPresetList, name)
    ? DefaultPresetList[name]
    : DefaultPresetList['mp3 (256kbps)'];
};

export async function downloadSong(
  url: string,
  playlistFolder?: string,
  trackId?: string,
  increasePlaylistProgress: (value: number) => void = () => {},
) {
  const owner = backend;
  if (!isCurrentBinding(owner)) return;
  let resolvedName;
  try {
    clearErrorFeedback(win);
    await downloadSongUnsafe(
      owner,
      false,
      url,
      (name: string) => (resolvedName = name),
      playlistFolder,
      trackId,
      increasePlaylistProgress,
    );
  } catch (error: unknown) {
    if (backend === owner && !owner.disposed)
      sendError(error as Error, resolvedName || url);
  }
}

export async function downloadSongFromId(
  id: string,
  playlistFolder?: string,
  trackId?: string,
  increasePlaylistProgress: (value: number) => void = () => {},
) {
  return downloadSongFromIdInOperation(
    id,
    playlistFolder,
    trackId,
    increasePlaylistProgress,
    true,
  );
}

async function downloadSongFromIdInOperation(
  id: string,
  playlistFolder?: string,
  trackId?: string,
  increasePlaylistProgress: (value: number) => void = () => {},
  startOperation = false,
) {
  const owner = backend;
  if (!isCurrentBinding(owner)) return;
  let resolvedName;
  try {
    if (startOperation) clearErrorFeedback(win);
    await downloadSongUnsafe(
      owner,
      true,
      id,
      (name: string) => (resolvedName = name),
      playlistFolder,
      trackId,
      increasePlaylistProgress,
    );
  } catch (error: unknown) {
    if (backend === owner && !owner.disposed)
      sendError(error as Error, resolvedName || id);
  }
}

function downloadSongOnFinishSetup(
  { ipc }: Pick<BackendContext<DownloaderPluginConfig>, 'ipc' | 'getConfig'>,
  owner: DownloaderBinding,
) {
  let currentUrl: string | undefined;
  let duration: number | undefined;
  let time = 0;

  const defaultDownloadFolder = app.getPath('downloads');

  const unregister = registerCallback((songInfo: SongInfo, event) => {
    if (!isCurrentBinding(owner)) return;
    if (event === SongInfoEvent.TimeChanged) {
      const elapsedSeconds = songInfo.elapsedSeconds ?? 0;
      if (elapsedSeconds > time) time = elapsedSeconds;
      return;
    }
    if (
      !songInfo.isPaused &&
      songInfo.url !== currentUrl &&
      config.downloadOnFinish?.enabled
    ) {
      if (typeof currentUrl === 'string' && duration && duration > 0) {
        if (
          config.downloadOnFinish.mode === 'seconds' &&
          duration - time <= config.downloadOnFinish.seconds
        ) {
          downloadSong(
            currentUrl,
            config.downloadOnFinish.folder ??
              config.downloadFolder ??
              defaultDownloadFolder,
          );
        } else if (
          config.downloadOnFinish.mode === 'percent' &&
          time >= duration * (config.downloadOnFinish.percent / 100)
        ) {
          downloadSong(
            currentUrl,
            config.downloadOnFinish.folder ??
              config.downloadFolder ??
              defaultDownloadFolder,
          );
        }
      }

      currentUrl = songInfo.url;
      duration = songInfo.songDuration;
      time = 0;
    }
  });

  const playerReady = () => {
    if (isCurrentBinding(owner)) ipc.send('peard:setup-time-changed-listener');
  };
  ipcMain.on('peard:player-api-loaded', playerReady);
  return () => {
    unregister();
    ipcMain.removeListener('peard:player-api-loaded', playerReady);
  };
}

async function downloadSongUnsafe(
  owner: DownloaderBinding,
  isId: boolean,
  idOrUrl: string,
  setName: (name: string) => void,
  playlistFolder?: string,
  trackId?: string,
  increasePlaylistProgress: (value: number) => void = () => {},
) {
  const sendFeedback = (message: unknown, progress?: number) => {
    if (!isCurrentBinding(owner)) return;
    if (!playlistFolder) {
      sendFeedback_(win, message);
      if (progress && !isNaN(progress)) {
        win.setProgressBar(progress);
      }
    }
  };

  sendFeedback(t('plugins.downloader.backend.feedback.downloading'), 2);

  let id: string | null;
  if (isId) {
    id = idOrUrl;
  } else {
    id = getVideoId(idOrUrl);
    if (typeof id !== 'string')
      throw new Error(
        t('plugins.downloader.backend.feedback.video-id-not-found'),
      );
  }

  const yt = await owner.initialization.get();
  assertCurrentBinding(owner);
  let info: YTMusic.TrackInfo | YT.VideoInfo = await yt.music.getInfo(id);
  assertCurrentBinding(owner);

  if (!info) {
    throw new Error(
      t('plugins.downloader.backend.feedback.video-id-not-found'),
    );
  }

  const metadata = getMetadata(info);
  if (metadata.album === 'N/A') {
    metadata.album = '';
  }

  metadata.trackId = trackId;

  const dir = getFolder(playlistFolder || config.downloadFolder);
  const name = `${metadata.artist ? `${metadata.artist} - ` : ''}${
    metadata.title
  }`;
  setName(name);

  let playabilityStatus = info.playability_status;
  let bypassedResult: YT.VideoInfo;
  if (playabilityStatus?.status === 'LOGIN_REQUIRED') {
    // Try to bypass the age restriction
    bypassedResult = await getAndroidTvInfo(id, yt);
    assertCurrentBinding(owner);
    playabilityStatus = bypassedResult.playability_status;

    if (playabilityStatus?.status === 'LOGIN_REQUIRED') {
      throw new Error(
        `[${playabilityStatus.status}] ${playabilityStatus.reason}`,
      );
    }

    info = bypassedResult;
  }

  if (playabilityStatus?.status === 'UNPLAYABLE') {
    const errorScreen =
      playabilityStatus.error_screen as YTNodes.PlayerErrorMessage | null;
    throw new Error(
      `[${playabilityStatus.status}] ${errorScreen?.reason.text}: ${errorScreen?.subreason.text}`,
    );
  }

  const presetSetting = resolvePreset(config.selectedPreset);
  const premium = await isPremium(owner.context.window);
  assertCurrentBinding(owner);

  const downloadOptions: Types.FormatOptions = {
    type: premium ? 'audio' : 'video+audio', // Audio, video or video+audio
    quality: 'best', // Best, bestefficiency, 144p, 240p, 480p, 720p and so on.
    format: 'any', // Media container format
  };

  const format = info.chooseFormat(downloadOptions);

  let targetFileExtension: string;
  if (!presetSetting?.extension) {
    targetFileExtension =
      VideoFormatList.find((it) => it.itag === format.itag)?.container ?? 'mp3';
  } else {
    targetFileExtension = presetSetting?.extension ?? 'mp3';
  }

  let filename = filenamify(`${name}.${targetFileExtension}`, {
    replacement: '_',
    maxLength: 255,
  });
  if (!is.macOS()) {
    filename = filename.normalize('NFC');
  }
  const filePath = join(dir, filename);

  if (config.skipExisting && existsSync(filePath)) {
    sendFeedback(null, -1);
    return;
  }

  const stream = await info.download(downloadOptions);
  assertCurrentBinding(owner);

  console.info(
    t('plugins.downloader.backend.feedback.download-info', {
      artist: metadata.artist,
      title: metadata.title,
      videoId: metadata.videoId,
    }),
  );

  const iterableStream = Utils.streamToIterable(stream);

  if (!existsSync(dir)) {
    mkdirSync(dir);
  }

  let fileBuffer = await iterableStreamToProcessedUint8Array(
    iterableStream,
    targetFileExtension,
    metadata,
    presetSetting?.ffmpegArgs ?? [],
    format.content_length ?? 0,
    sendFeedback,
    increasePlaylistProgress,
    owner,
  );
  assertCurrentBinding(owner);

  if (fileBuffer && targetFileExtension === 'mp3') {
    fileBuffer = await writeID3(
      Buffer.from(fileBuffer),
      metadata,
      sendFeedback,
      owner,
    );
    assertCurrentBinding(owner);
  }

  if (fileBuffer) {
    writeFileSync(filePath, fileBuffer);
  }

  sendFeedback(null, -1);
  console.info(
    t('plugins.downloader.backend.feedback.done', {
      filePath,
    }),
  );
}

async function downloadChunks(
  stream: AsyncGenerator<Uint8Array, void>,
  contentLength: number,
  sendFeedback: (str: string, value?: number) => void,
  increasePlaylistProgress: (value: number) => void = () => {},
) {
  const chunks = [];
  let downloaded = 0;
  for await (const chunk of stream) {
    downloaded += chunk.length;
    chunks.push(chunk);
    const ratio = downloaded / contentLength;
    const progress = Math.floor(ratio * 100);
    sendFeedback(
      t('plugins.downloader.backend.feedback.download-progress', {
        percent: progress,
      }),
      ratio,
    );
    // 15% for download, 85% for conversion
    // This is a very rough estimate, trying to make the progress bar look nice
    increasePlaylistProgress(ratio * 0.15);
  }
  return chunks;
}

async function iterableStreamToProcessedUint8Array(
  stream: AsyncGenerator<Uint8Array, void>,
  extension: string,
  metadata: CustomSongInfo,
  presetFfmpegArgs: string[],
  contentLength: number,
  sendFeedback: (str: string, value?: number) => void,
  increasePlaylistProgress: (value: number) => void = () => {},
  owner: DownloaderBinding,
): Promise<Uint8Array | null> {
  sendFeedback(t('plugins.downloader.backend.feedback.loading'), 2); // Indefinite progress bar after download

  const safeVideoName = randomBytes(32).toString('hex');

  return await ffmpegMutex.runExclusive(async () => {
    try {
      assertCurrentBinding(owner);
      const ffmpegInstance = await ffmpeg.get();
      if (!ffmpegInstance.isLoaded()) {
        await ffmpegInstance.load();
      }

      sendFeedback(t('plugins.downloader.backend.feedback.preparing-file'));
      ffmpegInstance.FS(
        'writeFile',
        safeVideoName,
        Buffer.concat(
          await downloadChunks(
            stream,
            contentLength,
            sendFeedback,
            increasePlaylistProgress,
          ),
        ),
      );

      sendFeedback(t('plugins.downloader.backend.feedback.converting'));

      ffmpegInstance.setProgress(({ ratio }) => {
        sendFeedback(
          t('plugins.downloader.backend.feedback.conversion-progress', {
            percent: Math.floor(ratio * 100),
          }),
          ratio,
        );
        const conversionProgress = ratio * 0.85;
        increasePlaylistProgress(0.15 + conversionProgress);
      });

      const safeVideoNameWithExtension = `${safeVideoName}.${extension}`;
      try {
        await ffmpegInstance.run(
          '-i',
          safeVideoName,
          ...presetFfmpegArgs,
          ...getFFmpegMetadataArgs(metadata),
          safeVideoNameWithExtension,
        );
      } finally {
        ffmpegInstance.FS('unlink', safeVideoName);
      }

      sendFeedback(t('plugins.downloader.backend.feedback.saving'));

      try {
        return ffmpegInstance.FS('readFile', safeVideoNameWithExtension);
      } finally {
        ffmpegInstance.FS('unlink', safeVideoNameWithExtension);
      }
    } catch (error: unknown) {
      if (isCurrentBinding(owner)) sendError(error as Error, safeVideoName);
    }
    return null;
  });
}

const getCoverBuffer = async (url: string) => {
  const nativeImage = cropMaxWidth(await getImage(url));
  return nativeImage && !nativeImage.isEmpty() ? nativeImage.toPNG() : null;
};

async function writeID3(
  buffer: Buffer,
  metadata: CustomSongInfo,
  sendFeedback: (str: string, value?: number) => void,
  owner: DownloaderBinding,
) {
  try {
    sendFeedback(t('plugins.downloader.backend.feedback.writing-id3'));
    const tags: NodeID3.Tags = {};

    // Create the metadata tags
    tags.title = metadata.title;
    tags.artist = metadata.artist;

    if (metadata.album) {
      tags.album = metadata.album;
    }

    const coverBuffer = await getCoverBuffer(metadata.imageSrc ?? '');
    if (coverBuffer) {
      tags.image = {
        mime: 'image/png',
        type: {
          id: NodeID3.TagConstants.AttachedPicture.PictureType.FRONT_COVER,
        },
        description: 'thumbnail',
        imageBuffer: coverBuffer,
      };
    }

    if (metadata.trackId) {
      tags.trackNumber = metadata.trackId;
    }

    return NodeID3.write(tags, buffer);
  } catch (error: unknown) {
    if (isCurrentBinding(owner))
      sendError(error as Error, `${metadata.artist} - ${metadata.title}`);
    return null;
  }
}

export async function downloadPlaylist(givenUrl?: string | URL) {
  const owner = backend;
  if (!isCurrentBinding(owner)) return;
  clearErrorFeedback(win);
  let yt: Innertube;
  try {
    yt = await owner.initialization.get();
    assertCurrentBinding(owner);
  } catch (error) {
    if (isCurrentBinding(owner)) sendError(error);
    return;
  }
  try {
    givenUrl = new URL(givenUrl ?? '');
  } catch {
    givenUrl = new URL(win.webContents.getURL());
  }

  const playlistId =
    getPlaylistID(givenUrl) || getPlaylistID(new URL(playingUrl));

  if (!playlistId) {
    sendError(
      new Error(t('plugins.downloader.backend.feedback.playlist-id-not-found')),
    );
    return;
  }

  const sendFeedback = (message?: unknown) => {
    if (isCurrentBinding(owner)) sendFeedback_(win, message);
  };

  console.log(
    t('plugins.downloader.backend.feedback.trying-to-get-playlist-id', {
      playlistId,
    }),
  );
  sendFeedback(t('plugins.downloader.backend.feedback.getting-playlist-info'));
  let playlist: YTMusic.Playlist;
  const items: YTNodes.MusicResponsiveListItem[] = [];
  try {
    playlist = await yt.music.getPlaylist(playlistId);
    assertCurrentBinding(owner);
    if (playlist?.items) {
      const filteredItems = playlist.items.filter(
        (item): item is YTNodes.MusicResponsiveListItem =>
          item instanceof YTNodes.MusicResponsiveListItem,
      );

      items.push(...filteredItems);
    }
  } catch (error: unknown) {
    if (!isCurrentBinding(owner)) return;
    sendError(
      Error(
        t('plugins.downloader.backend.feedback.playlist-is-mix-or-private', {
          error: String(error),
        }),
      ),
    );
    return;
  }

  if (!playlist || !playlist.items || playlist.items.length === 0) {
    sendError(
      new Error(t('plugins.downloader.backend.feedback.playlist-is-empty')),
    );
    return;
  }

  const normalPlaylistTitle =
    playlist.header && 'title' in playlist.header
      ? playlist.header?.title?.text
      : undefined;
  const playlistTitle =
    normalPlaylistTitle ??
    playlist.page.contents_memo
      ?.get('MusicResponsiveListItemFlexColumn')
      ?.at(2)
      ?.as(YTNodes.MusicResponsiveListItemFlexColumn)?.title?.text ??
    'NO_TITLE';
  const isAlbum = !normalPlaylistTitle;

  const configuredLimit = config.playlistMaxItems;
  const limit =
    typeof configuredLimit === 'number' &&
    Number.isFinite(configuredLimit) &&
    configuredLimit >= 1
      ? Math.floor(configuredLimit)
      : undefined;
  try {
    while (playlist.has_continuation && (!limit || items.length < limit)) {
      playlist = await playlist.getContinuation();
      assertCurrentBinding(owner);
      const filteredItems = playlist.items.filter(
        (item): item is YTNodes.MusicResponsiveListItem =>
          item instanceof YTNodes.MusicResponsiveListItem,
      );
      items.push(...filteredItems);
    }
  } catch (error) {
    if (isCurrentBinding(owner)) sendError(error);
    return;
  }
  // A capped collection remains a playlist/album, including its folder/tags.
  const naturallySingle = items.length === 1 && !playlist.has_continuation;
  if (limit) items.splice(limit);

  if (naturallySingle) {
    sendFeedback(
      t('plugins.downloader.backend.feedback.playlist-has-only-one-song'),
    );
    await downloadSongFromIdInOperation(items.at(0)!.id!);
    return;
  }

  let safePlaylistTitle = filenamify(playlistTitle, { replacement: ' ' });
  if (!is.macOS()) {
    safePlaylistTitle = safePlaylistTitle.normalize('NFC');
  }

  const folder = getFolder(config.downloadFolder ?? '');
  const playlistFolder = join(folder, safePlaylistTitle);
  if (existsSync(playlistFolder)) {
    if (!config.skipExisting) {
      sendError(
        new Error(
          t('plugins.downloader.backend.feedback.folder-already-exists', {
            playlistFolder,
          }),
        ),
      );
      return;
    }
  } else {
    mkdirSync(playlistFolder, { recursive: true });
  }

  dialog.showMessageBox(win, {
    type: 'info',
    buttons: [
      t('plugins.downloader.backend.dialog.start-download-playlist.buttons.ok'),
    ],
    title: t('plugins.downloader.backend.dialog.start-download-playlist.title'),
    message: t(
      'plugins.downloader.backend.dialog.start-download-playlist.message',
      {
        playlistTitle,
      },
    ),
    detail: t(
      'plugins.downloader.backend.dialog.start-download-playlist.detail',
      {
        playlistSize: items.length,
      },
    ),
  });

  if (is.dev()) {
    console.log(
      t('plugins.downloader.backend.feedback.downloading-playlist', {
        playlistTitle,
        playlistSize: items.length,
        playlistId,
      }),
    );
  }

  win.setProgressBar(2); // Starts with indefinite bar

  setBadge(items.length);

  let counter = 1;

  const progressStep = 1 / items.length;

  const increaseProgress = (itemPercentage: number) => {
    if (!isCurrentBinding(owner)) return;
    const currentProgress = (counter - 1) / (items.length ?? 1);
    const itemProgress = progressStep * itemPercentage;
    const newProgress = currentProgress + itemProgress;
    win.setProgressBar(newProgress);
  };

  try {
    for (const song of items) {
      assertCurrentBinding(owner);
      sendFeedback(
        t('plugins.downloader.backend.feedback.downloading-counter', {
          current: counter,
          total: items.length,
        }),
      );
      const trackId = isAlbum ? counter : undefined;
      await downloadSongFromIdInOperation(
        song.id!,
        playlistFolder,
        trackId?.toString(),
        increaseProgress,
      ).catch((error) =>
        sendError(
          new Error(
            t('plugins.downloader.backend.feedback.error-while-downloading', {
              author: song.author!.name,
              title: song.title!,
              error: String(error),
            }),
          ),
        ),
      );

      assertCurrentBinding(owner);
      owner.context.window.setProgressBar(counter / items.length);
      setBadge(items.length - counter);
      counter++;
    }
  } catch (error: unknown) {
    if (isCurrentBinding(owner)) sendError(error as Error);
  } finally {
    if (isCurrentBinding(owner)) {
      owner.context.window.setProgressBar(-1); // Close progress bar
      setBadge(0); // Close badge counter
      sendFeedback(); // Clear feedback
    }
  }
}

function getFFmpegMetadataArgs(metadata: CustomSongInfo) {
  if (!metadata) {
    return [];
  }

  return [
    ...(metadata.title ? ['-metadata', `title=${metadata.title}`] : []),
    ...(metadata.artist ? ['-metadata', `artist=${metadata.artist}`] : []),
    ...(metadata.album ? ['-metadata', `album=${metadata.album}`] : []),
    ...(metadata.trackId ? ['-metadata', `track=${metadata.trackId}`] : []),
  ];
}

// Playlist radio modifier needs to be cut from playlist ID
const INVALID_PLAYLIST_MODIFIER = 'RDAMPL';

const getPlaylistID = (aURL?: URL): string | null | undefined => {
  const result =
    aURL?.searchParams.get('list') || aURL?.searchParams.get('playlist');
  if (result?.startsWith(INVALID_PLAYLIST_MODIFIER)) {
    return result.slice(INVALID_PLAYLIST_MODIFIER.length);
  }

  return result;
};

const getVideoId = (url: URL | string): string | null => {
  const parsedUrl = URL.parse(url);
  if (!parsedUrl) return null;
  return parsedUrl.searchParams.get('v');
};

const getMetadata = (info: YTMusic.TrackInfo): CustomSongInfo => ({
  videoId: info.basic_info.id!,
  title: cleanupName(info.basic_info.title!),
  artist: cleanupName(info.basic_info.author!),
  album: info.player_overlays?.browser_media_session?.as(
    YTNodes.BrowserMediaSession,
  ).album?.text,
  imageSrc: info.basic_info.thumbnail?.find((t) => !t.url.endsWith('.webp'))
    ?.url,
  views: info.basic_info.view_count!,
  songDuration: info.basic_info.duration!,
  mediaType: MediaType.Audio,
});

// This is used to bypass age restrictions
const getAndroidTvInfo = async (
  id: string,
  client: Innertube,
): Promise<YT.VideoInfo> => {
  // GetInfo 404s with the bypass, so we use getBasicInfo instead
  // that's fine as we only need the streaming data
  return await client.getBasicInfo(id, {
    client: 'TV_EMBEDDED',
  });
};
