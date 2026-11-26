'use strict';

const element = (id) => document.getElementById(id);
const open = element('open');
const track = element('track');
const seek = element('seek');
const play = element('play');
const volume = element('volume');
const speed = element('speed');
const intensity = element('intensity');
const highPass = element('high-pass');
const lowPass = element('low-pass');
const defaultHighPass = 180;
const defaultLowPass = 6500;
let current = null;
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

function renderPosition() {
  const label = time(seek.valueAsNumber);
  setText(element('elapsed'), label);
  if (seek.getAttribute('aria-valuetext') !== label) {
    seek.setAttribute('aria-valuetext', label);
  }
}

window.renderPearLocal = ({
  track: filename,
  transport,
  error,
  opening = false,
  settings,
  equalizer,
  presets,
  eqRevision,
}) => {
  current = transport;
  const wasHidden = element('player').hidden;
  const openHadFocus = document.activeElement === open;
  open.setAttribute('aria-disabled', String(opening));
  element('opening').hidden = !opening;
  element('player').hidden = element('effects').hidden = !transport;
  window.renderPearEqualizer?.(
    equalizer,
    presets,
    Boolean(transport),
    eqRevision,
  );
  element('empty').hidden = Boolean(transport) || opening;
  setText(element('problem'), transport?.error ?? error ?? '');
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
  if (!transport) return;
  setText(track, filename);
  const duration = Math.max(1, transport.durationMs);
  if (Number(seek.max) !== duration) seek.max = duration;
  if (!scrubbing && seek.valueAsNumber !== transport.positionMs) {
    seek.value = transport.positionMs;
  }
  renderPosition();
  setText(element('duration'), time(transport.durationMs));
  setText(play, transport.playing ? 'Pause' : 'Play');
  play.disabled = seek.disabled = Boolean(transport.error);
  if (wasHidden && openHadFocus) play.focus();
};

open.addEventListener('click', () => {
  if (open.getAttribute('aria-disabled') !== 'true') send('open');
});
play.addEventListener('click', () => {
  if (current) send('set_playing', { playing: !current.playing });
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
seek.addEventListener('change', () =>
  send('seek', { position_ms: seek.valueAsNumber }),
);

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
element('reset').addEventListener('click', () => {
  speed.value = 100;
  intensity.value = 0;
  highPass.value = defaultHighPass;
  lowPass.value = defaultLowPass;
  showSpeed();
  showIntensity();
  changeSpeed();
  changeReverb();
});
send('ready');
