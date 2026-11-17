import { runInContext, runInNewContext } from 'node:vm';

import {
  BG,
  base64ToU8,
  buildURL,
  getHeaders,
  u8ToBase64,
  type WebPoSignalOutput,
} from 'bgutils-js';
import { Platform } from '\u0079\u006f\u0075\u0074\u0075\u0062\u0065i.js';

export function setupStreamEvaluator(): void {
  // youtubei.js 17.2 appends a function-body return to the extracted script.
  Platform.shim.eval = (script) =>
    runInNewContext(
      `(() => {\n${script.output}\n})()`,
      {},
      {
        timeout: 1000,
        contextCodeGeneration: { strings: false, wasm: false },
      },
    ) as Record<string, string>;
}

export async function untilAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        onAbort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error('Audio request cancelled'),
          );
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

// Adapted from pear-devs/pear-desktop #4774 by junxiangzhan.
export async function mintVideoProof(
  videoId: string,
  fetch: typeof globalThis.fetch,
  owner: AbortSignal,
): Promise<string> {
  const signal = AbortSignal.any([owner, AbortSignal.timeout(4000)]);
  const ownedFetch: typeof fetch = (input, init) =>
    fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    });
  let error: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const { Window } = await import('happy-dom');
    signal.throwIfAborted();
    const window = new Window({
      settings: { disableIframePageLoading: false },
    });
    try {
      const requestKey = 'O43z0dpjhgX20SCx4KAo';
      const challenge = await BG.Challenge.create({
        requestKey,
        fetch: ownedFetch,
        globalObj: window,
        identifier: videoId,
      });
      const script =
        challenge?.interpreterJavascript
          .privateDoNotAccessOrElseSafeScriptWrappedValue;
      signal.throwIfAborted();
      if (!challenge || !script) throw new Error('Missing proof challenge');
      runInContext(script, window, { timeout: 500 });
      const vm = await untilAborted(
        BG.BotGuardClient.create({
          program: challenge.program,
          globalName: challenge.globalName,
          globalObj: window,
        }),
        signal,
      );
      const output = runInContext('[]', window) as WebPoSignalOutput;
      const snapshot = await untilAborted(
        vm.snapshot({ webPoSignalOutput: output }, 1500),
        signal,
      );
      const response = await ownedFetch(buildURL('GenerateIT'), {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify([requestKey, snapshot]),
      });
      if (!response.ok) throw new Error('Proof service unavailable');
      const [proof] = (await response.json()) as [unknown];
      const createMinter = output[0];
      if (typeof proof !== 'string' || !createMinter)
        throw new Error('Invalid proof result');
      signal.throwIfAborted();
      const mint = await untilAborted(createMinter(base64ToU8(proof)), signal);
      const bytes = await untilAborted(
        mint(new TextEncoder().encode(videoId)),
        signal,
      );
      signal.throwIfAborted();
      if (!bytes?.length) throw new Error('Empty proof');
      return u8ToBase64(new Uint8Array(bytes), true);
    } catch (failure) {
      error = failure;
    } finally {
      await untilAborted(window.happyDOM.close(), AbortSignal.timeout(1000));
    }
  }
  throw error;
}
