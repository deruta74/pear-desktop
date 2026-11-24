import { t } from '@/i18n';

import {
  clampIntensity,
  clampSlow,
  clampWetHighpass,
  clampWetLowpass,
  SLOW_MAX,
  SLOW_MIN,
} from './engine';

export interface SlowedReverbSectionState {
  slow: number;
  reverbIntensity: number;
  wetHighpass?: number;
  wetLowpass?: number;
  active: boolean;
}

export interface SlowedReverbSectionCallbacks {
  onActiveChange: (active: boolean) => void;
  onSlowLive: (value: number) => void;
  onSlowCommit: (value: number) => void;
  onReverbLive: (value: number) => void;
  onReverbCommit: (value: number) => void;
  onWetHighpassLive: (value: number) => void;
  onWetHighpassCommit: (value: number) => void;
  onWetLowpassLive: (value: number) => void;
  onWetLowpassCommit: (value: number) => void;
  onReset: () => void;
}

export interface SlowedReverbSectionHandle {
  root: HTMLElement;
  sync: (state: SlowedReverbSectionState) => void;
  destroy: () => void;
}

const THROTTLE_MS = 40;
const WHEEL_COMMIT_MS = 200;

function throttleLive(fn: (value: number) => void): (value: number) => void {
  let last = 0;
  return (value: number) => {
    const now = Date.now();
    if (now - last >= THROTTLE_MS) {
      last = now;
      fn(value);
    }
  };
}

function debounceTrailing(
  fn: (value: number) => void,
  ms: number,
): ((value: number) => void) & { cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest = 0;
  const wrapped = ((value: number) => {
    latest = value;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(latest);
    }, ms);
  }) as ((value: number) => void) & { cancel: () => void; flush: () => void };
  wrapped.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  wrapped.flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
      fn(latest);
    }
  };
  return wrapped;
}

interface SliderOptions {
  labelText: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  wheelStep?: number;
  scale?: number;
  initialValue: number;
  clampValue: (value: number) => number;
  onLive: (value: number) => void;
  onCommit: (value: number) => void;
}

function makeSliderRow({
  labelText,
  unit,
  min,
  max,
  step,
  wheelStep = step,
  scale = 1,
  initialValue,
  clampValue,
  onLive,
  onCommit,
}: SliderOptions) {
  const row = document.createElement('div');
  row.className = 'pbg-row pbg-reverb-row';
  const label = document.createElement('span');
  label.className = 'pbg-label';
  label.textContent = labelText;

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'pbg-range';
  const numberField = document.createElement('input');
  numberField.type = 'number';
  numberField.className = 'pbg-input pbg-reverb-number';
  for (const input of [slider, numberField]) {
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.setAttribute('aria-label', labelText);
  }
  const unitLabel = document.createElement('span');
  unitLabel.textContent = unit;
  unitLabel.setAttribute('aria-hidden', 'true');
  const entry = document.createElement('span');
  entry.className = 'pbg-reverb-entry';
  entry.append(numberField, unitLabel);
  row.append(label, slider, entry);

  const sync = (value: number) => {
    const previous = slider.value;
    slider.value = String(scale === 1 ? value : Math.round(value * scale));
    slider.setAttribute('aria-valuetext', `${slider.value} ${unit}`);
    // An IPC echo or another slider's commit can arrive during typing.
    if (
      document.activeElement !== numberField ||
      numberField.value === previous
    )
      numberField.value = slider.value;
  };
  sync(initialValue);

  const live = throttleLive(onLive);
  const wheelCommit = debounceTrailing(onCommit, WHEEL_COMMIT_MS);
  const applyPreview = (next: number) => {
    sync(next);
    numberField.value = slider.value;
    live(next);
  };
  const commitNumber = () => {
    const previous = clampValue(slider.valueAsNumber / scale);
    const entered = numberField.valueAsNumber;
    const next = Number.isFinite(entered)
      ? clampValue(entered / scale)
      : previous;
    sync(next);
    numberField.value = slider.value;
    if (next === previous) return;
    wheelCommit.cancel();
    onCommit(next);
  };
  numberField.addEventListener('change', commitNumber);
  numberField.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    commitNumber();
  });
  slider.addEventListener('input', () => {
    wheelCommit.cancel();
    applyPreview(clampValue(slider.valueAsNumber / scale));
  });
  slider.addEventListener('change', () => {
    wheelCommit.cancel();
    onCommit(clampValue(slider.valueAsNumber / scale));
  });
  slider.addEventListener(
    'wheel',
    (event) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const delta = event.deltaY < 0 ? wheelStep : -wheelStep;
      const next = clampValue((slider.valueAsNumber + delta) / scale);
      applyPreview(next);
      wheelCommit(next);
    },
    { passive: false },
  );
  return { row, sync, cancel: wheelCommit.cancel, flush: wheelCommit.flush };
}

