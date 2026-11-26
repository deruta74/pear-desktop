'use strict';

const form = document.getElementById('add-video');
const source = document.getElementById('video-source');
const add = document.getElementById('add-button');
const errorText = document.getElementById('queue-error');
const statusText = document.getElementById('queue-status');
const selection = document.getElementById('selection-id');
const position = document.getElementById('position');
const previous = document.getElementById('previous');
const next = document.getElementById('next');
const openBrowser = document.getElementById('open-browser');
const queue = document.getElementById('queue-items');
const count = document.getElementById('queue-count');
const empty = document.getElementById('queue-empty');
const encoder = new TextEncoder();

let nextSequence = 1;
let pending = null;
let renderedState = null;

function send(command) {
  if (pending) return;

  const sequence = nextSequence;
  const message = JSON.stringify({ sequence, command });
  if (encoder.encode(message).length > 4096) {
    errorText.textContent =
      'This link is too long. Enter a shorter YouTube link or the video ID.';
    statusText.textContent = '';
    source.focus();
    return;
  }

  nextSequence = sequence === 0xffff_ffff ? 1 : sequence + 1;
  pending = {
    sequence,
    command,
    entryCount: renderedState?.entries.length ?? 0,
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

function createRow(id, current) {
  const row = document.createElement('li');
  row.className = 'queue-row';
  row.dataset.id = id;

  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'queue-select';
  select.setAttribute('aria-label', `Select ${id}`);
  select.addEventListener('click', () => send({ type: 'select', id }));

  const videoId = document.createElement('code');
  videoId.textContent = id;
  select.append(videoId);
  if (id === current) {
    select.setAttribute('aria-current', 'true');
    const selectedLabel = document.createElement('span');
    selectedLabel.className = 'selected-label';
    selectedLabel.textContent = 'Selected';
    select.append(selectedLabel);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'icon-button queue-remove';
  remove.setAttribute('aria-label', `Remove ${id}`);
  remove.title = `Remove ${id}`;
  remove.addEventListener('click', () => send({ type: 'remove', id }));

  const removeIcon = document.createElement('span');
  removeIcon.className = 'remove-icon';
  removeIcon.setAttribute('aria-hidden', 'true');
  remove.append(removeIcon);
  row.append(select, remove);
  return row;
}

function updateQueue(entries, current) {
  const active = document.activeElement;
  const focusedRow = queue.contains(active)
    ? active.closest('.queue-row')
    : null;

  queue.replaceChildren(...entries.map((id) => createRow(id, current)));
  queue.hidden = entries.length === 0;
  empty.hidden = entries.length !== 0;
  count.textContent = `${entries.length} ${entries.length === 1 ? 'video' : 'videos'}`;

  if (focusedRow) {
    const id = focusedRow.dataset.id;
    const index = entries.indexOf(id);
    if (index !== -1) {
      queue.children[index]
        .querySelector(
          active.classList.contains('queue-remove')
            ? '.queue-remove'
            : '.queue-select',
        )
        .focus();
    } else {
      const nearest = Math.min(
        renderedState.entries.indexOf(id),
        entries.length - 1,
      );
      (
        queue.children[nearest]?.querySelector('.queue-select') ?? source
      ).focus();
    }
  }
}

window.renderPearState = (
  { entries, current },
  error = null,
  notice = null,
  acknowledgedSequence = null,
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
  const active = document.activeElement;
  selection.textContent = hasSelection ? current : 'No video selected';
  selection.classList.toggle('has-video', hasSelection);
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
    entries.some((id, i) => id !== oldEntries[i]) ||
    current !== renderedState.current;
  if (changed) updateQueue(entries, current);
  renderedState = { entries, current };

  let confirmation = '';
  if (!error && command?.type === 'add') {
    if (source.value === command.source) source.value = '';
    confirmation =
      entries.length > acknowledged.entryCount
        ? 'Added to the queue.'
        : 'Video is already in the queue.';
  }
  if (error && command?.type === 'add' && active === add) source.focus();
  if (!error && command?.type === 'remove' && !entries.includes(command.id)) {
    confirmation = 'Removed from the queue.';
  }

  if (acknowledged || error !== null) errorText.textContent = error ?? '';
  statusText.textContent = [confirmation, notice].filter(Boolean).join(' ');
};

form.addEventListener('submit', (event) => {
  event.preventDefault();
  send({ type: 'add', source: source.value });
});
previous.addEventListener('click', () => send({ type: 'previous' }));
next.addEventListener('click', () => send({ type: 'next' }));
openBrowser.addEventListener('click', () => send({ type: 'open_browser' }));

send({ type: 'ready' });
