import { contextBridge, ipcRenderer, webFrame } from 'electron';

import { isSafeCastAppId, isSafeCastHandle } from './endpoint';
import pageApiSource from './page-api.js?raw';

import type { CastSessionEvent, CastSessionSnapshot } from './session-types';

const CAST_SELECT = 'peard:cast:select';
const CAST_RESUME = 'peard:cast:resume';
const CAST_CONFIRM_STOP = 'peard:cast:confirm-stop';
const CAST_SESSION = 'peard:cast:session';
const CAST_EVENT = 'peard:cast:event';

export function setupCastBridge(): void {
  const listeners = new Set<(event: CastSessionEvent) => void>();
  let appId = '';
  let closed = false;

  const onEvent = (_event: unknown, event: CastSessionEvent) => {
    if (closed) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* Page listeners are isolated. */
      }
    }
  };
  ipcRenderer.on(CAST_EVENT, onEvent);
  window.addEventListener(
    'pagehide',
    () => {
      closed = true;
      listeners.clear();
      ipcRenderer.removeListener(CAST_EVENT, onEvent);
    },
    { once: true },
  );

  const sessionOp = async (payload: {
    op: string;
    handle?: unknown;
    namespace?: unknown;
    data?: unknown;
    level?: unknown;
    muted?: unknown;
    request?: unknown;
    receiverId?: string;
    appId?: string;
  }) => {
    if (closed) throw new Error('Cast document ended');
    if (payload.op !== 'connect' && !isSafeCastHandle(payload.handle))
      throw new Error('Invalid Cast handle');
    if (
      payload.op === 'send' &&
      (![
        'urn:x-cast:com.google.cast.media',
        'urn:x-cast:com.google.youtube.mdx',
      ].includes(String(payload.namespace)) ||
        typeof payload.data !== 'string' ||
        payload.data.length > 1_000_000)
    )
      throw new Error('Invalid Cast message');
    if (
      payload.op === 'volume' &&
      (typeof payload.level !== 'number' || !Number.isFinite(payload.level))
    )
      throw new Error('Invalid Cast volume');
    if (payload.op === 'mute' && typeof payload.muted !== 'boolean')
      throw new Error('Invalid Cast mute');
    if (payload.op === 'load' || payload.op === 'queue-load') {
      const encoded = JSON.stringify(payload.request);
      if (!encoded || encoded.length > 1_000_000)
        throw new Error('Invalid Cast media');
    }
    return ipcRenderer.invoke(
      CAST_SESSION,
      payload,
    ) as Promise<CastSessionSnapshot | void>;
  };

  contextBridge.exposeInMainWorld('__ytmdCastBridge', {
    initialize: (options: { appId?: string }) => {
      if (closed) return Promise.reject(new Error('Cast document ended'));
      appId = isSafeCastAppId(options?.appId) ? options.appId : 'CC1AD845';
      return Promise.resolve();
    },
    requestSession: async (): Promise<CastSessionSnapshot | null> => {
      if (closed) throw new Error('Cast document ended');
      const selection = (await ipcRenderer.invoke(CAST_SELECT)) as {
        id: string | null;
      };
      if (closed || !selection.id) return null;
      const snapshot = await sessionOp({
        op: 'connect',
        receiverId: selection.id,
        appId: appId || 'CC1AD845',
      });
      return closed
        ? null
        : ((snapshot as CastSessionSnapshot | undefined) ?? null);
    },
    resumeSession: () =>
      closed
        ? Promise.reject(new Error('Cast document ended'))
        : (ipcRenderer.invoke(CAST_RESUME) as Promise<{
            snapshot: CastSessionSnapshot | null;
            fallbackUrl: string | null;
          }>),
    sendMessage: async (handle: string, namespace: string, data: string) => {
      await sessionOp({ op: 'send', handle, namespace, data });
    },
    setVolume: async (handle: string, level: number) => {
      await sessionOp({ op: 'volume', handle, level });
    },
    setMuted: async (handle: string, muted: boolean) => {
      await sessionOp({ op: 'mute', handle, muted });
    },
    stop: async (handle: string) => {
      await sessionOp({ op: 'stop', handle });
    },
    leave: async (handle: string) => {
      await sessionOp({ op: 'leave', handle });
    },
    confirmStop: (handle: string): Promise<boolean> => {
      if (closed || !isSafeCastHandle(handle))
        return Promise.reject(new Error('Invalid Cast handle'));
      return ipcRenderer.invoke(CAST_CONFIRM_STOP, handle) as Promise<boolean>;
    },
    loadMedia: async (handle: string, request: unknown) => {
      await sessionOp({ op: 'load', handle, request });
    },
    queueLoad: async (handle: string, request: unknown) => {
      await sessionOp({ op: 'queue-load', handle, request });
    },
    onEvent: (listener: (event: CastSessionEvent) => void) => {
      if (closed || typeof listener !== 'function' || listeners.size >= 16)
        return;
      listeners.add(listener);
    },
  });

  // Run in page world, before YouTube Music initializes its Cast API.
  webFrame
    .executeJavaScriptInIsolatedWorld(0, [{ code: pageApiSource }])
    .catch(() => {
      // Navigation can end the document before injection finishes.
    });
}
