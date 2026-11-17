export interface PlayerInfo {
  hasSong: boolean;
  isPaused: boolean;
  volumePercent: number;
  seekbarCurrentPosition: number;
  seekbarCurrentPositionHuman: string;
  /** Unix timestamp in milliseconds, or zero when there is no measurement. */
  positionUpdatedAt: number;
  statePercent: number;
  likeStatus: string;
  repeatType: string;
}

export interface TrackInfo {
  author: string;
  title: string;
  album: string;
  cover: string;
  duration: number;
  durationHuman: string;
  url: string;
  id: string;
  isVideo: boolean;
  isAdvertisement: boolean;
  inLibrary: boolean;
  mediaType: string;
  playlistId: string;
}

export interface AmuseSongInfo {
  apiVersion: 2;
  player: PlayerInfo;
  track: TrackInfo;
}
