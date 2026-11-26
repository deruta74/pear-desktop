'use strict';

const form = document.getElementById('add-video');
const source = document.getElementById('video-source');
const add = document.getElementById('add-button');
const errorText = document.getElementById('queue-error');
const statusText = document.getElementById('queue-status');
const playerProblemText = document.getElementById('player-problem');
const metadataProblemText = document.getElementById('metadata-problem');
const selection = document.getElementById('selection-id');
const selectionPanel = selection.closest('.selection');
const position = document.getElementById('position');
const previous = document.getElementById('previous');
const playToggle = document.getElementById('play-toggle');
const next = document.getElementById('next');
const openBrowser = document.getElementById('open-browser');
const transportHint = document.getElementById('transport-hint');
const timeline = document.getElementById('transport-timeline');
const seek = document.getElementById('playback-position');
const elapsed = document.getElementById('elapsed');
const duration = document.getElementById('duration');
const queue = document.getElementById('queue-items');
const count = document.getElementById('queue-count');
const empty = document.getElementById('queue-empty');
const filter = document.getElementById('queue-filter');
const encoder = new TextEncoder();

let nextSequence = 1;
let pending = null;
let renderedState = null;
let renderedTransport = null;
let editingPosition = false;

function send(command) {
  if (pending) return;

  const sequence = nextSequence;
  const message = JSON.stringify({ sequence, command });
  if (message.length > 4096 || encoder.encode(message).length > 4096) {
    errorText.textContent =
      'This input is too long. Use shorter links or add fewer videos at a time.';
    statusText.textContent = '';
    source.focus();
    return;
  }

  nextSequence = sequence === 0xffff_ffff ? 1 : sequence + 1;
  pending = {
    sequence,
    command,
    entryCount: renderedState?.entries.length ?? 0,
    entryIndex: renderedState?.entries.indexOf(command.id) ?? -1,
  };
  if (command.type === 'add') add.setAttribute('aria-disabled', 'true');

  try {
    window.ipc.postMessage(message);
  } catch {
    pending = null;
    add.removeAttribute('aria-disabled');
    errorText.textContent =
      'Could not connect to the queue. Close and reopen the window to try again.';
    statusText.textContent = '';
  }
}

