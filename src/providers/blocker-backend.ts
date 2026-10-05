import { setBlockerDocument } from './blocker-documents';
import { setSessionBlockLists } from './blocker-session';

import type { AdblockerConfig } from '@/plugins/adblocker/types';
import type { BackendContext } from '@/types/contexts';

export const createBlockerBackend = (
  owner: string,
  defaultLists: () => Promise<string[]>,
) => {
  let session: Electron.Session | undefined;
  let revision = 0;
  const configure = async (config: AdblockerConfig, expected: number) => {
    const currentSession = session;
    if (!currentSession) return;
    if (!config.enabled || config.blocker !== 'With blocklists') {
      await setSessionBlockLists(currentSession, owner, null);
      return;
    }
    const disabled = Array.isArray(config.disableDefaultLists)
      ? config.disableDefaultLists.length > 0
      : config.disableDefaultLists;
    try {
      const defaults = disabled ? [] : await defaultLists();
      if (expected !== revision || session !== currentSession) return;
      const lists = [
        ...defaults,
        ...(config.additionalBlockLists ?? []),
      ].filter((url) => /^https?:\/\//i.test(url));
      // Custom lists may change in place; keep the legacy no-cache behavior.
      await setSessionBlockLists(
        currentSession,
        owner,
        lists,
        config.cache && !config.additionalBlockLists?.length,
      );
    } catch (error) {
      if (expected === revision) {
        await setSessionBlockLists(currentSession, owner, null);
        console.error(`[${owner}] Could not load blocklists`, error);
      }
    }
  };
  return {
    async start({ getConfig, window }: BackendContext<AdblockerConfig>) {
      const expected = ++revision;
      const previous = session;
      const current = window.webContents.session;
      session = current;
      // Bind before any await so a concurrent stop releases this same document.
      setBlockerDocument(current, owner, window.webContents);
      if (previous && previous !== current)
        await setSessionBlockLists(previous, owner, null);
      if (previous && previous !== current)
        setBlockerDocument(previous, owner, null);
      const config = await getConfig();
      if (expected === revision) await configure(config, expected);
    },
    async stop() {
      revision++;
      const previous = session;
      session = undefined;
      if (previous) {
        await setSessionBlockLists(previous, owner, null);
        setBlockerDocument(previous, owner, null);
      }
    },
    async onConfigChange(config: AdblockerConfig) {
      await configure(config, ++revision);
    },
  };
};
