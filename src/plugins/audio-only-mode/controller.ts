// Catalog preference based on #4732 by @Lian16. Deliberately experimental:
// load/cueVideoById queue continuation still needs a real YouTube Music check.

type Data = Record<string, unknown>;
const object = (value: unknown): Data | undefined =>
  value !== null && typeof value === 'object' ? (value as Data) : undefined;
const field = (value: unknown, key: string) => object(value)?.[key];
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
const primary = (row: unknown) =>
  field(row, 'playlistPanelVideoRenderer') ??
  field(
    field(field(row, 'playlistPanelVideoWrapperRenderer'), 'primaryRenderer'),
    'playlistPanelVideoRenderer',
  );

export interface CatalogPlayer {
  getVideoData(): { video_id?: string };
  getPlayerResponse(): {
    videoDetails?: { videoId?: string; musicVideoType?: string };
  };
  getCurrentTime(): number;
  getPlayerState(): number;
  loadVideoById: (videoId: string, time: number, quality: string) => void;
  cueVideoById?: (videoId: string, time: number, quality: string) => void;
  addEventListener(
    name: 'onStateChange' | 'videodatachange',
    callback: () => void,
  ): void;
  removeEventListener(
    name: 'onStateChange' | 'videodatachange',
    callback: () => void,
  ): void;
}

/** Event-driven, bounded retries; never mutates the queue or launches a watch navigation. */
export function createAudioOnlyController(
  player: CatalogPlayer,
  doc: Document,
  currentOwner: () => boolean = () => true,
) {
  const playerElement = doc.querySelector('#movie_player');
  const ownsPlayer = () => {
    const current = doc.querySelector('#movie_player');
    return (
      playerElement !== null &&
      playerElement === (player as unknown) &&
      current === playerElement
    );
  };
  let disposed = false,
    checking = false,
    identity: string | undefined;
  let attempts = 0,
    attempted = false;
  const sampleIdentity = () => {
    const response = player.getPlayerResponse()?.videoDetails;
    const id = player.getVideoData()?.video_id;
    return validId(id) && response?.videoId === id
      ? { id, type: response.musicVideoType }
      : undefined;
  };
  const queueBinding = () => {
    const element = doc.querySelector('#queue');
    const queue = field(element, 'queue');
    const store = object(field(field(queue, 'store'), 'store'));
    return { element, queue, store };
  };
  const check = () => {
    if (disposed || checking || !currentOwner() || !ownsPlayer()) return;
    checking = true;
    try {
      const current = sampleIdentity();
      if (!current || disposed || !currentOwner()) return;
      if (identity !== current.id) {
        identity = current.id;
        attempts = 0;
        attempted = false;
      }
      if (
        current.type !== 'MUSIC_VIDEO_TYPE_OMV' ||
        attempted ||
        attempts++ >= 12
      )
        return;
      const binding = queueBinding();
      const read = binding.store?.getState;
      if (typeof read !== 'function') return;
      const state = field(Reflect.apply(read, binding.store, []), 'queue');
      const rows = field(state, 'items'),
        index = field(state, 'selectedItemIndex');
      if (
        !Array.isArray(rows) ||
        rows.length > 1000 ||
        !Number.isInteger(index) ||
        typeof index !== 'number' ||
        index < 0 ||
        index >= rows.length
      )
        return;
      const row: unknown = rows[index];
      const selected = primary(row);
      if (
        field(selected, 'videoId') !== current.id ||
        field(selected, 'selected') !== true
      )
        return;
      const candidates = field(
        field(row, 'playlistPanelVideoWrapperRenderer'),
        'counterpart',
      );
      if (!Array.isArray(candidates) || candidates.length > 8) return;
      const ids = new Set<string>();
      for (const candidate of candidates) {
        const renderer = field(
          field(candidate, 'counterpartRenderer'),
          'playlistPanelVideoRenderer',
        );
        const endpoint = field(
          field(renderer, 'navigationEndpoint'),
          'watchEndpoint',
        );
        const kind = field(
          field(
            field(endpoint, 'watchEndpointMusicSupportedConfigs'),
            'watchEndpointMusicConfig',
          ),
          'musicVideoType',
        );
        const target = field(renderer, 'videoId');
        if (
          kind === 'MUSIC_VIDEO_TYPE_ATV' &&
          validId(target) &&
          field(endpoint, 'videoId') === target
        )
          ids.add(target);
      }
      if (ids.size !== 1) return;
      const target = [...ids][0];
      if (target === current.id) return;
      const time = player.getCurrentTime(),
        playback = player.getPlayerState();
      if (!Number.isFinite(time) || time < 0) return;
      const dispatch =
        playback === 1
          ? player.loadVideoById
          : playback === 2
            ? player.cueVideoById
            : undefined;
      if (typeof dispatch !== 'function') return;
      // Re-read immediately before dispatch: asynchronous DOM readiness and native
      // getters must not authorize a replacement for an old selected occurrence.
      const fresh = queueBinding();
      if (
        disposed ||
        !currentOwner() ||
        fresh.element !== binding.element ||
        fresh.queue !== binding.queue ||
        fresh.store !== binding.store ||
        fresh.store?.getState !== read
      )
        return;
      const latest = field(Reflect.apply(read, binding.store, []), 'queue');
      const latestRows = field(latest, 'items');
      const again = sampleIdentity();
      if (
        disposed ||
        !currentOwner() ||
        again?.id !== current.id ||
        again.type !== current.type ||
        latestRows !== rows ||
        field(latest, 'selectedItemIndex') !== index ||
        rows[index] !== row ||
        primary(row) !== selected ||
        field(selected, 'videoId') !== current.id
      )
        return;
      // Site getters above can synchronously stop or replace this controller.
      // Read DOM ownership first, then finish with only our local owner fence.
      const ownedPlayer = ownsPlayer();
      if (disposed || !currentOwner() || !ownedPlayer) return;
      attempted = true; // reserve before a synchronous player event can reenter
      Reflect.apply(dispatch, player, [target, time, 'default']);
    } catch {
      // Unsupported or changing native shapes leave the original track intact.
    } finally {
      checking = false;
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    player.removeEventListener('onStateChange', check);
    player.removeEventListener('videodatachange', check);
    doc.defaultView?.removeEventListener('pagehide', dispose);
  };
  player.addEventListener('onStateChange', check);
  player.addEventListener('videodatachange', check);
  doc.defaultView?.addEventListener('pagehide', dispose, { once: true });
  check();
  return { dispose };
}
