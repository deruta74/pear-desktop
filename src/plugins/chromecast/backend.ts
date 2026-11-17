import {
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from 'electron';

import * as config from '@/config';
import { store } from '@/config/store';
import { t } from '@/i18n';

import {
  savedCastReceiver,
  shouldAutoCast,
  type AutoCastSettings,
} from './auto-cast';
import { startCastDiscovery, type DiscoveredReceiver } from './discovery';
import {
  isSafeCastAppId,
  isSafeCastHandle,
  isSafeCastHost,
  isSafeCastPort,
} from './endpoint';
import { isValidReceiverId, sanitizeReceiverName } from './receivers';
import { CastDeviceSession } from './session';

import type { CastSessionEvent, CastSessionSnapshot } from './session-types';

export const CAST_SELECT = 'peard:cast:select';
export const CAST_RESUME = 'peard:cast:resume';
export const CAST_CONFIRM_STOP = 'peard:cast:confirm-stop';
export const CAST_SESSION = 'peard:cast:session';
export const CAST_EVENT = 'peard:cast:event';

type Request =
  | { op: 'connect'; receiverId: string; appId: string }
  | { op: 'send'; handle: string; namespace: string; data: string }
  | { op: 'volume'; handle: string; level: number }
  | { op: 'mute'; handle: string; muted: boolean }
  | { op: 'load'; handle: string; request: unknown }
  | { op: 'queue-load'; handle: string; request: unknown }
  | { op: 'leave'; handle: string }
  | { op: 'stop'; handle: string };

type ResumeResult = {
  snapshot: CastSessionSnapshot | null;
  fallbackUrl: string | null;
};

export class CastBackend {
  private receivers: DiscoveredReceiver[] = [];
  private stopDiscovery: (() => void) | null = null;
  private sessions = new Map<string, CastDeviceSession>();
  private receiverByHandle = new Map<string, string>();
  private autoConnectPromise: Promise<CastSessionSnapshot | null> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = true;
  private dialogOpen = false;
  private resumePromise: Promise<ResumeResult> | null = null;
  private generation = 0;
  private manualConnectGeneration: number | null = null;
  private reconnectAttempts = 0;
  private waits = new Map<ReturnType<typeof setTimeout>, () => void>();
  private readonly onNavigation = (
    _event: unknown,
    _url: string,
    inPlace: boolean,
    mainFrame: boolean,
  ) => {
    if (mainFrame && !inPlace) this.retireSessions();
  };

  private retireSessions(): void {
    this.generation++;
    this.manualConnectGeneration = null;
    this.autoConnectPromise = null;
    this.resumePromise = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const [timer, resolve] of this.waits) {
      clearTimeout(timer);
      resolve();
    }
    this.waits.clear();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.receiverByHandle.clear();
    for (const session of sessions) session.leave();
  }

  constructor(private readonly window: BrowserWindow) {}

  start(): void {
    if (!this.closed) return;
    this.closed = false;
    this.reconnectAttempts = 0;
    this.window.webContents.on('did-start-navigation', this.onNavigation);
    this.stopDiscovery = startCastDiscovery((list) => {
      if (this.closed) return;
      this.receivers = list;
      this.maybeAutoConnect();
    });
    ipcMain.handle(CAST_SELECT, (event) => this.select(event));
    ipcMain.handle(CAST_RESUME, (event) => {
      this.checkSender(event);
      if (!this.resumePromise) {
        const pending = this.resume(event).finally(() => {
          if (this.resumePromise === pending) this.resumePromise = null;
        });
        this.resumePromise = pending;
      }
      return this.resumePromise;
    });
    ipcMain.handle(CAST_CONFIRM_STOP, (event, handle: string) =>
      this.confirmStop(event, handle),
    );
    ipcMain.handle(CAST_SESSION, (event, request: Request) =>
      this.handle(event, request),
    );
  }

  stop(): void {
    this.closed = true;
    this.window.webContents.off('did-start-navigation', this.onNavigation);
    this.retireSessions();
    this.receivers = [];
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    ipcMain.removeHandler(CAST_SELECT);
    ipcMain.removeHandler(CAST_RESUME);
    ipcMain.removeHandler(CAST_CONFIRM_STOP);
    ipcMain.removeHandler(CAST_SESSION);
    this.stopDiscovery?.();
    this.stopDiscovery = null;
    for (const session of this.sessions.values()) session.leave();
    this.sessions.clear();
    this.receiverByHandle.clear();
  }

  private settings(): AutoCastSettings {
    return (
      (store.get('plugins.chromecast') as AutoCastSettings | undefined) ?? {}
    );
  }

  private savedReceiver(): { id: string; appId: string } | null {
    return savedCastReceiver(this.settings());
  }

  private shouldAutoConnect(): boolean {
    return (
      !this.closed &&
      this.manualConnectGeneration === null &&
      this.stopDiscovery !== null &&
      shouldAutoCast(this.settings())
    );
  }

  private activeSavedSession(): CastDeviceSession | null {
    const saved = this.savedReceiver();
    if (!saved) return null;
    for (const session of this.sessions.values()) {
      if (
        this.receiverByHandle.get(session.handle) === saved.id &&
        session.snapshot().appId === saved.appId &&
        session.snapshot().status === 'connected'
      )
        return session;
    }
    return null;
  }

  private scheduleAutoReconnect(delay = 3000): void {
    if (
      !this.shouldAutoConnect() ||
      this.retryTimer ||
      this.reconnectAttempts >= 3
    )
      return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.maybeAutoConnect();
    }, delay);
  }

  private maybeAutoConnect(): void {
    if (
      !this.shouldAutoConnect() ||
      this.sessions.size !== 0 ||
      this.autoConnectPromise ||
      this.reconnectAttempts >= 3
    )
      return;
    const saved = this.savedReceiver();
    const receiver = this.receivers.find((item) => item.id === saved?.id);
    if (!saved || !receiver) return;
    this.reconnectAttempts++;
    const generation = this.generation;
    this.autoConnectPromise = this.connectToReceiver(
      receiver,
      saved.appId,
      true,
    )
      .then((snapshot) => {
        if (this.closed || generation !== this.generation) return null;
        this.emit({
          type: 'auto-connected',
          handle: snapshot.handle,
          snapshot,
        });
        return snapshot;
      })
      .catch((error: unknown) => {
        console.warn('[Google Cast] automatic connection failed', error);
        return null;
      })
      .finally(() => {
        if (this.closed || generation !== this.generation) return;
        this.autoConnectPromise = null;
        if (!this.activeSavedSession()) this.scheduleAutoReconnect();
      });
  }

  private localResumeUrl(): string {
    const savedUrl = config.get('options.resumeOnStart')
      ? config.get('url')
      : config.defaultConfig.url;
    try {
      return new URL(savedUrl).origin === 'https://music.youtube.com'
        ? savedUrl
        : config.defaultConfig.url;
    } catch {
      return config.defaultConfig.url;
    }
  }

  private async resume(event: IpcMainInvokeEvent): Promise<ResumeResult> {
    this.checkSender(event);
    const active = this.activeSavedSession();
    if (active) return { snapshot: active.snapshot(), fallbackUrl: null };
    if (!this.shouldAutoConnect()) return { snapshot: null, fallbackUrl: null };
    this.maybeAutoConnect();
    const generation = this.generation;
    for (
      let attempt = 0;
      attempt < 40 && !this.closed && generation === this.generation;
      attempt++
    ) {
      const session = this.activeSavedSession();
      if (session) return { snapshot: session.snapshot(), fallbackUrl: null };
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waits.delete(timer);
          resolve();
        }, 250);
        this.waits.set(timer, resolve);
      });
    }
    return {
      snapshot: null,
      fallbackUrl:
        !this.closed && generation === this.generation
          ? this.localResumeUrl()
          : null,
    };
  }

  private async showDialog(
    options: Electron.MessageBoxOptions,
  ): Promise<Electron.MessageBoxReturnValue> {
    if (this.dialogOpen) throw new Error('Cast dialog already open');
    this.dialogOpen = true;
    try {
      return await dialog.showMessageBox(this.window, options);
    } finally {
      this.dialogOpen = false;
    }
  }

  private async confirmStop(
    event: IpcMainInvokeEvent,
    handle: string,
  ): Promise<boolean> {
    const session = this.session(event, handle);
    const result = await this.showDialog({
      type: 'question',
      title: t('plugins.chromecast.name'),
      message: t('plugins.chromecast.dialog.stop.message', {
        receiverName: sanitizeReceiverName(session.snapshot().receiver.name),
      }),
      buttons: [
        t('plugins.chromecast.dialog.cancel'),
        t('plugins.chromecast.dialog.stop.confirm'),
      ],
      cancelId: 0,
      defaultId: 0,
    });
    return (
      !this.closed &&
      this.sessions.get(handle) === session &&
      result.response === 1
    );
  }

  private checkSender(event: IpcMainInvokeEvent): void {
    if (
      this.closed ||
      this.settings().enabled !== true ||
      event.sender !== this.window.webContents ||
      event.senderFrame !== this.window.webContents.mainFrame
    )
      throw new Error('Invalid Cast sender');
    if (new URL(event.senderFrame.url).origin !== 'https://music.youtube.com')
      throw new Error('Invalid Cast origin');
  }

  private async select(
    event: IpcMainInvokeEvent,
  ): Promise<{ id: string | null }> {
    this.checkSender(event);
    const receivers = this.receivers.slice(0, 24);
    if (receivers.length === 0) {
      await this.showDialog({
        type: 'info',
        title: t('plugins.chromecast.name'),
        message: t('plugins.chromecast.dialog.no-devices.message'),
        detail:
          t('plugins.chromecast.dialog.no-devices.detail') +
          (process.platform === 'darwin'
            ? ' ' + t('plugins.chromecast.dialog.no-devices.mac-detail')
            : ''),
        buttons: [t('plugins.chromecast.dialog.ok')],
      });
      return { id: null };
    }
    const buttons = [
      ...receivers.map((receiver) => sanitizeReceiverName(receiver.name)),
      t('plugins.chromecast.dialog.cancel'),
    ];
    const result = await this.showDialog({
      type: 'question',
      title: t('plugins.chromecast.name'),
      message: t('plugins.chromecast.dialog.choose-device'),
      buttons,
      cancelId: buttons.length - 1,
      defaultId: 0,
    });
    const selected = receivers[result.response];
    // A receiver can disappear while the picker is open.
    return {
      id:
        !this.closed &&
        selected &&
        this.receivers.some((item) => item.id === selected.id)
          ? selected.id
          : null,
    };
  }

  private session(
    event: IpcMainInvokeEvent,
    handle: unknown,
  ): CastDeviceSession {
    this.checkSender(event);
    if (!isSafeCastHandle(handle)) throw new Error('Invalid Cast session');
    const session = this.sessions.get(handle);
    if (!session) throw new Error('Cast session ended');
    return session;
  }

  private emit(value: CastSessionEvent): void {
    if (
      !this.closed &&
      !this.window.webContents.isDestroyed() &&
      new URL(this.window.webContents.getURL()).origin ===
        'https://music.youtube.com'
    )
      this.window.webContents.send(CAST_EVENT, value);
  }

  private async connectToReceiver(
    receiver: DiscoveredReceiver,
    appId: string,
    launch: boolean,
  ): Promise<CastSessionSnapshot> {
    if (!isSafeCastHost(receiver.host) || !isSafeCastPort(receiver.port))
      throw new Error('Cast receiver unavailable');
    if (this.closed) throw new Error('Cast service stopped');
    if (this.sessions.size !== 0)
      throw new Error('Cast session already admitted');
    const generation = this.generation;
    const session = new CastDeviceSession(
      sanitizeReceiverName(receiver.name),
      appId,
    );
    this.sessions.set(session.handle, session);
    this.receiverByHandle.set(session.handle, receiver.id);
    const current = () =>
      !this.closed &&
      generation === this.generation &&
      this.sessions.get(session.handle) === session;
    session.on('update', () => {
      if (!current()) return;
      this.emit({
        type: 'update',
        handle: session.handle,
        snapshot: session.snapshot(),
      });
    });
    session.on('stopped', (reason: CastSessionSnapshot['status']) => {
      if (!current()) return;
      this.sessions.delete(session.handle);
      this.receiverByHandle.delete(session.handle);
      this.emit({ type: 'stopped', handle: session.handle });
      if (reason === 'stopped') {
        store.set('plugins.chromecast.autoReconnectSuppressed', true);
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
      } else {
        this.scheduleAutoReconnect(1000);
      }
    });
    session.on('message', (namespace: string, data: string) => {
      if (!current()) return;
      this.emit({ type: 'message', handle: session.handle, namespace, data });
    });
    try {
      await session.connect(receiver, launch);
      if (!current()) throw new Error('Cast session replaced or stopped');
      return session.snapshot();
    } catch (error) {
      this.sessions.delete(session.handle);
      this.receiverByHandle.delete(session.handle);
      session.leave();
      throw error;
    }
  }

  private async connect(
    event: IpcMainInvokeEvent,
    request: Extract<Request, { op: 'connect' }>,
  ): Promise<CastSessionSnapshot> {
    this.checkSender(event);
    if (!isValidReceiverId(request.receiverId))
      throw new Error('Invalid Cast receiver');
    const receiver = this.receivers.find(
      (item) => item.id === request.receiverId,
    );
    if (!receiver) throw new Error('Cast receiver unavailable');
    if (!isSafeCastAppId(request.appId)) throw new Error('Invalid Cast app');
    const appId = request.appId;
    this.retireSessions();
    this.reconnectAttempts = 0;
    const generation = this.generation;
    this.manualConnectGeneration = generation;
    try {
      const snapshot = await this.connectToReceiver(receiver, appId, true);
      store.set('plugins.chromecast.lastReceiverId', receiver.id);
      store.set('plugins.chromecast.lastAppId', appId);
      store.set('plugins.chromecast.autoReconnectSuppressed', false);
      return snapshot;
    } finally {
      if (this.manualConnectGeneration === generation)
        this.manualConnectGeneration = null;
    }
  }

  private async handle(
    event: IpcMainInvokeEvent,
    request: Request,
  ): Promise<CastSessionSnapshot | void> {
    this.checkSender(event);
    if (
      !request ||
      typeof request !== 'object' ||
      typeof request.op !== 'string'
    )
      throw new Error('Invalid Cast request');
    if (request.op === 'connect') return this.connect(event, request);
    if (request.op === 'send') {
      if (
        typeof request.namespace !== 'string' ||
        ![
          'urn:x-cast:com.google.cast.media',
          'urn:x-cast:com.google.youtube.mdx',
        ].includes(request.namespace) ||
        request.namespace.length > 256
      )
        throw new Error('Invalid Cast namespace');
      if (typeof request.data !== 'string' || request.data.length > 1_000_000)
        throw new Error('Invalid Cast message');
      let data: unknown;
      try {
        data = JSON.parse(request.data);
      } catch {
        data = request.data;
      }
      this.session(event, request.handle).sendMessage(request.namespace, data);
      return;
    }
    if (request.op === 'volume') {
      if (typeof request.level !== 'number' || !Number.isFinite(request.level))
        throw new Error('Invalid volume');
      this.session(event, request.handle).setVolumeLevel(
        Math.max(0, Math.min(1, request.level)),
      );
      return;
    }
    if (request.op === 'mute') {
      if (typeof request.muted !== 'boolean') throw new Error('Invalid mute');
      this.session(event, request.handle).setMuted(request.muted);
      return;
    }
    if (request.op === 'load' || request.op === 'queue-load') {
      let encoded: string | undefined;
      try {
        encoded = JSON.stringify(request.request);
      } catch {
        throw new Error('Invalid Cast media');
      }
      if (!encoded || encoded.length > 1_000_000)
        throw new Error('Invalid Cast media');
    }
    if (request.op === 'load') {
      this.session(event, request.handle).loadMedia(request.request);
      return;
    }
    if (request.op === 'queue-load') {
      this.session(event, request.handle).queueLoad(request.request);
      return;
    }
    if (request.op === 'leave') {
      const session = this.session(event, request.handle);
      store.set('plugins.chromecast.autoReconnectSuppressed', true);
      session.leave();
      return;
    }
    if (request.op === 'stop') {
      const session = this.session(event, request.handle);
      store.set('plugins.chromecast.autoReconnectSuppressed', true);
      await session.stop();
      return;
    }
    throw new Error('Invalid Cast request');
  }
}