export function createSlowedReverbSection(
  initial: SlowedReverbSectionState,
  callbacks: SlowedReverbSectionCallbacks,
): SlowedReverbSectionHandle {
  const root = document.createElement('div');
  root.className = 'pbg-body';

  const activeRow = document.createElement('label');
  activeRow.className = 'pbg-row';
  const activeBox = document.createElement('input');
  activeBox.type = 'checkbox';
  activeBox.className = 'pbg-check';
  activeBox.checked = initial.active;
  const activeLabel = document.createElement('span');
  activeLabel.className = 'pbg-label';
  activeLabel.textContent = t('plugins.slowed-reverb.panel.active');
  activeRow.append(activeBox, activeLabel);
  root.appendChild(activeRow);

  const speed = makeSliderRow({
    labelText: t('plugins.slowed-reverb.panel.speed'),
    unit: '×',
    min: SLOW_MIN,
    max: SLOW_MAX,
    step: 0.01,
    initialValue: clampSlow(initial.slow),
    clampValue: clampSlow,
    onLive: callbacks.onSlowLive,
    onCommit: callbacks.onSlowCommit,
  });
  const reverb = makeSliderRow({
    labelText: t('plugins.slowed-reverb.panel.reverb'),
    unit: '%',
    min: 0,
    max: 100,
    step: 1,
    scale: 100,
    initialValue: clampIntensity(initial.reverbIntensity),
    clampValue: clampIntensity,
    onLive: callbacks.onReverbLive,
    onCommit: callbacks.onReverbCommit,
  });
  const highpass = makeSliderRow({
    labelText: t('plugins.slowed-reverb.panel.wet-highpass'),
    unit: 'Hz',
    min: 20,
    max: 1000,
    step: 1,
    wheelStep: 10,
    initialValue: clampWetHighpass(initial.wetHighpass),
    clampValue: clampWetHighpass,
    onLive: callbacks.onWetHighpassLive,
    onCommit: callbacks.onWetHighpassCommit,
  });
  const lowpass = makeSliderRow({
    labelText: t('plugins.slowed-reverb.panel.wet-lowpass'),
    unit: 'Hz',
    min: 1000,
    max: 20000,
    step: 1,
    wheelStep: 100,
    initialValue: clampWetLowpass(initial.wetLowpass),
    clampValue: clampWetLowpass,
    onLive: callbacks.onWetLowpassLive,
    onCommit: callbacks.onWetLowpassCommit,
  });
  const sliders = [speed, reverb, highpass, lowpass];
  root.append(...sliders.map(({ row }) => row));

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'pbg-button';
  reset.textContent = t('plugins.slowed-reverb.panel.reset');
  root.appendChild(reset);

  activeBox.addEventListener('change', () => {
    callbacks.onActiveChange(activeBox.checked);
  });
  reset.addEventListener('click', () => {
    for (const slider of sliders) slider.cancel();
    callbacks.onReset();
  });

  return {
    root,
    sync: (state: SlowedReverbSectionState) => {
      activeBox.checked = state.active;
      speed.sync(clampSlow(state.slow));
      reverb.sync(clampIntensity(state.reverbIntensity));
      highpass.sync(clampWetHighpass(state.wetHighpass));
      lowpass.sync(clampWetLowpass(state.wetLowpass));
    },
    destroy: () => {
      // Persist any wheel adjustment still inside the debounce window.
      for (const slider of sliders) slider.flush();
      root.remove();
    },
  };
}
