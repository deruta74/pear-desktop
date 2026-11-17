export type AutoMixConfig = {
  enabled: boolean;
  blendBeats: 4 | 8;
  maxSeconds: number;
};
export const autoMixDefaults: AutoMixConfig = {
  enabled: false,
  blendBeats: 8,
  maxSeconds: 6,
};
export const MAX_STREAM_BYTES = 16 * 1024 * 1024;
export const MAX_TRACK_SECONDS = 600;
