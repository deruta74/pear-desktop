import {
  selectCrossfadeAudioFormat,
  validCrossfadeStream,
  type AudioFormatCandidate,
  type StreamResult,
} from '@/plugins/crossfade/stream';

type AudioFormat<Player> = AudioFormatCandidate & {
  decipher(player?: Player): Promise<string> | string;
};
type AudioInfo<Player> = {
  basic_info: { id?: string; is_live?: boolean; is_live_content?: boolean };
  streaming_data?: { adaptive_formats?: AudioFormat<Player>[] };
};
type AudioClient<Player> = {
  session: { player?: Player };
  getBasicInfo(
    id: string,
    options?: { client: 'YTMUSIC'; po_token: string },
  ): Promise<AudioInfo<Player>>;
};

export async function resolvePlayableAudio<Player>(
  client: AudioClient<Player>,
  videoId: string,
  mint: (id: string, signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
): Promise<StreamResult | null> {
  if (!/^[\w-]{11}$/.test(videoId) || signal.aborted) return null;
  let token: string | undefined;
  try {
    token = await mint(videoId, signal);
  } catch {
    // Other clients can still return a playable audio stream without a token.
  }
  if (signal.aborted) return null;
  const read = async (proof?: string): Promise<StreamResult | null> => {
    try {
      signal.throwIfAborted();
      const { basic_info: info, streaming_data: streams } =
        await client.getBasicInfo(
          videoId,
          proof ? { client: 'YTMUSIC', po_token: proof } : undefined,
        );
      if (
        signal.aborted ||
        info.id !== videoId ||
        info.is_live ||
        info.is_live_content
      )
        return null;
      const format = selectCrossfadeAudioFormat(
        streams?.adaptive_formats ?? [],
      );
      if (!format) return null;
      const raw = await format.decipher(client.session.player);
      signal.throwIfAborted();
      const url = new URL(raw);
      if (proof) {
        if (
          url.hostname !== 'googlevideo.com' &&
          !url.hostname.endsWith('.googlevideo.com')
        )
          return null;
        url.searchParams.set('pot', proof);
      }
      const result = {
        url: url.href,
        mimeType: format.mime_type,
        contentLength: format.content_length!,
      };
      return validCrossfadeStream(result) ? result : null;
    } catch {
      return null;
    }
  };
  return (token ? await read(token) : null) ?? (await read());
}
