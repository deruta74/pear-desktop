import { Innertube } from 'youtubei.js';

import { getNetFetchAsFetch } from '@/plugins/utils/main';
import { resolvePlayableAudio } from '@/plugins/utils/main/playable-audio';
import {
  mintVideoProof,
  setupStreamEvaluator,
} from '@/plugins/utils/main/video-proof';
import { createBackend } from '@/utils';

import { MAX_STREAM_BYTES, type AutoMixConfig } from './config';

export const backend = createBackend<
  { stopStreams?: () => void },
  AutoMixConfig
>({
  async start({ ipc }) {
    this.stopStreams?.();
    const owner = new AbortController();
    this.stopStreams = () => {
      owner.abort();
      ipc.removeHandler('peard:automix:audio-url');
    };
    const netFetch = getNetFetchAsFetch();
    const fetch: typeof netFetch = (input, init) =>
      netFetch(input, {
        ...init,
        signal: AbortSignal.any([
          owner.signal,
          AbortSignal.timeout(8000),
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
    setupStreamEvaluator();
    let yt: Awaited<ReturnType<typeof Innertube.create>>;
    try {
      yt = await Innertube.create({ fetch });
    } catch (error) {
      if (!owner.signal.aborted) throw error;
      return;
    }
    if (owner.signal.aborted) return;
    let pending = false;
    ipc.handle('peard:automix:audio-url', async (id: string) => {
      if (pending || owner.signal.aborted) return null;
      pending = true;
      try {
        const stream = await resolvePlayableAudio(
          yt,
          id,
          (videoId, signal) => mintVideoProof(videoId, fetch, signal),
          owner.signal,
        );
        return !owner.signal.aborted &&
          stream &&
          stream.contentLength <= MAX_STREAM_BYTES
          ? stream
          : null;
      } finally {
        pending = false;
      }
    });
  },
  stop() {
    this.stopStreams?.();
    this.stopStreams = undefined;
  },
});
