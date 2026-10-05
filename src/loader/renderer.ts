import { deepmerge } from 'deepmerge-ts';
import { rendererPlugins } from 'virtual:plugins';

import { t } from '@/i18n';
import { LoggerPrefix, startPlugin, stopPlugin } from '@/utils';

import type { RendererContext } from '@/types/contexts';
import type { PluginConfig, PluginDef } from '@/types/plugins';

const pluginStyleMap: Record<string, CSSStyleSheet[]> = {};
const pendingOperations = new Map<string, Promise<void>>();
const loadedPluginMap: Record<
  string,
  PluginDef<unknown, unknown, unknown>
> = {};

export const createContext = <Config extends PluginConfig>(
  id: string,
): RendererContext<Config> => ({
  getConfig: () =>
    window.ipcRenderer.invoke('peard:get-config', id) as Promise<Config>,
  setConfig: async (newConfig) => {
    await window.ipcRenderer.invoke('peard:set-config', id, newConfig);
  },
  ipc: {
    send: (event: string, ...args: unknown[]) => {
      window.ipcRenderer.send(event, ...args);
    },
    invoke: (event: string, ...args: unknown[]) =>
      window.ipcRenderer.invoke(event, ...args),
    on: (event: string, listener: CallableFunction) => {
      window.ipcRenderer.on(event, (_, ...args: unknown[]) => {
        // oxlint-disable-next-line typescript/no-unsafe-call
        listener(...args);
      });
    },
    removeAllListeners: (event: string) => {
      window.ipcRenderer.removeAllListeners(event);
    },
  },
});

// Keep enable/disable operations in request order, even when lifecycle hooks await.
const queuePluginOperation = (id: string, operation: () => Promise<void>) => {
  const pending = (pendingOperations.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(operation);
  pendingOperations.set(id, pending);
  return pending.finally(() => {
    if (pendingOperations.get(id) === pending) pendingOperations.delete(id);
  });
};

export const forceUnloadRendererPlugin = (id: string) =>
  queuePluginOperation(id, async () => {
    const plugin = loadedPluginMap[id];
    if (!plugin) return;

    const hasStopped = await stopPlugin(id, plugin, {
      ctx: 'renderer',
      context: createContext(id),
    });
    // Function renderers have no stop hook; retain their existing unload behavior.
    if (
      hasStopped !== false ||
      typeof plugin.renderer === 'function' ||
      !plugin.renderer
    ) {
      const stylesheets = pluginStyleMap[id];
      if (stylesheets) {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
          (style) => !stylesheets.includes(style),
        );
      }
      delete pluginStyleMap[id];
      delete loadedPluginMap[id];
      console.log(
        LoggerPrefix,
        t('common.console.plugins.unloaded', { pluginName: id }),
      );
    } else {
      console.error(
        LoggerPrefix,
        t('common.console.plugins.unload-failed', { pluginName: id }),
      );
    }
  });

export const forceLoadRendererPlugin = (id: string) =>
  queuePluginOperation(id, async () => {
    if (loadedPluginMap[id]) return;
    const plugin = (await rendererPlugins())[id];
    if (!plugin) return;

    const hasEvaled = await startPlugin(id, plugin, {
      ctx: 'renderer',
      context: createContext(id),
    });

    if (
      hasEvaled !== false &&
      (hasEvaled ||
        plugin?.stylesheets ||
        (hasEvaled === null &&
          typeof plugin?.renderer !== 'function' &&
          plugin?.renderer))
    ) {
      loadedPluginMap[id] = plugin;

      if (plugin?.stylesheets) {
        const styleSheetList = plugin.stylesheets.map((style) => {
          const styleSheet = new CSSStyleSheet();
          styleSheet.replaceSync(style);

          return styleSheet;
        });

        document.adoptedStyleSheets = [
          ...document.adoptedStyleSheets,
          ...styleSheetList,
        ];
        pluginStyleMap[id] = styleSheetList;
      }

      console.log(
        LoggerPrefix,
        t('common.console.plugins.loaded', { pluginName: id }),
      );
    } else {
      console.log(
        LoggerPrefix,
        t('common.console.plugins.initialize-failed', { pluginName: id }),
      );
    }
  });

export const loadAllRendererPlugins = async () => {
  const pluginConfigs = window.mainConfig.plugins.getPlugins();

  for (const [pluginId, pluginDef] of Object.entries(await rendererPlugins())) {
    const config = deepmerge(pluginDef.config, pluginConfigs[pluginId] ?? {});

    if (config.enabled) {
      await forceLoadRendererPlugin(pluginId);
    } else {
      if (loadedPluginMap[pluginId]) {
        await forceUnloadRendererPlugin(pluginId);
      }
    }
  }
};

export const unloadAllRendererPlugins = async () => {
  const ids = new Set([
    ...Object.keys(loadedPluginMap),
    ...pendingOperations.keys(),
  ]);
  for (const id of ids) {
    await forceUnloadRendererPlugin(id);
  }
};

export const getLoadedRendererPlugin = (
  id: string,
): PluginDef<unknown, unknown, unknown> | undefined => {
  return loadedPluginMap[id];
};

export const getAllLoadedRendererPlugins = () => {
  return loadedPluginMap;
};
