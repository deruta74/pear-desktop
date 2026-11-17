import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import {
  crossfadeDefaults,
  parseCrossfadeMenu,
} from '../../src/plugins/crossfade/config';
import { resolvePlayableAudio } from '../../src/plugins/utils/main/playable-audio';
/** Executes actual menu/backend definition with external prompt/client boundaries only. */
export function crossfadeDefinition(
  boundaries: {
    prompt?: () => Promise<unknown>;
    yt?: unknown;
    mint?: () => Promise<string>;
  } = {},
) {
  const source = stripTypeScriptTypes(
    readFileSync(
      new URL('../../src/plugins/crossfade/index.ts', import.meta.url),
      'utf8',
    ),
  )
    .replace(/^import[\s\S]*?;\s*$/gm, '')
    .replace('export default', 'globalThis.plugin =');
  const context = vm.createContext({
    createPlugin: (value: unknown) => value,
    t: (key: string) => key,
    prompt: boundaries.prompt,
    promptOptions: () => ({}),
    crossfadeDefaults,
    parseCrossfadeMenu,
    resolvePlayableAudio,
    mintVideoProof:
      boundaries.mint ??
      (() => Promise.reject(new Error('No network in fixture'))),
    setupStreamEvaluator() {},
    AbortController,
    Innertube: { create: async () => boundaries.yt },
    getNetFetchAsFetch: () => () => {},
    console,
  });
  vm.runInContext(source, context);
  return context.plugin as any;
}
