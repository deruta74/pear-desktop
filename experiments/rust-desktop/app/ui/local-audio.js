'use strict';

const element = (id) => document.getElementById(id);
const open = element('open');
const openFolder = element('open-folder');
const openLyrics = element('open-lyrics');
const lyricsPanel = element('local-lyrics');
const lyricsLine = element('lyrics-line');
const track = element('track');
const trackDetails = element('track-details');
const seek = element('seek');
const previous = element('previous');
const play = element('play');
const next = element('next');
const queueList = element('queue-tracks');
const shuffle = element('shuffle-upcoming');
const clearUpcoming = element('clear-upcoming');
const repeat = element('queue-repeat');
const volume = element('volume');
const speed = element('speed');
const intensity = element('intensity');
const highPass = element('high-pass');
const lowPass = element('low-pass');
const defaultHighPass = 180;
const defaultLowPass = 6500;
let current = null;
let queueState = { revision: 0, tracks: [], selected: null };
let opening = false;
let loadingLyrics = false;
let scrubbing = false;

function send(type, fields) {
  window.ipc.postMessage(JSON.stringify({ type, ...fields }));
}

function time(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function selectTrack(index) {
  const { revision, tracks } = queueState;
  if (!opening && index >= 0 && index < tracks.length) {
    send('select_track', { revision, index });
  }
}

function queueButton(index) {
  return queueList.children[index]?.firstElementChild;
}

function renderQueue() {
  const {
    tracks,
    selected,
    canShuffle,
    repeat: repeatMode = 'off',
  } = queueState;
  const focusedRow = queueList.querySelector('button:focus');
  const clearHadFocus = document.activeElement === clearUpcoming;
  const focusedIndex = Number(focusedRow?.dataset.index ?? -1);
  const tabStopIndex =
    focusedIndex >= 0 && focusedIndex < tracks.length
      ? focusedIndex
      : (selected ?? 0);
  while (queueList.children.length > tracks.length) {
    queueList.lastElementChild.remove();
  }
  for (const [index, filename] of tracks.entries()) {
    let button = queueButton(index);
    if (!button) {
      const row = document.createElement('li');
      button = document.createElement('button');
      button.type = 'button';
      button.dir = 'auto';
      button.dataset.index = index;
      button.addEventListener('click', () => selectTrack(index));
      row.append(button);
      queueList.append(row);
    }
    setText(button, filename);
    button.title = filename;
    button.setAttribute('aria-current', String(index === selected));
    button.setAttribute('aria-disabled', String(opening));
    button.tabIndex = index === tabStopIndex ? 0 : -1;
  }
  element('local-queue').hidden = tracks.length === 0;
  shuffle.setAttribute('aria-disabled', String(opening || !canShuffle));
  clearUpcoming.disabled =
    opening || selected === null || selected >= tracks.length - 1;
  repeat.disabled = opening || tracks.length === 0;
  if (repeat.value !== repeatMode) repeat.value = repeatMode;
  previous.setAttribute(
    'aria-disabled',
    String(opening || selected === null || selected === 0),
  );
  next.setAttribute(
    'aria-disabled',
    String(opening || selected === null || selected >= tracks.length - 1),
  );
  if (
    focusedIndex >= tracks.length ||
    (clearHadFocus && clearUpcoming.disabled)
  ) {
    (queueButton(tabStopIndex) ?? open).focus();
  }
}

queueList.addEventListener('focusin', ({ target }) => {
  if (!(target instanceof HTMLButtonElement) || target.tabIndex === 0) return;
  const tabStop = queueList.querySelector('button[tabindex="0"]');
  if (tabStop) tabStop.tabIndex = -1;
  target.tabIndex = 0;
});
queueList.addEventListener('keydown', (event) => {
  if (
    opening ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !(event.target instanceof HTMLButtonElement)
  ) {
    return;
  }
  const index = Number(event.target.dataset.index);
  const last = queueState.tracks.length - 1;
  const position = {
    ArrowUp: Math.max(0, index - 1),
    ArrowDown: Math.min(last, index + 1),
    Home: 0,
    End: last,
  }[event.key];
  const button = queueButton(position);
  if (!button) return;
  event.preventDefault();
  button.focus();
});

function renderPosition() {
  const label = time(seek.valueAsNumber);
  setText(element('elapsed'), label);
  if (seek.getAttribute('aria-valuetext') !== label) {
    seek.setAttribute('aria-valuetext', label);
  }
}

window.renderPearLocal = ({
  track: title,
  artist,
  album,
  transport,
  error,
  folderError,
  settingsError,
  lyrics,
  opening: isOpening = false,
  scanningFolder = false,
  selectingLyrics = false,
  queue,
  settings,
  equalizer,
  presets,
  eqRevision,
}) => {
  const keepPlayer = isOpening && !transport && Boolean(current);
  if (!keepPlayer) current = transport;
  const wasHidden = element('player').hidden;
  const openHadFocus =
    document.activeElement === open || document.activeElement === openFolder;
  if (queue || opening !== isOpening) {
    opening = isOpening;
    queueState = queue ?? queueState;
    renderQueue();
  }
  const importing = opening || scanningFolder;
  open.setAttribute('aria-disabled', String(importing || selectingLyrics));
  openFolder.setAttribute(
    'aria-disabled',
    String(importing || selectingLyrics),
  );
  const wasLoadingLyrics = loadingLyrics;
  loadingLyrics = Boolean(lyrics?.loading);
  const canOpenLyrics =
    Boolean(transport) && !importing && !selectingLyrics && !loadingLyrics;
  openLyrics.setAttribute('aria-disabled', String(!canOpenLyrics));
  if (lyrics?.available) {
    if (
      (lyricsPanel.hidden || wasLoadingLyrics) &&
      !loadingLyrics &&
      !lyrics.error
    )
      lyricsPanel.open = true;
    lyricsPanel.hidden = false;
  } else {
    if (lyricsPanel.contains(document.activeElement))
      (canOpenLyrics ? openLyrics : open).focus();
    lyricsPanel.hidden = true;
    lyricsPanel.open = false;
  }
  setText(lyricsLine, lyrics?.line ?? '');
  const status = element('opening');
  setText(
    status,
    scanningFolder
      ? 'Scanning audio folder…'
      : opening
        ? 'Opening audio…'
        : 'Opening lyrics file…',
  );
  status.hidden = !importing && !loadingLyrics;
  element('player').hidden = element('effects').hidden = !current;
  window.renderPearEqualizer?.(
    equalizer,
    presets,
    Boolean(current),
    eqRevision,
  );
  element('empty').hidden =
    Boolean(transport) || importing || queueState.tracks.length > 0;
  const problems = [
    transport?.error ?? error,
    folderError,
    settingsError,
    !loadingLyrics && lyrics?.error,
  ].filter(Boolean);
  setText(element('problem'), problems.join(' '));
  if (settings) {
    volume.value = Math.round(settings.volume * 100);
    speed.value = Math.round(settings.speed * 100);
    intensity.value = Math.round(settings.intensity * 100);
    highPass.dataset.saved = highPass.value = settings.highPassHz;
    lowPass.dataset.saved = lowPass.value = settings.lowPassHz;
    showVolume();
    showSpeed();
    showIntensity();
  }
  play.disabled = seek.disabled = opening || Boolean(current?.error);
  if (!transport) return;
  setText(track, title);
  const details = [artist, album].filter(Boolean).join(' · ');
  setText(trackDetails, details);
  trackDetails.hidden = !details;
  const duration = Math.max(1, transport.durationMs);
  if (Number(seek.max) !== duration) seek.max = duration;
  if (!scrubbing && seek.valueAsNumber !== transport.positionMs) {
    seek.value = transport.positionMs;
  }
  renderPosition();
  setText(element('duration'), time(transport.durationMs));
  setText(play, transport.playing ? 'Pause' : 'Play');
  if (wasHidden && openHadFocus && !play.disabled) play.focus();
};

open.addEventListener('click', () => {
  if (open.getAttribute('aria-disabled') !== 'true') send('open');
});
openFolder.addEventListener('click', () => {
  if (openFolder.getAttribute('aria-disabled') !== 'true') send('open_folder');
});
openLyrics.addEventListener('click', () => {
  if (openLyrics.getAttribute('aria-disabled') === 'false') send('open_lyrics');
});
previous.addEventListener('click', () => {
  if (queueState.selected !== null) selectTrack(queueState.selected - 1);
});
play.addEventListener('click', () => {
  if (current && !play.disabled)
    send('set_playing', { playing: !current.playing });
});
next.addEventListener('click', () => {
  if (queueState.selected !== null) selectTrack(queueState.selected + 1);
});
shuffle.addEventListener('click', () => {
  if (!opening && queueState.canShuffle)
    send('shuffle_upcoming', { revision: queueState.revision });
});
clearUpcoming.addEventListener('click', () => {
  if (!clearUpcoming.disabled) {
    const { revision, selected } = queueState;
    send('clear_upcoming', { revision, selected });
  }
});
repeat.addEventListener('change', () => {
  if (!repeat.disabled)
    send('set_repeat', { revision: queueState.revision, mode: repeat.value });
});
document.addEventListener('keydown', (event) => {
  if (
    event.code !== 'Space' ||
    !current ||
    play.disabled ||
    event.defaultPrevented ||
    event.isComposing ||
    event.repeat ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    (event.target instanceof Element &&
      event.target.closest(
        'input, textarea, select, button, a, summary, [contenteditable]',
      ))
  ) {
    return;
  }
  event.preventDefault();
  play.click();
});
seek.addEventListener('pointerdown', () => {
  scrubbing = true;
});
seek.addEventListener('pointerup', () => {
  scrubbing = false;
});
seek.addEventListener('pointercancel', () => {
  scrubbing = false;
});
seek.addEventListener('blur', () => {
  scrubbing = false;
});
seek.addEventListener('input', renderPosition);
seek.addEventListener('change', () => {
  if (current && !seek.disabled)
    send('seek', { position_ms: seek.valueAsNumber });
});

const percent = (value) => `${value}%`;
const rate = (value) => `${(value / 100).toFixed(2)}×`;
function showValue(input, format) {
  const output = element(`${input.id}-value`);
  const update = () => {
    const text = format(input.valueAsNumber);
    setText(output, text);
    if (input.getAttribute('aria-valuetext') !== text)
      input.setAttribute('aria-valuetext', text);
  };
  input.addEventListener('input', update);
  update();
  return update;
}
const showVolume = showValue(volume, percent);
const showSpeed = showValue(speed, rate);
const showIntensity = showValue(intensity, percent);

function changeSpeed() {
  send('set_speed', { speed: speed.valueAsNumber / 100 });
}
function cutoff(input, fallback) {
  if (!input.validity.valid || !input.value)
    input.value = input.dataset.saved ?? fallback;
  input.dataset.saved = input.value;
  return input.valueAsNumber;
}
function changeReverb() {
  send('set_reverb', {
    intensity: intensity.valueAsNumber / 100,
    high_pass_hz: cutoff(highPass, defaultHighPass),
    low_pass_hz: cutoff(lowPass, defaultLowPass),
  });
}
volume.addEventListener('change', () =>
  send('set_volume', { volume: volume.valueAsNumber / 100 }),
);
speed.addEventListener('change', changeSpeed);
for (const input of [intensity, highPass, lowPass])
  input.addEventListener('change', changeReverb);
element('reset').addEventListener('click', () => send('reset_effects'));
send('ready');
