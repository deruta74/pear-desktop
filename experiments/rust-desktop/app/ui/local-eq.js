'use strict';

(() => {
  const get = (id) => document.getElementById(id);
  const enabled = get('eq-enabled');
  const layout = get('eq-layout');
  const automatic = get('eq-auto');
  const preamp = get('eq-preamp');
  const bands = get('eq-bands');
  const editor = get('eq-editor');
  const graph = get('eq-graph');
  const add = get('eq-add-band');
  const presetList = get('eq-preset-list');
  const presetName = get('eq-preset-name');
  const loadPreset = get('eq-load-preset');
  const deletePreset = get('eq-delete-preset');
  const confirmation = get('eq-confirm-preset');
  const context = graph.getContext('2d');
  const limits = {
    frequencyHz: [20, 20000, 0.01],
    gainDb: [-48, 48, 0.1],
    q: [0.05, 1000, 0.01],
  };
  let profile;
  let drag = null;
  let renderedLayout;
  let renderedCount = -1;
  let revision = 0;
  let nameToRemove;
  const drafts = new Map();

  function send(type, fields) {
    window.ipc.postMessage(JSON.stringify({ type, ...fields }));
  }

  function post() {
    revision = (revision + 1) >>> 0;
    send('set_equalizer', { profile, revision });
  }

  get('eq-save-preset').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = presetName.value.trim();
    if (name) send('save_equalizer_preset', { name });
  });
  loadPreset.addEventListener('click', () => {
    if (presetList.value) {
      revision = (revision + 1) >>> 0;
      send('load_equalizer_preset', { name: presetList.value, revision });
    }
  });
  deletePreset.addEventListener('click', () => {
    nameToRemove = presetList.value;
    get('eq-preset-question').textContent = `Remove “${nameToRemove}”?`;
    confirmation.hidden = false;
    get('eq-no-preset').focus();
  });
  get('eq-no-preset').addEventListener('click', () => {
    confirmation.hidden = true;
    deletePreset.focus();
  });
  get('eq-yes-preset').addEventListener('click', () => {
    if (nameToRemove) send('delete_equalizer_preset', { name: nameToRemove });
    confirmation.hidden = true;
    presetList.focus();
  });

  function showPresets(names) {
    const selection = presetList.value;
    const saved = presetName.value.trim();
    const list = names.map((name) => new Option(name, name));
    const justSaved =
      names.includes(saved) &&
      !Array.from(presetList.options).some((preset) => preset.value === saved);
    presetList.replaceChildren(
      ...(list.length ? list : [new Option('No saved presets', '')]),
    );
    loadPreset.disabled = deletePreset.disabled = list.length === 0;
    if (justSaved) {
      presetName.value = '';
      presetList.value = saved;
    } else if (names.includes(selection)) {
      presetList.value = selection;
    }
  }

  function flat(count) {
    const ratio = (16000 / 31.5) ** (1 / (count - 1));
    const root = Math.sqrt(ratio);
    return Array.from({ length: count }, (_, index) => ({
      frequencyHz: 31.5 * ratio ** index,
      gainDb: 0,
      q: 1 / (root - 1 / root),
    }));
  }

  function labelFrequency(frequency) {
    return frequency >= 1000
      ? `${Number((frequency / 1000).toFixed(2))} kHz`
      : `${Number(frequency.toFixed(1))} Hz`;
  }

  function numberField(index, key, label) {
    const field = document.createElement('input');
    field.type = 'number';
    [field.min, field.max, field.step] = limits[key];
    field.setAttribute('aria-label', label);
    field.dataset.band = index;
    field.dataset.key = key;
    field.addEventListener('change', () => {
      if (field.value && field.validity.valid) {
        profile.bands[index][key] = field.valueAsNumber;
        draw();
        post();
      } else {
        field.value = field.dataset.applied;
      }
    });
    return field;
  }

  function refreshValues() {
    for (const input of bands.querySelectorAll('input')) {
      const band = profile.bands[Number(input.dataset.band)];
      const precision = input.dataset.key === 'gainDb' ? 1 : 2;
      const value = String(Number(band[input.dataset.key].toFixed(precision)));
      setValue(input, value);
    }
  }

  function setValue(input, value) {
    const editing =
      document.activeElement === input &&
      input.dataset.applied !== undefined &&
      input.value !== input.dataset.applied;
    if (!editing && input.value !== value) input.value = value;
    input.dataset.applied = value;
  }

  function labeled(text, input) {
    const label = document.createElement('label');
    label.textContent = text;
    label.append(input);
    return label;
  }

  function refreshRows() {
    const custom = profile.layout === 'custom';
    if (
      renderedLayout !== profile.layout ||
      renderedCount !== profile.bands.length
    ) {
      renderedLayout = profile.layout;
      renderedCount = profile.bands.length;
      bands.toggleAttribute('data-custom', custom);
      bands.replaceChildren(
        ...profile.bands.map((band, index) => {
          const row = document.createElement('div');
          const name = document.createElement('span');
          name.textContent = custom
            ? `Band ${index + 1}`
            : labelFrequency(band.frequencyHz);
          row.append(name);
          const gain = numberField(
            index,
            'gainDb',
            `Gain for ${name.textContent.toLowerCase()} (dB)`,
          );
          if (custom) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = 'Remove';
            remove.setAttribute('aria-label', `Remove band ${index + 1}`);
            remove.addEventListener('click', () => {
              profile.bands.splice(index, 1);
              redraw();
              (bands.children[index]?.querySelector('input') ?? add).focus();
              post();
            });
            row.append(
              remove,
              labeled(
                'Frequency (Hz)',
                numberField(
                  index,
                  'frequencyHz',
                  `Frequency for band ${index + 1} (Hz)`,
                ),
              ),
              labeled('Gain (dB)', gain),
              labeled('Q', numberField(index, 'q', `Q for band ${index + 1}`)),
            );
          } else row.append(gain);
          return row;
        }),
      );
    }
    refreshValues();
  }

  const padding = 12;
  const xFor = (hz, width) =>
    padding + ((width - 2 * padding) * Math.log(hz / 20)) / Math.log(1000);
  const yFor = (db, height) => height / 2 - (db * (height - 2 * padding)) / 96;
  function draw() {
    if (
      !profile ||
      profile.layout !== 'custom' ||
      !context ||
      !graph.clientWidth
    )
      return;
    const { clientWidth: width, clientHeight: height } = graph;
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    graph.width = width * ratio;
    graph.height = height * ratio;
    context.scale(ratio, ratio);
    const colors = getComputedStyle(graph);
    context.strokeStyle = colors.getPropertyValue('--control-border');
    context.fillStyle = colors.getPropertyValue('--accent');
    context.beginPath();
    context.moveTo(padding, height / 2);
    context.lineTo(width - padding, height / 2);
    for (const hz of [20, 100, 1000, 10000, 20000]) {
      const x = xFor(hz, width);
      context.moveTo(x, padding);
      context.lineTo(x, height - padding);
    }
    context.stroke();
    for (const band of profile.bands) {
      context.beginPath();
      context.arc(
        xFor(band.frequencyHz, width),
        yFor(band.gainDb, height),
        5,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
  }

  function redraw() {
    editor.hidden = profile.layout !== 'custom';
    add.disabled = profile.bands.length >= 64;
    refreshRows();
    draw();
  }

  function addBand(band = { frequencyHz: 1000, gainDb: 0, q: 1 }) {
    if (profile.bands.length >= 64) return false;
    profile.bands.push(band);
    return true;
  }

  add.addEventListener('click', () => {
    if (addBand()) {
      redraw();
      bands.lastElementChild.querySelector('input').focus();
      post();
    }
  });

  const bound = (number) => Math.max(0, Math.min(1, number));
  function pointAt(event) {
    const box = graph.getBoundingClientRect();
    const x = bound(
      (event.clientX - box.left - padding) / (box.width - 2 * padding),
    );
    const y = bound(
      (event.clientY - box.top - padding) / (box.height - 2 * padding),
    );
    return {
      frequencyHz: Math.round(20 * 1000 ** x * 100) / 100,
      gainDb: Math.round((48 - 96 * y) * 10) / 10,
    };
  }

  graph.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag || !profile) return;
    const box = graph.getBoundingClientRect();
    const original = profile.bands.map((band) => ({ ...band }));
    let index = profile.bands.findIndex(
      (band) =>
        Math.hypot(
          event.clientX - box.left - xFor(band.frequencyHz, box.width),
          event.clientY - box.top - yFor(band.gainDb, box.height),
        ) < 12,
    );
    if (index === -1) {
      if (!addBand({ ...pointAt(event), q: 1 })) return;
      index = profile.bands.length - 1;
    }
    drag = { index, pointer: event.pointerId, original };
    graph.setPointerCapture(event.pointerId);
    draw();
  });
  graph.addEventListener('pointermove', (event) => {
    if (drag?.pointer !== event.pointerId) return;
    Object.assign(profile.bands[drag.index], pointAt(event));
    draw();
  });
  graph.addEventListener('pointerup', (event) => {
    if (drag?.pointer !== event.pointerId) return;
    drag = null;
    redraw();
    post();
  });
  for (const eventName of ['pointercancel', 'lostpointercapture']) {
    graph.addEventListener(eventName, (event) => {
      if (drag?.pointer !== event.pointerId) return;
      profile.bands = drag.original;
      drag = null;
      redraw();
    });
  }
  new ResizeObserver(draw).observe(graph);

  layout.addEventListener('change', () => {
    drafts.set(profile.layout, profile.bands);
    profile.layout = layout.value;
    profile.bands =
      drafts.get(profile.layout) ??
      (profile.layout === 'custom'
        ? []
        : flat(Number(profile.layout.slice(5))));
    redraw();
    post();
  });
  for (const control of [enabled, automatic, preamp]) {
    control.addEventListener('change', () => {
      profile.enabled = enabled.checked;
      profile.autoPreamp = automatic.checked;
      if (preamp.value && preamp.validity.valid)
        profile.preampDb = preamp.valueAsNumber;
      else preamp.value = profile.preampDb;
      preamp.disabled = automatic.checked;
      post();
    });
  }

  window.renderPearEqualizer = (
    next,
    presets,
    visible,
    acknowledgedRevision,
  ) => {
    get('local-eq').hidden = !visible;
    if (presets) showPresets(presets);
    if (
      !next ||
      (acknowledgedRevision !== undefined && acknowledgedRevision !== revision)
    )
      return;
    if (drag) return;
    profile = next;
    enabled.checked = profile.enabled;
    layout.value = profile.layout;
    automatic.checked = profile.autoPreamp;
    setValue(preamp, String(profile.preampDb));
    preamp.disabled = profile.autoPreamp;
    redraw();
  };
})();