function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = String(seconds % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}`
    : `${minutes}:${remainder}`;
}

function updateElapsed() {
  const time = formatTime(seek.valueAsNumber);
  if (elapsed.textContent !== time) {
    elapsed.textContent = time;
  }
  const accessibleTime = `${time} of ${duration.textContent}`;
  if (seek.getAttribute('aria-valuetext') !== accessibleTime) {
    seek.setAttribute('aria-valuetext', accessibleTime);
  }
}

function updateTransport() {
  const transport = renderedTransport;
  const active = document.activeElement;
  const hasProblem = Boolean(playerProblemText.textContent);
  const canPlay = Boolean(
    transport?.ready &&
    transport.hasPlayed &&
    !transport.blocked &&
    !hasProblem,
  );
  const totalSeconds = Math.floor(transport?.duration ?? 0);
  const canSeek =
    canPlay &&
    Number.isFinite(transport.position) &&
    Number.isSafeInteger(totalSeconds) &&
    totalSeconds > 0;
  playToggle.hidden = !transport;
  playToggle.disabled = !canPlay;
  const playing = canPlay && transport.playing;
  const label = playing ? 'Pause video' : 'Play video';
  if (playToggle.title !== label) {
    playToggle.title = label;
    playToggle.setAttribute('aria-label', label);
    playToggle.toggleAttribute('data-playing', playing);
  }

  if (!canSeek) editingPosition = false;
  timeline.hidden = !canSeek;
  seek.disabled = !canSeek;
  if (canSeek && !editingPosition) {
    const currentSeconds = Math.min(
      totalSeconds,
      Math.max(0, Math.floor(transport.position)),
    );
    if (Number(seek.max) !== totalSeconds) seek.max = totalSeconds;
    if (seek.valueAsNumber !== currentSeconds) {
      seek.valueAsNumber = currentSeconds;
    }
    const totalTime = formatTime(totalSeconds);
    if (duration.textContent !== totalTime) duration.textContent = totalTime;
    updateElapsed();
  }

  let hint = '';
  if (transport && !hasProblem) {
    if (transport.blocked) hint = 'Playback controls unavailable.';
    else if (!transport.ready) hint = 'Loading playback controls…';
    else if (!transport.hasPlayed) hint = 'Start playback in the video pane.';
  }
  if (transportHint.textContent !== hint) transportHint.textContent = hint;

  if ((active === playToggle && !canPlay) || (active === seek && !canSeek)) {
    const fallback = openBrowser.disabled ? source : openBrowser;
    (canPlay ? playToggle : fallback).focus({ preventScroll: true });
  }
}

window.renderPearTransport = (transport) => {
  renderedTransport = transport;
  updateTransport();
};

function videoTitle(titles, id) {
  const title =
    titles && Object.prototype.hasOwnProperty.call(titles, id)
      ? titles[id]
      : null;
  return typeof title === 'string' ? title.trim() : '';
}

function updateSelectionAttribution(channel) {
  let attribution = selectionPanel.querySelector('.selection-attribution');
  if (!channel) {
    attribution?.remove();
    return;
  }
  if (!attribution) {
    attribution = document.createElement('p');
    attribution.className = 'selection-attribution';
    selection.after(attribution);
  }
  const label = `YouTube · ${channel}`;
  if (attribution.textContent !== label) {
    attribution.textContent = label;
    attribution.title = label;
  }
}

function rowAction(type, label, id, icon, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button queue-action';
  button.dataset.action = type;
  button.setAttribute('aria-label', label);
  button.title = label;
  if (disabled) {
    // Keep a move button focusable by script after it reaches a queue boundary.
    button.setAttribute('aria-disabled', 'true');
    button.tabIndex = -1;
  }
  button.addEventListener('click', () => {
    if (!disabled) send({ type, id });
  });

  const glyph = document.createElement('span');
  glyph.className = icon;
  glyph.setAttribute('aria-hidden', 'true');
  button.append(glyph);
  return button;
}

function createRow(id, title, current, index, lastIndex) {
  const label = title || id;
  const row = document.createElement('li');
  row.className = 'queue-row';
  row.dataset.id = id;
  row.toggleAttribute('data-current', id === current);

  const number = document.createElement('span');
  number.className = 'queue-index';
  number.setAttribute('aria-hidden', 'true');
  number.textContent = index + 1;

  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'queue-select';
  select.dataset.action = 'select';
  select.setAttribute('aria-label', `Select ${label}`);
  select.title = label;
  select.addEventListener('click', () => send({ type: 'select', id }));
  if (id === current) select.setAttribute('aria-current', 'true');

  const trackName = document.createElement('span');
  trackName.className = title ? 'queue-title' : 'queue-title video-id';
  trackName.dir = 'auto';
  trackName.textContent = label;
  select.append(trackName);

  row.append(
    number,
    select,
    rowAction('move_up', `Move ${label} up`, id, 'move-icon', index === 0),
    rowAction(
      'move_down',
      `Move ${label} down`,
      id,
      'move-icon move-icon-down',
      index === lastIndex,
    ),
    rowAction('remove', `Remove ${label}`, id, 'remove-icon'),
  );
  return row;
}

function applyFilter(entries, entryTitles) {
  const query = filter.value.trim().toLowerCase();
  const visibleRows = [];
  entries.forEach((id, index) => {
    const row = queue.children[index];
    const hidden =
      Boolean(query) &&
      !id.toLowerCase().includes(query) &&
      !entryTitles[index].toLowerCase().includes(query);
    if (row.hidden !== hidden) row.hidden = hidden;
    if (!hidden) visibleRows.push(row);
  });

  queue.hidden = visibleRows.length === 0;
  empty.hidden = visibleRows.length !== 0;
  empty.textContent = entries.length
    ? 'No matching videos.'
    : 'Add a YouTube video to start your queue.';
  const countLabel = `${entries.length} ${entries.length === 1 ? 'video' : 'videos'}`;
  const visibleCount = query
    ? `${visibleRows.length} of ${countLabel}`
    : countLabel;
  if (count.textContent !== visibleCount) count.textContent = visibleCount;
  return visibleRows;
}

function updateQueue(entries, current, entryTitles) {
  const active = document.activeElement;
  const focusedRow = queue.contains(active)
    ? active.closest('.queue-row')
    : null;
  const focusedIndex = focusedRow
    ? Array.from(queue.children)
        .filter((row) => !row.hidden)
        .indexOf(focusedRow)
    : -1;
  const previousScroll = queue.scrollTop;
  if (!entries.length) {
    if (active === filter) source.focus();
    filter.value = '';
  }
  filter.hidden = entries.length === 0;
  queue.replaceChildren(
    ...entries.map((id, index) =>
      createRow(id, entryTitles[index], current, index, entries.length - 1),
    ),
  );
  const visibleRows = applyFilter(entries, entryTitles);
  queue.scrollTop = previousScroll;

  if (focusedRow) {
    const row = visibleRows.find(
      (row) => row.dataset.id === focusedRow.dataset.id,
    );
    if (row) {
      row.querySelector(`[data-action="${active.dataset.action}"]`).focus();
    } else {
      const nearest = Math.min(focusedIndex, visibleRows.length - 1);
      const fallback = filter.hidden ? source : filter;
      (
        visibleRows[nearest]?.querySelector('.queue-select') ?? fallback
      ).focus();
    }
  }
}

window.renderPearState = (
  { entries, current, titles, metadata, metadataProblem },
  error = null,
  notice = null,
  acknowledgedSequence = null,
  playerProblem = null,
) => {
  const acknowledged =
    pending?.sequence === acknowledgedSequence ? pending : null;
  if (acknowledged) {
    pending = null;
    add.removeAttribute('aria-disabled');
  }

  const command = acknowledged?.command;
  if (command?.type === 'ready') {
    source.disabled = false;
    add.disabled = false;
  }

  const index = entries.indexOf(current);
  const hasSelection = index !== -1;
  const selectedMetadata = hasSelection ? metadata : null;
  const officialTitle = selectedMetadata?.title.trim();
  const entryTitles = entries.map((id) => videoTitle(titles, id));
  if (officialTitle) entryTitles[index] = officialTitle;
  const currentTitle = entryTitles[index];
  const selectionChanged =
    renderedState !== null && current !== renderedState.current;
  const active = document.activeElement;
  const selectionLabel = hasSelection
    ? currentTitle || current
    : 'No video selected';
  if (selection.textContent !== selectionLabel) {
    selection.textContent = selectionLabel;
    selection.title = hasSelection ? selectionLabel : '';
  }
  selection.classList.toggle('video-id', hasSelection && !currentTitle);
  updateSelectionAttribution(selectedMetadata?.channel.trim());
  selectionPanel.toggleAttribute('data-current', hasSelection);
  position.textContent = hasSelection
    ? `${index + 1} of ${entries.length}`
    : '';
  previous.disabled = index <= 0;
  next.disabled = !hasSelection || index >= entries.length - 1;
  openBrowser.disabled = !hasSelection;

  if (active === previous && previous.disabled)
    (next.disabled ? source : next).focus();
  if (active === next && next.disabled)
    (previous.disabled ? source : previous).focus();
  if (active === openBrowser && openBrowser.disabled) source.focus();

  const oldEntries = renderedState?.entries ?? [];
  const changed =
    !renderedState ||
    entries.length !== oldEntries.length ||
    entries.some(
      (id, i) =>
        id !== oldEntries[i] || entryTitles[i] !== renderedState.entryTitles[i],
    ) ||
    current !== renderedState.current;
  if (changed) updateQueue(entries, current, entryTitles);
  renderedState = { entries, current, entryTitles };

  let confirmation = '';
  if (!error && command?.type === 'add') {
    if (source.value === command.source) source.value = '';
    const added = entries.length - acknowledged.entryCount;
    if (added > 1) confirmation = `Added ${added} videos to the queue.`;
    else if (added === 1) confirmation = 'Added to the queue.';
    else if (command.source.trim().includes('\n'))
      confirmation = 'These videos are already in the queue.';
    else confirmation = 'Video is already in the queue.';
  }
  if (error && command?.type === 'add' && active === add) source.focus();
  if (!error && command?.type === 'remove' && !entries.includes(command.id)) {
    confirmation = 'Removed from the queue.';
  }
  if (
    !error &&
    (command?.type === 'move_up' || command?.type === 'move_down')
  ) {
    const movedIndex = entries.indexOf(command.id);
    if (movedIndex >= 0 && movedIndex !== acknowledged.entryIndex) {
      confirmation = `Moved to position ${movedIndex + 1} of ${entries.length}.`;
    }
  }

  if (acknowledged || error !== null) errorText.textContent = error ?? '';
  const problem = playerProblem ?? '';
  const problemChanged = playerProblemText.textContent !== problem;
  if (problemChanged) playerProblemText.textContent = problem;
  const providerProblem = metadataProblem ?? '';
  if (metadataProblemText.textContent !== providerProblem) {
    metadataProblemText.textContent = providerProblem;
  }
  if (selectionChanged) renderedTransport = null;
  if (selectionChanged || problemChanged) updateTransport();
  statusText.textContent = [confirmation, notice].filter(Boolean).join(' ');
};

form.addEventListener('submit', (event) => {
  event.preventDefault();
  send({ type: 'add', source: source.value });
});
source.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
filter.addEventListener('input', () => {
  if (!renderedState) return;
  const { entries, entryTitles } = renderedState;
  applyFilter(entries, entryTitles);
  queue.scrollTop = 0;
});
filter.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && filter.value && !event.isComposing) {
    event.preventDefault();
    filter.value = '';
    filter.dispatchEvent(new Event('input'));
  }
});
previous.addEventListener('click', () => send({ type: 'previous' }));
playToggle.addEventListener('click', () => {
  if (!playToggle.disabled) {
    send({ type: 'set_playback', playing: !renderedTransport.playing });
  }
});
next.addEventListener('click', () => send({ type: 'next' }));
openBrowser.addEventListener('click', () => send({ type: 'open_browser' }));

seek.addEventListener('pointerdown', () => {
  editingPosition = true;
});
window.addEventListener('pointerup', () => {
  editingPosition = false;
});
function cancelSeekPreview() {
  if (!editingPosition) return;
  editingPosition = false;
  updateTransport();
}
seek.addEventListener('pointercancel', cancelSeekPreview);
seek.addEventListener('blur', cancelSeekPreview);
window.addEventListener('blur', cancelSeekPreview);
seek.addEventListener('input', () => {
  editingPosition = true;
  updateElapsed();
});
seek.addEventListener('change', () => {
  editingPosition = false;
  if (seek.disabled) return;
  if (pending) {
    updateTransport();
    return;
  }
  const target = Math.min(
    seek.valueAsNumber,
    Math.floor(renderedTransport.duration),
  );
  send({ type: 'seek', position: target });
});

send({ type: 'ready' });
