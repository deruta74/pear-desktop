'use strict';

const form = document.getElementById('add-video');
const source = document.getElementById('video-source');
const add = document.getElementById('add-button');
const errorText = document.getElementById('queue-error');
const statusText = document.getElementById('queue-status');
const playerProblemText = document.getElementById('player-problem');
const metadataProblemText = document.getElementById('metadata-problem');
const preferencesProblemText = document.getElementById('preferences-problem');
const selection = document.getElementById('selection-id');
const selectionArtwork = document.getElementById('selection-artwork');
const selectionPanel = selection.closest('.selection');
const position = document.getElementById('position');
const previous = document.getElementById('previous');
const playToggle = document.getElementById('play-toggle');
const next = document.getElementById('next');
const openBrowser = document.getElementById('open-browser');
const audioToggle = document.getElementById('show-audio-controls');
const audioControls = document.getElementById('audio-controls');
const audioProblem = document.getElementById('audio-problem');
const volumeControl = document.getElementById('volume-control');
const volume = document.getElementById('playback-volume');
const volumeValue = document.getElementById('volume-value');
const mute = document.getElementById('playback-mute');
const transportHint = document.getElementById('transport-hint');
const timeline = document.getElementById('transport-timeline');
const seek = document.getElementById('playback-position');
const elapsed = document.getElementById('elapsed');
const duration = document.getElementById('duration');
const queue = document.getElementById('queue-items');
const queuePanel = document.getElementById('queue-panel');
const count = document.getElementById('queue-count');
const empty = document.getElementById('queue-empty');
const filter = document.getElementById('queue-filter');
const shuffle = document.getElementById('shuffle-upcoming');
const historyControls = document.getElementById('view-history');
const historyBack = document.getElementById('history-back');
const historyForward = document.getElementById('history-forward');
const viewSwitcherTemplate = document.getElementById('view-switcher-template');
const catalogTemplate = document.getElementById('catalog-template');
const lyricsTemplate = document.getElementById('lyrics-template');
const libraryTemplate = document.getElementById('library-template');
const panel = catalogTemplate.parentElement;
const legalPanel = document.getElementById('legal-panel');
const legalHeading = document.getElementById('legal-heading');
const legalProblemText = document.getElementById('legal-problem');
const acceptLegal = document.getElementById('accept-legal');
const declineLegal = document.getElementById('decline-legal');
const openLocalAudio = document.getElementById('open-local-audio');
const localAudioNote = document.getElementById('legal-local-audio-note');
const closeLegal = document.getElementById('close-legal');
const legalButtons = legalPanel.querySelectorAll('button');
const encoder = new TextEncoder();
const playlistDetails = document.getElementById('public-playlist');
const playlistForm = document.getElementById('public-playlist-form');
const playlistLink = document.getElementById('public-playlist-link');
const playlistFeedback = document.getElementById('public-playlist-feedback');
const returnToQueue = document.getElementById('return-to-queue');
const queueInputs = document.getElementById('queue-inputs');
const addLinks = document.getElementById('show-queue-inputs');
// The native transport polls once per second.
const LYRIC_SAMPLE_INTERVAL_MS = 1000;
const VIEW_HISTORY_LIMIT = 32;
const macShortcuts = navigator.platform.startsWith('Mac');

historyBack.title = macShortcuts ? 'Back (⌘[)' : 'Back (Alt+←)';
historyForward.title = macShortcuts ? 'Forward (⌘])' : 'Forward (Alt+→)';
historyBack.setAttribute(
  'aria-keyshortcuts',
  macShortcuts ? 'Meta+[' : 'Alt+ArrowLeft',
);
historyForward.setAttribute(
  'aria-keyshortcuts',
  macShortcuts ? 'Meta+]' : 'Alt+ArrowRight',
);

let nextSequence = 1;
let pending = null;
let renderedState = null;
let renderedTransport = null;
let playingPublicPlaylist = false;
let activeView = 'queue';
const viewHistory = [activeView];
let viewHistoryIndex = 0;
let interruptHistorySwipe;
let viewSwitcher = null;
let renderedCatalog = null;
let renderedBrowserSearch = false;
let catalogView = null;
let catalogSearchError = '';
let catalogPageError = '';
let browserSearchError = '';
let catalogAddFeedback = null;
let renderedLyrics = null;
let lyricsSwitchingActive = false;
let lyricsView = null;
let lyricsError = '';
let renderedLibrary = null;
let renderedAccount = null;
let accountFeedback = '';
let libraryView = null;
let libraryFeedback = null;
let lyricsClock = null;
let lyricCueTimer = null;
let lyricCueDeadline = null;
let pearPanelVisible = true;
let focusAddOnReady = false;
let queueInputsOpen = false;
let editingPosition = false;
let audioExpanded = false;
let editingVolume = false;
let renderedLegal = null;
let legalCommandProblem = '';
let focusBeforeLegal = null;

function commandProblem(message, context) {
  if (context === 'public-playlist') {
    playlistFeedback.textContent = message;
    return;
  }
  if (context === 'legal') {
    legalCommandProblem = message;
    updateLegalControls();
    return;
  }
  if (context === 'queue') {
    errorText.textContent = message;
    statusText.textContent = '';
    return;
  }
  if (context === 'lyrics') {
    lyricsError = message;
    updateLyrics(renderedLyrics);
    return;
  }
  if (context === 'audio') {
    audioProblem.textContent = message;
    updateAudioOutput();
    return;
  }
  if (context === 'account') {
    accountFeedback = message;
    if (libraryView)
      updateAccount(libraryView.account, Boolean(renderedLibrary?.selected));
    return;
  }
  if (context === 'library') {
    libraryFeedback = { message, error: true };
    updateLibrary(renderedLibrary);
    return;
  }
  if (context === 'browser-search') browserSearchError = message;
  else if (context === 'search') catalogSearchError = message;
  else if (context === 'playlist-page') catalogPageError = message;
  else catalogAddFeedback = { message, error: true };
  updateCatalog(renderedCatalog);
}

function primaryInput() {
  if (activeView === 'search' && catalogView) return catalogView.query;
  if (activeView === 'lyrics' && lyricsView) return lyricsView.track;
  if (activeView === 'library' && libraryView) {
    if (libraryView.account.open) return libraryView.account.heading;
    if (renderedLibrary?.selected) return libraryView.title;
    return libraryView.saveName.disabled
      ? libraryView.heading
      : libraryView.saveName;
  }
  if (!queueInputs.hidden) return source;
  return filter.hidden ? addLinks : filter;
}

function interruptsLyricsClock(command) {
  switch (command?.type) {
    case 'seek':
    case 'set_playback':
    case 'previous':
    case 'next':
      return true;
    case 'select':
      return command.id !== renderedState?.current;
    case 'select_playlist_track':
      return command.video !== renderedState?.current;
    case 'remove':
      return command.id === renderedState?.current;
    default:
      return false;
  }
}

function playNextUnavailable(id) {
  return (
    Boolean(pending) ||
    lyricsSwitchingActive ||
    id === renderedState?.current ||
    id === renderedState?.nextId
  );
}

function updateQueueAvailability() {
  const busy = Boolean(pending) || lyricsSwitchingActive;
  shuffle.setAttribute('aria-disabled', String(busy));
  for (const action of queue.querySelectorAll('[data-play-next]')) {
    const disabled = String(playNextUnavailable(action.dataset.playNext));
    if (action.getAttribute('aria-disabled') !== disabled)
      action.setAttribute('aria-disabled', disabled);
  }
}

function send(command, context = 'queue') {
  if (pending) return;
  if (
    context === 'legal'
      ? legalPanel.hidden
      : panel.hidden && command.type !== 'ready'
  )
    return;

  if (context === 'legal') legalCommandProblem = '';
  if (context === 'browser-search') browserSearchError = '';
  if (context === 'search') catalogSearchError = '';
  if (context === 'search' || context === 'playlist-page')
    catalogPageError = '';
  if (context === 'search' || context === 'result-add')
    catalogAddFeedback = null;
  if (context === 'lyrics') lyricsError = '';
  if (context === 'library') libraryFeedback = null;
  if (context === 'account') accountFeedback = '';
  if (context === 'audio') audioProblem.textContent = '';
  const sequence = nextSequence;
  const message = JSON.stringify({ sequence, command });
  if (message.length > 4096 || encoder.encode(message).length > 4096) {
    commandProblem(
      context === 'search' || context === 'browser-search'
        ? 'Enter a search of up to 160 characters.'
        : context === 'lyrics'
          ? 'Enter a track and artist of up to 160 characters each.'
          : 'This input is too long. Use shorter links or add fewer videos at a time.',
      context,
    );
    primaryInput().focus();
    return;
  }

  nextSequence = sequence === 0xffff_ffff ? 1 : sequence + 1;
  pending = {
    sequence,
    command,
    context,
    current: renderedState?.current,
    entryCount: renderedState?.entries.length ?? 0,
    entryIndex: renderedState?.entries.indexOf(command.id) ?? -1,
  };
  if (context === 'queue' && command.type === 'add') {
    add.setAttribute('aria-disabled', 'true');
  }
  if (interruptsLyricsClock(command)) {
    cancelLyricsClock();
    updateLyricsTiming();
  }

  try {
    window.ipc.postMessage(message);
  } catch {
    pending = null;
    add.removeAttribute('aria-disabled');
    commandProblem(
      context === 'legal'
        ? 'Could not connect to Pear. Close and reopen the window to try again.'
        : 'Could not connect to the queue. Close and reopen the window to try again.',
      context,
    );
    return;
  }
  if (context === 'legal') {
    updateLegalControls();
    return;
  }
  updateQueueAvailability();
  if (catalogView) updateCatalog(renderedCatalog);
  if (lyricsView) updateLyrics(renderedLyrics);
  if (libraryView) updateLibrary(renderedLibrary);
  updateAudioOutput();
}

function updateLegalControls() {
  const accepted = Boolean(renderedLegal?.accepted);
  acceptLegal.hidden = declineLegal.hidden = accepted;
  openLocalAudio.hidden = localAudioNote.hidden = accepted;
  closeLegal.hidden = !accepted;
  const disabled = String(Boolean(pending));
  for (const button of legalButtons) {
    if (button.getAttribute('aria-disabled') !== disabled)
      button.setAttribute('aria-disabled', disabled);
  }
  const problem = legalCommandProblem || renderedLegal?.problem || '';
  if (legalProblemText.textContent !== problem)
    legalProblemText.textContent = problem;
}

function updateLegal(legal) {
  const wasVisible = !legalPanel.hidden;
  const visible = Boolean(legal && (!legal.accepted || legal.show));
  renderedLegal = legal ?? null;

  if (visible && !wasVisible) {
    interruptHistorySwipe?.();
    const active = document.activeElement;
    focusBeforeLegal = panel.contains(active) ? active : null;
    editingPosition = false;
    editingVolume = false;
    cancelLyricsClock();
  }
  if (!visible) legalCommandProblem = '';
  panel.hidden = visible;
  panel.toggleAttribute('inert', visible);
  legalPanel.hidden = !visible;
  if (visible) updateLegalControls();
  if (visible && !wasVisible) {
    legalPanel.scrollTop = 0;
    legalHeading.focus({ preventScroll: true });
  }
  return wasVisible && !visible;
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

function updateVolumeValue() {
  const percent = `${volume.valueAsNumber}%`;
  if (volumeValue.textContent === percent) return;
  volumeValue.textContent = percent;
  volume.setAttribute('aria-valuetext', percent);
}

function updateAudioOutput() {
  const transport = renderedTransport;
  const level = transport?.volume;
  const hasVolume = Number.isInteger(level) && level >= 0 && level <= 100;
  const hasMute = typeof transport?.muted === 'boolean';
  const canAdjust = Boolean(
    transport?.ready && !transport.blocked && !playerProblemText.textContent,
  );
  const active = document.activeElement;

  audioToggle.hidden = !hasVolume && !hasMute;
  audioControls.hidden = audioToggle.hidden || !audioExpanded;
  audioToggle.parentElement.toggleAttribute('data-audio', !audioToggle.hidden);
  audioControls.parentElement.toggleAttribute(
    'data-paired',
    !audioControls.hidden && !timeline.hidden,
  );
  audioToggle.setAttribute('aria-expanded', String(!audioControls.hidden));
  volumeControl.hidden = !hasVolume;
  mute.hidden = !hasMute;
  volume.disabled = !canAdjust || !hasVolume;
  mute.disabled = !canAdjust || !hasMute;
  const busy = Boolean(pending);
  volume.setAttribute('aria-disabled', String(volume.disabled || busy));
  mute.setAttribute('aria-disabled', String(mute.disabled || busy));
  if (hasMute) mute.setAttribute('aria-pressed', String(transport.muted));

  if (volume.disabled || pending) editingVolume = false;
  if (hasVolume && !editingVolume) {
    const preview =
      volume.disabled || pending?.command.type !== 'set_volume'
        ? level
        : pending.command.volume;
    if (volume.valueAsNumber !== preview) volume.valueAsNumber = preview;
    updateVolumeValue();
  }

  const lostFocus =
    (active === volume && (volume.disabled || audioControls.hidden)) ||
    (active === mute && (mute.disabled || audioControls.hidden)) ||
    (active === audioToggle && audioToggle.hidden);
  if (lostFocus && !panel.hidden) {
    const fallback = openBrowser.disabled ? primaryInput() : openBrowser;
    (audioToggle.hidden ? fallback : audioToggle).focus({
      preventScroll: true,
    });
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
    const fallback = openBrowser.disabled ? primaryInput() : openBrowser;
    (canPlay ? playToggle : fallback).focus({ preventScroll: true });
  }
  updateAudioOutput();
}

window.renderPearTransport = (transport) => {
  if (playingPublicPlaylist || (panel.hidden && !renderedLegal?.accepted))
    return;
  const clockChanged =
    transport?.positionMs !== renderedTransport?.positionMs ||
    transport?.clockRunning !== renderedTransport?.clockRunning ||
    transport?.playbackRate !== renderedTransport?.playbackRate ||
    transport?.duration !== renderedTransport?.duration ||
    transport?.blocked !== renderedTransport?.blocked;
  renderedTransport = transport;
  updateTransport();
  if (clockChanged) receiveLyricsClock(transport);
  updateLyricsTiming();
};

function controlsVisible() {
  return pearPanelVisible && !panel.hidden && !document.hidden;
}

function updateLyricsVisibility() {
  if (!controlsVisible()) cancelLyricsClock();
  updateLyricsTiming();
}

window.setPearPanelVisible = (visible) => {
  if (pearPanelVisible !== Boolean(visible)) interruptHistorySwipe?.();
  pearPanelVisible = Boolean(visible);
  updateLyricsVisibility();
};
document.addEventListener('visibilitychange', updateLyricsVisibility);
window.addEventListener('pagehide', cancelLyricsClock);

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

selectionArtwork.addEventListener('error', () => {
  if (selectionArtwork.naturalWidth === 0) selectionArtwork.hidden = true;
});

function updateSelectionArtwork(id, url) {
  const approved =
    typeof id === 'string' &&
    /^[0-9A-Za-z_-]{11}$/.test(id) &&
    url === `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  if (selectionArtwork.getAttribute('src') === (approved ? url : null)) return;
  selectionArtwork.hidden = !approved;
  if (approved) selectionArtwork.src = url;
  else selectionArtwork.removeAttribute('src');
}

function rowAction(type, label, id, icon, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button queue-action';
  button.dataset.action = type;
  button.setAttribute('aria-label', label);
  button.title = label;
  if (disabled) {
    // Keep the action focusable by script after a queue reorder.
    button.setAttribute('aria-disabled', 'true');
    button.tabIndex = -1;
  }
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-disabled') !== 'true') send({ type, id });
  });

  const glyph = document.createElement('span');
  glyph.className = icon;
  glyph.setAttribute('aria-hidden', 'true');
  button.append(glyph);
  return button;
}

function createRow(id, title, current, index, lastIndex, nextId) {
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

  row.append(number, select);
  if (id !== current) {
    const playNext = rowAction(
      'play_next',
      `Play ${label} next`,
      id,
      'play-next-icon',
      id === nextId,
    );
    playNext.dataset.playNext = id;
    row.setAttribute('data-has-play-next', '');
    row.append(playNext);
  }
  row.append(
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

function updateQueue(entries, current, entryTitles, nextId) {
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
      createRow(
        id,
        entryTitles[index],
        current,
        index,
        entries.length - 1,
        nextId,
      ),
    ),
  );
  const visibleRows = applyFilter(entries, entryTitles);
  queue.scrollTop = previousScroll;

  if (focusedRow) {
    const row = visibleRows.find(
      (row) => row.dataset.id === focusedRow.dataset.id,
    );
    if (row) {
      const action = row.querySelector(
        `[data-action="${active.dataset.action}"]`,
      );
      (action ?? row.querySelector('.queue-select')).focus();
    } else {
      const nearest = Math.min(focusedIndex, visibleRows.length - 1);
      const fallback = filter.hidden ? source : filter;
      (
        visibleRows[nearest]?.querySelector('.queue-select') ?? fallback
      ).focus();
    }
  }
}

function viewAvailable(view) {
  return (
    view === 'queue' ||
    (view === 'search' && catalogView) ||
    (view === 'lyrics' && lyricsView) ||
    (view === 'library' && libraryView)
  );
}

function historyDestination(step) {
  for (
    let index = viewHistoryIndex + step;
    index >= 0 && index < viewHistory.length;
    index += step
  ) {
    const view = viewHistory[index];
    if (view !== activeView && viewAvailable(view)) return index;
  }
  return -1;
}

function updateViews() {
  if (!viewAvailable(activeView)) {
    interruptHistorySwipe?.();
    activeView = 'queue';
    viewHistory[viewHistoryIndex] = activeView;
  }

  const hasOptionalView = Boolean(catalogView || lyricsView || libraryView);
  const active = document.activeElement;
  historyControls.hidden = !hasOptionalView;
  historyBack.disabled = historyDestination(-1) < 0;
  historyForward.disabled = historyDestination(1) < 0;
  let restoreFocus = false;
  if (hasOptionalView && !viewSwitcher) {
    viewSwitcher =
      viewSwitcherTemplate.content.firstElementChild.cloneNode(true);
    const [queueButton, searchButton, lyricsButton, libraryButton] =
      viewSwitcher.children;
    queueButton.addEventListener('click', () => showView('queue'));
    searchButton.addEventListener('click', () => showView('search'));
    lyricsButton.addEventListener('click', () => showView('lyrics'));
    libraryButton.addEventListener('click', () => showView('library'));
    panel.querySelector('.panel-header').append(viewSwitcher);
  } else if (!hasOptionalView && viewSwitcher) {
    restoreFocus = viewSwitcher.contains(active);
    viewSwitcher.remove();
    viewSwitcher = null;
  }
  panel.toggleAttribute('data-view-switcher', hasOptionalView);

  if (viewSwitcher) {
    const [queueButton, searchButton, lyricsButton, libraryButton] =
      viewSwitcher.children;
    const names = ['Queue'];
    if (catalogView) names.push('search');
    if (lyricsView) names.push('lyrics');
    if (libraryView) names.push('library');
    const lastName = names.pop();
    viewSwitcher.setAttribute(
      'aria-label',
      `${names.join(', ')} and ${lastName}`,
    );
    searchButton.hidden = !catalogView;
    lyricsButton.hidden = !lyricsView;
    libraryButton.hidden = !libraryView;
    restoreFocus =
      (active === searchButton && searchButton.hidden) ||
      (active === lyricsButton && lyricsButton.hidden) ||
      (active === libraryButton && libraryButton.hidden);
    queueButton.setAttribute('aria-pressed', String(activeView === 'queue'));
    searchButton.setAttribute('aria-pressed', String(activeView === 'search'));
    lyricsButton.setAttribute('aria-pressed', String(activeView === 'lyrics'));
    libraryButton.setAttribute(
      'aria-pressed',
      String(activeView === 'library'),
    );
  }

  queuePanel.hidden = activeView !== 'queue';
  if (catalogView) {
    catalogView.form.hidden = activeView !== 'search';
    catalogView.results.hidden =
      catalogView.form.hidden || !catalogView.results.childElementCount;
  }
  if (lyricsView) {
    lyricsView.form.hidden = activeView !== 'lyrics';
    lyricsView.lines.hidden =
      lyricsView.form.hidden || !lyricsView.lines.childElementCount;
    if (lyricsView.form.hidden) lyricsView.gap.removeAttribute('data-running');
  }
  if (libraryView) libraryView.element.hidden = activeView !== 'library';
  if (restoreFocus || (historyControls.contains(active) && !viewSwitcher))
    primaryInput().focus();
  updateLyricsTiming();
}

function activateView(view) {
  if (activeView === 'lyrics' && view !== 'lyrics') cancelLyricsClock();
  activeView = view;
  updateViews();
}

function showView(view) {
  interruptHistorySwipe?.();
  if (!controlsVisible() || !viewAvailable(view)) return;
  if (view !== activeView) {
    viewHistory.length = viewHistoryIndex + 1;
    viewHistory.push(view);
    if (viewHistory.length > VIEW_HISTORY_LIMIT) viewHistory.shift();
    viewHistoryIndex = viewHistory.length - 1;
    activateView(view);
  }
  primaryInput().focus();
}

function traverseViewHistory(step) {
  if (!controlsVisible()) return false;
  const index = historyDestination(step);
  if (index < 0) return false;
  const focused = document.activeElement;
  viewHistoryIndex = index;
  activateView(viewHistory[index]);
  if (focused === document.body || focused?.closest('[hidden], :disabled')) {
    viewSwitcher?.querySelector('[aria-pressed="true"]')?.focus({
      preventScroll: true,
    });
  }
  return true;
}

function requestViewHistory(step) {
  interruptHistorySwipe?.();
  traverseViewHistory(step);
}

historyBack.addEventListener('click', () => requestViewHistory(-1));
historyForward.addEventListener('click', () => requestViewHistory(1));

if (window.pearExperimentalPanelSwipe === true) {
  interruptHistorySwipe = attachPanelHistorySwipes(
    panel,
    controlsVisible,
    (step) => {
      const from = viewHistoryIndex;
      if (!traverseViewHistory(step)) return null;
      const to = viewHistoryIndex;
      return () =>
        viewHistoryIndex === to && historyDestination(-step) === from;
    },
  );
}

document.addEventListener('keydown', (event) => {
  if (
    !controlsVisible() ||
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    event.ctrlKey ||
    event.shiftKey
  )
    return;

  const browserKey = !event.metaKey && !event.altKey;
  const shortcut = macShortcuts
    ? event.metaKey && !event.altKey
    : event.altKey && !event.metaKey;
  const backKey = macShortcuts ? '[' : 'ArrowLeft';
  const forwardKey = macShortcuts ? ']' : 'ArrowRight';
  const back =
    (browserKey && event.key === 'BrowserBack') ||
    (shortcut && event.key === backKey);
  const forward =
    (browserKey && event.key === 'BrowserForward') ||
    (shortcut && event.key === forwardKey);
  if (back || forward) {
    event.preventDefault();
    requestViewHistory(back ? -1 : 1);
  }
});

function updateQueueInputs(emptyQueue = renderedState?.entries.length === 0) {
  const active = document.activeElement;
  addLinks.hidden = emptyQueue;
  queueInputs.hidden = !queueInputsOpen && !emptyQueue;
  addLinks.setAttribute('aria-expanded', String(!queueInputs.hidden));
  if (emptyQueue && active === addLinks) source.focus();
}

function focusQueueAdd() {
  if (panel.hidden) {
    if (legalPanel.hidden) focusAddOnReady = true;
    return;
  }
  focusAddOnReady = source.disabled;
  queueInputsOpen = true;
  updateQueueInputs();
  showView('queue');
}

window.focusPearAdd = focusQueueAdd;

function mountCatalog(query) {
  const [searchForm, results] =
    catalogTemplate.content.cloneNode(true).children;
  const input = searchForm.querySelector('#catalog-query');
  const label = searchForm.querySelector('#catalog-query-label');
  const submit = searchForm.querySelector('button');
  const feedback = searchForm.querySelector('#catalog-feedback');
  const loadMore = searchForm.querySelector('#catalog-load-more');
  const pageFeedback = searchForm.querySelector('#catalog-page-feedback');
  const addFeedback = searchForm.querySelector('#catalog-add-feedback');
  input.value = query;
  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (pending) return;
    const query = input.value.trim();
    const context = renderedBrowserSearch ? 'browser-search' : 'search';
    if (!query) {
      catalogAddFeedback = null;
      commandProblem('Enter a search term.', context);
      input.focus();
      return;
    }
    if (renderedBrowserSearch) {
      if ([...query].length > 160) {
        commandProblem('Enter a search of up to 160 characters.', context);
        input.focus();
        return;
      }
      send({ type: 'open_music_search', query }, context);
      return;
    }
    input.value = query;
    send({ type: 'search', query }, 'search');
  });
  loadMore.addEventListener('click', () => {
    const playlist = renderedCatalog?.playlist;
    if (
      loadMore.hidden ||
      loadMore.getAttribute('aria-disabled') === 'true' ||
      !Number.isSafeInteger(playlist?.revision)
    )
      return;
    send(
      { type: 'load_more_playlist', revision: playlist.revision },
      'playlist-page',
    );
  });
  catalogTemplate.before(searchForm, results);
  return {
    form: searchForm,
    query: input,
    label,
    submit,
    feedback,
    loadMore,
    pageFeedback,
    addFeedback,
    results,
    renderedResults: [],
    renderedAsPlaylist: false,
    playlistRevision: undefined,
  };
}

function removeView(form, results) {
  const active = document.activeElement;
  const focused = form.contains(active) || results.contains(active);
  form.remove();
  results.remove();
  return focused;
}

function createCatalogResult({ id, title, channel }, playlist) {
  const row = document.createElement('li');
  row.className = 'catalog-result';
  const description = document.createElement('div');
  const name = document.createElement('p');
  name.className = 'queue-title catalog-title';
  name.dir = 'auto';
  name.textContent = title;
  name.title = title;
  const attribution = document.createElement('p');
  attribution.className = 'catalog-channel';
  attribution.textContent = channel ? `YouTube · ${channel}` : 'YouTube';
  attribution.title = attribution.textContent;
  description.append(name, attribution);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = playlist ? 'Open in browser' : 'Add';
  button.setAttribute(
    'aria-label',
    playlist ? `Open ${title} in YouTube Music` : `Add ${title} to queue`,
  );
  button.addEventListener('click', () => {
    const command = playlist
      ? { type: 'open_playlist_video', id }
      : { type: 'add', source: id };
    send(command, 'result-add');
  });
  const actions = document.createElement('div');
  actions.className = 'catalog-actions';
  actions.append(button);
  if (!playlist) {
    const playNext = document.createElement('button');
    playNext.type = 'button';
    playNext.dataset.playNext = id;
    playNext.textContent = 'Play next';
    playNext.setAttribute('aria-label', `Play ${title} next`);
    playNext.addEventListener('click', () => {
      if (!playNextUnavailable(id))
        send({ type: 'play_next', id }, 'result-add');
    });
    actions.append(playNext);
  }
  row.append(description, actions);
  return row;
}

function updateCatalog(catalog, browserSearch = renderedBrowserSearch) {
  if (renderedCatalog?.playlist && !catalog?.playlist)
    catalogAddFeedback = null;
  if (renderedCatalog?.playlist?.revision !== catalog?.playlist?.revision)
    catalogPageError = '';
  renderedCatalog = catalog ?? null;
  renderedBrowserSearch = !catalog && browserSearch === true;
  if (!renderedBrowserSearch) browserSearchError = '';
  if (!catalog) {
    catalogSearchError = '';
    catalogAddFeedback = null;
  }
  if (!catalog && !renderedBrowserSearch) {
    if (catalogView) {
      const wasFocused = removeView(catalogView.form, catalogView.results);
      catalogView = null;
      return wasFocused;
    }
    return false;
  }

  catalogView ??= mountCatalog(catalog?.query ?? '');
  const view = catalogView;
  const label = renderedBrowserSearch
    ? 'Search YouTube Music'
    : 'Search YouTube';
  const action = renderedBrowserSearch ? 'Open in browser' : 'Search';
  view.form.toggleAttribute('data-browser-search', renderedBrowserSearch);
  if (view.label.textContent !== label) view.label.textContent = label;
  if (view.submit.textContent !== action) view.submit.textContent = action;
  const placeholder = renderedBrowserSearch
    ? ''
    : 'Search or paste a public playlist link';
  if (view.query.placeholder !== placeholder)
    view.query.placeholder = placeholder;

  const searching =
    catalog && (catalog.pending || pending?.context === 'search');
  const results = searching ? [] : (catalog?.results ?? []);
  const playlist = catalog?.playlist;
  const asPlaylist = Boolean(playlist);
  const previousResults = view.renderedResults;
  const samePlaylist = view.playlistRevision === playlist?.revision;
  const preservesRows =
    asPlaylist === view.renderedAsPlaylist &&
    samePlaylist &&
    previousResults.every((previous, index) => {
      const result = results[index];
      return (
        result &&
        result.id === previous.id &&
        result.title === previous.title &&
        result.channel === previous.channel
      );
    });
  if (!preservesRows || results.length !== previousResults.length) {
    if (asPlaylist && preservesRows) {
      view.results.append(
        ...results
          .slice(previousResults.length)
          .map((result) => createCatalogResult(result, true)),
      );
    } else {
      if (view.results.contains(document.activeElement)) view.query.focus();
      view.results.replaceChildren(
        ...results.map((result) => createCatalogResult(result, asPlaylist)),
      );
    }
    view.results.setAttribute(
      'aria-label',
      asPlaylist ? 'YouTube playlist videos' : 'YouTube results',
    );
    view.renderedResults = results;
    view.renderedAsPlaylist = asPlaylist;
    view.playlistRevision = playlist?.revision;
  }
  view.results.hidden = view.form.hidden || !results.length;
  const controlsBusy = Boolean(pending);
  view.submit.setAttribute('aria-disabled', String(controlsBusy));
  const loadingPage = playlist?.pending || pending?.context === 'playlist-page';
  const canLoadMore = !searching && playlist?.hasMore;
  const loadMoreHadFocus = document.activeElement === view.loadMore;
  view.loadMore.hidden = !canLoadMore;
  view.loadMore.setAttribute(
    'aria-disabled',
    String(controlsBusy || loadingPage),
  );
  if (!canLoadMore && loadMoreHadFocus)
    (results.length && !searching ? view.results : view.query).focus({
      preventScroll: true,
    });

  const pageProblem = !searching && (catalogPageError || playlist?.problem);
  let pageMessage = '';
  if (!searching && playlist) {
    if (loadingPage) pageMessage = 'Loading more videos…';
    else if (pageProblem) pageMessage = pageProblem;
    else if (playlist.truncated)
      pageMessage = 'Reached the playlist preview limit.';
  }
  view.pageFeedback.classList.toggle(
    'error',
    !loadingPage && Boolean(pageProblem),
  );
  if (view.pageFeedback.textContent !== pageMessage)
    view.pageFeedback.textContent = pageMessage;

  for (const button of view.results.querySelectorAll('button')) {
    const id = button.dataset.playNext;
    const disabled = id ? playNextUnavailable(id) : controlsBusy;
    button.setAttribute('aria-disabled', String(disabled));
  }

  let message = '';
  let error = false;
  const searchError = renderedBrowserSearch
    ? browserSearchError
    : catalogSearchError;
  if (searchError) {
    message = searchError;
    error = true;
  } else if (renderedBrowserSearch && pending?.context === 'browser-search') {
    message = 'Opening YouTube Music…';
  } else if (searching) {
    message = asPlaylist
      ? 'Loading the YouTube playlist…'
      : 'Searching YouTube…';
  } else if (catalog?.problem) {
    message = catalog.problem;
    error = true;
  } else if (playlist) {
    const videos =
      results.length === 1 ? '1 video' : `${results.length} videos`;
    message = [
      `${videos} loaded`,
      playlist.unavailable ? `${playlist.unavailable} unavailable` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  } else if (catalog?.query) {
    message = results.length
      ? `${results.length} ${results.length === 1 ? 'video' : 'videos'} found.`
      : 'No videos found. Try a different search.';
  }
  view.feedback.classList.toggle('error', error);
  if (view.feedback.textContent !== message)
    view.feedback.textContent = message;
  const addMessage = catalogAddFeedback?.message ?? '';
  view.addFeedback.classList.toggle(
    'error',
    Boolean(catalogAddFeedback?.error),
  );
  if (view.addFeedback.textContent !== addMessage) {
    view.addFeedback.textContent = addMessage;
  }
  return false;
}

function playlistName(input) {
  const name = input.value.trim();
  if (name && [...name].length <= 80) return name;
  commandProblem('Enter a playlist name from 1 to 80 characters.', 'library');
  input.focus();
  return null;
}

function mountLibrary() {
  const element = libraryTemplate.content.firstElementChild.cloneNode(true);
  const get = (id) => element.querySelector(`#${id}`);
  const view = {
    element,
    browser: get('playlist-browser'),
    heading: get('playlist-heading'),
    saveForm: get('save-playlist'),
    saveName: get('save-playlist-name'),
    save: get('save-playlist-button'),
    detail: get('playlist-detail'),
    back: get('close-playlist'),
    title: get('playlist-title'),
    actions: get('playlist-actions'),
    append: get('append-playlist'),
    rename: get('edit-playlist'),
    remove: get('delete-playlist'),
    renameForm: get('rename-playlist'),
    renameName: get('rename-playlist-name'),
    saveRename: get('rename-playlist-button'),
    cancelRename: get('cancel-rename'),
    confirm: get('confirm-playlist-removal'),
    cancelRemoval: get('cancel-removal'),
    removePermanently: get('remove-playlist-button'),
    problem: get('library-problem'),
    feedback: get('library-feedback'),
    empty: get('library-empty'),
    list: get('saved-playlists'),
    tracks: get('playlist-tracks'),
    account: mountAccount(get),
    mode: null,
    listScroll: 0,
  };

  view.saveForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (pending || view.save.disabled) return;
    const name = playlistName(view.saveName);
    if (name) send({ type: 'save_playlist', name }, 'library');
  });
  view.renameForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (pending || view.saveRename.disabled) return;
    const name = playlistName(view.renameName);
    if (name)
      send(
        { type: 'rename_playlist', id: renderedLibrary.selected.id, name },
        'library',
      );
  });
  view.list.addEventListener('click', (event) => {
    const row = event.target.closest('button[data-id]');
    if (row)
      send({ type: 'open_playlist', id: Number(row.dataset.id) }, 'library');
  });
  view.tracks.addEventListener('click', (event) => {
    const row = event.target.closest('button[data-id]');
    if (row)
      send(
        {
          type: 'select_playlist_track',
          id: renderedLibrary.selected.id,
          video: row.dataset.id,
        },
        'library',
      );
  });
  view.back.addEventListener('click', () =>
    send({ type: 'close_playlist' }, 'library'),
  );
  view.append.addEventListener('click', () =>
    send(
      { type: 'append_playlist', id: renderedLibrary.selected.id },
      'library',
    ),
  );
  view.removePermanently.addEventListener('click', () =>
    send(
      { type: 'remove_playlist', id: renderedLibrary.selected.id },
      'library',
    ),
  );

  function changeMode(mode, focus) {
    if (pending) return;
    view.mode = mode;
    libraryFeedback = null;
    updateLibrary(renderedLibrary);
    focus.focus();
  }
  view.rename.addEventListener('click', () => {
    if (pending) return;
    view.renameName.value = renderedLibrary.selected.name;
    changeMode('rename', view.renameName);
  });
  view.remove.addEventListener('click', () =>
    changeMode('remove', view.cancelRemoval),
  );
  view.cancelRename.addEventListener('click', () =>
    changeMode(null, view.rename),
  );
  view.cancelRemoval.addEventListener('click', () =>
    changeMode(null, view.remove),
  );
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !view.mode || pending) return;
    event.preventDefault();
    changeMode(null, view.mode === 'rename' ? view.rename : view.remove);
  });

  libraryTemplate.before(element);
  return view;
}

function mountAccount(get) {
  const view = {
    show: get('show-youtube-account'),
    back: get('show-saved-playlists'),
    panel: get('youtube-account'),
    heading: get('youtube-account-heading'),
    status: get('youtube-account-status'),
    disclosure: get('youtube-account-disclosure'),
    connect: get('connect-account'),
    cancel: get('cancel-account'),
    disconnect: get('disconnect-account'),
    collections: get('account-collections'),
    playlists: get('account-playlists'),
    liked: get('account-liked'),
    title: get('account-playlist-title'),
    retry: get('retry-account-page'),
    next: get('next-account-page'),
    rows: get('youtube-account-rows'),
    open: false,
    page: null,
  };
  view.show.addEventListener('click', () => {
    view.open = true;
    updateLibrary(renderedLibrary);
    view.heading.focus();
  });
  view.back.addEventListener('click', () => {
    view.open = false;
    updateLibrary(renderedLibrary);
    view.show.focus();
  });
  for (const [button, type, fields] of [
    [view.connect, 'connect_account'],
    [view.cancel, 'cancel_account'],
    [view.disconnect, 'disconnect_account'],
    [
      view.playlists,
      'show_account_collection',
      { collection: 'owned_playlists' },
    ],
    [view.liked, 'show_account_collection', { collection: 'liked_videos' }],
    [view.retry, 'retry_account_page'],
  ]) {
    button.addEventListener('click', () => {
      if (!button.hidden && button.getAttribute('aria-disabled') !== 'true') {
        send({ type, ...fields }, 'account');
      }
    });
  }
  view.next.addEventListener('click', () => {
    if (!view.next.hidden && view.page !== null) {
      send({ type: 'next_account_page', page: view.page }, 'account');
    }
  });
  view.rows.addEventListener('click', (event) => {
    const row = event.target.closest('button[data-row]');
    if (row && view.page !== null) {
      const type =
        renderedAccount.collection === 'owned_playlists'
          ? 'open_account_playlist'
          : 'open_account_video';
      send({ type, page: view.page, row: Number(row.dataset.row) }, 'account');
    }
  });
  return view;
}

function updateAccount(view, selected) {
  const account = renderedAccount;
  if (!account) view.open = false;
  const active = document.activeElement;
  const hadFocus = view.panel.contains(active) || view.rows.contains(active);
  view.show.hidden = !account || view.open || selected;
  view.panel.hidden = !view.open;

  view.connect.hidden = account?.status !== 'disconnected';
  view.cancel.hidden = account?.status !== 'connecting';
  view.disconnect.hidden = account?.status !== 'connected';
  view.collections.hidden = account?.status !== 'connected';
  view.disclosure.hidden = account?.status !== 'disconnected';
  view.title.hidden = !account?.title;
  libraryText(view.title, account?.title ?? '');
  view.next.hidden = !account?.hasNext;
  view.retry.hidden = !account?.retry;
  libraryText(view.status, accountFeedback || account?.message || '');
  view.playlists.setAttribute(
    'aria-pressed',
    String(account?.collection === 'owned_playlists'),
  );
  view.liked.setAttribute(
    'aria-pressed',
    String(account?.collection === 'liked_videos'),
  );

  const page = account?.page ?? null;
  const loading =
    account?.status === 'connected' && page === null && !account.retry;
  for (const button of [view.playlists, view.liked]) {
    if (loading) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
  }

  if (view.page !== page) {
    view.page = page;
    view.rows.replaceChildren();
    for (const [index, entry] of (account?.rows ?? []).entries()) {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'playlist-row-button';
      button.dataset.row = String(index);
      const title = document.createElement('span');
      title.className = 'queue-title';
      title.dir = 'auto';
      title.textContent = entry.title;
      title.title = entry.title;
      button.append(title);
      if (account.collection !== 'owned_playlists') {
        const details = [entry.title, entry.attribution]
          .filter(Boolean)
          .join(', ');
        button.setAttribute('aria-label', `Open ${details} on YouTube`);
      }
      if (entry.attribution) {
        const attribution = document.createElement('span');
        attribution.className = 'playlist-row-detail';
        attribution.dir = 'auto';
        attribution.textContent = entry.attribution;
        attribution.title = entry.attribution;
        button.append(attribution);
      }
      if (account.collection !== 'owned_playlists') {
        const external = document.createElement('span');
        external.className = 'external-icon';
        external.setAttribute('aria-hidden', 'true');
        button.append(external);
      }
      row.append(button);
      view.rows.append(row);
    }
    view.rows.scrollTop = 0;
  }
  view.rows.hidden = !view.open || !view.rows.childElementCount;

  if (
    view.open &&
    hadFocus &&
    (!active.isConnected ||
      active.closest('[hidden]') ||
      active === view.status)
  ) {
    const fallback = [view.connect, view.cancel].find(
      (button) => !button.hidden,
    );
    (fallback ?? view.status).focus({ preventScroll: true });
  }
}

function libraryText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function syncPlaylistRows(list, entries, isTrack = false) {
  const rows = new Map(
    Array.from(list.children, (row) => [row.firstElementChild.dataset.id, row]),
  );
  const focused = list.contains(document.activeElement)
    ? document.activeElement
    : null;
  for (const [index, entry] of entries.entries()) {
    const id = String(entry.id);
    let row = rows.get(id);
    if (!row) {
      row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.id = id;
      button.className = 'playlist-row-button';
      const title = document.createElement('span');
      title.className = 'queue-title';
      title.dir = 'auto';
      const info = document.createElement('span');
      info.className = 'playlist-row-detail';
      if (!isTrack) {
        info.id = `saved-playlist-count-${id}`;
        button.setAttribute('aria-describedby', info.id);
      }
      button.append(title, info);
      row.append(button);
    }
    rows.delete(id);
    if (row !== list.children[index])
      list.insertBefore(row, list.children[index] ?? null);

    const button = row.firstElementChild;
    const [title, info] = button.children;
    const label = isTrack ? `Select ${entry.name}` : entry.name;
    if (button.getAttribute('aria-label') !== label)
      button.setAttribute('aria-label', label);
    if (button.title !== entry.name) button.title = entry.name;
    if (entry.current) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
    libraryText(title, entry.name);
    libraryText(info, entry.detail);
    info.hidden = !entry.detail;
  }
  for (const row of rows.values()) row.remove();
  if (focused?.isConnected && focused !== document.activeElement)
    focused.focus({ preventScroll: true });
}

function updateLibrary(library, successfulCommand) {
  const oldLibrary = renderedLibrary;
  renderedLibrary = library ?? null;
  if (!library) {
    libraryFeedback = null;
    if (!libraryView) return false;
    const wasFocused = libraryView.element.contains(document.activeElement);
    libraryView.element.remove();
    libraryView = null;
    return wasFocused;
  }

  libraryView ??= mountLibrary();
  const view = libraryView;
  const { lists, selected, canSave, problem } = library;
  const oldId = oldLibrary?.selected?.id ?? null;
  const selectionChanged = (selected?.id ?? null) !== oldId;
  const focused = document.activeElement;
  const hadFocus =
    !view.element.hidden &&
    (view.element.contains(focused) || focused === document.body);
  const finishedRename =
    successfulCommand?.type === 'rename_playlist' &&
    view.renameName.value.trim() === successfulCommand.name;
  if (selectionChanged || finishedRename) view.mode = null;
  if (selectionChanged && !view.list.hidden && !view.element.hidden)
    view.listScroll = view.list.scrollTop;

  updateAccount(view.account, Boolean(selected));
  const showingAccount = view.account.open;
  view.browser.hidden = showingAccount || Boolean(selected);
  view.detail.hidden = showingAccount || !selected;
  view.actions.hidden = view.mode !== null;
  view.renameForm.hidden = view.mode !== 'rename';
  view.confirm.hidden = view.mode !== 'remove';
  const queueHasTracks = Boolean(renderedState?.entries.length);
  view.saveName.disabled = view.renameName.disabled = !canSave;
  view.rename.disabled =
    view.remove.disabled =
    view.saveRename.disabled =
    view.removePermanently.disabled =
      !canSave;
  view.save.disabled = !canSave || !queueHasTracks;
  view.append.disabled = !selected?.entries.length;
  if (
    successfulCommand?.type === 'save_playlist' &&
    view.saveName.value.trim() === successfulCommand.name
  ) {
    view.saveName.value = '';
  }

  if (selected) {
    libraryText(view.title, selected.name);
    view.title.title = selected.name;
  }
  syncPlaylistRows(
    view.list,
    lists.map(({ id, name, count }) => ({
      id,
      name,
      detail: `${count} ${count === 1 ? 'video' : 'videos'}`,
    })),
  );
  syncPlaylistRows(
    view.tracks,
    (selected?.entries ?? []).map((id) => {
      const current = id === renderedState?.current;
      return {
        id,
        name: videoTitle(selected.titles, id) || id,
        current,
        detail: current ? 'Selected' : '',
      };
    }),
    true,
  );
  view.list.hidden = showingAccount || Boolean(selected) || !lists.length;
  view.tracks.hidden = showingAccount || !selected?.entries.length;
  const empty = selected ? !selected.entries.length : !lists.length && !problem;
  view.empty.hidden = showingAccount || !empty;
  view.problem.hidden = view.feedback.hidden = showingAccount;
  libraryText(
    view.empty,
    selected ? 'No videos in this playlist.' : 'No saved playlists yet.',
  );

  for (const button of view.element.querySelectorAll('button')) {
    if (
      view.account.panel.contains(button) ||
      view.account.rows.contains(button)
    )
      continue;
    if (pending && !button.disabled) {
      if (!button.hasAttribute('aria-disabled'))
        button.setAttribute('aria-disabled', 'true');
    } else {
      button.removeAttribute('aria-disabled');
    }
  }
  libraryText(view.problem, problem ?? '');
  view.feedback.classList.toggle('error', Boolean(libraryFeedback?.error));
  libraryText(
    view.feedback,
    libraryFeedback?.message ||
      (canSave && !selected && !queueHasTracks
        ? 'Add a video to the queue before saving a playlist.'
        : ''),
  );

  if (selectionChanged && selected) {
    view.tracks.scrollTop = 0;
    if (hadFocus) view.title.focus({ preventScroll: true });
  } else if (selectionChanged) {
    view.list.scrollTop = view.listScroll;
    if (hadFocus) {
      const oldIndex = oldLibrary.lists.findIndex(({ id }) => id === oldId);
      const index = lists.findIndex(({ id }) => id === oldId);
      const nearest = Math.min(oldIndex, lists.length - 1);
      const row =
        view.list.children[index >= 0 ? index : nearest]?.firstElementChild;
      (row ?? primaryInput()).focus({
        preventScroll: Boolean(row && index >= 0),
      });
    }
  } else if (finishedRename && hadFocus) {
    view.rename.focus();
  }
  return false;
}

function hasLyricsDuration(lyrics) {
  return (
    !lyricsSwitchingActive &&
    Number.isFinite(lyrics?.duration) &&
    lyrics.duration > 0
  );
}

function mountLyrics() {
  const [lyricsForm, lines] = lyricsTemplate.content.cloneNode(true).children;
  const track = lyricsForm.querySelector('#lyrics-track');
  const artist = lyricsForm.querySelector('#lyrics-artist');
  const submit = lyricsForm.querySelector('button');
  const feedback = lyricsForm.querySelector('#lyrics-feedback');
  const gap = document.createElement('span');
  gap.className = 'lyrics-gap';
  gap.setAttribute('role', 'img');
  gap.setAttribute('aria-label', 'Instrumental break');
  gap.append(
    ...Array.from({ length: 3 }, () => document.createElement('span')),
  );
  lyricsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (pending || !hasLyricsDuration(renderedLyrics)) return;
    const title = track.value.trim();
    const artistName = artist.value.trim();
    if (!title || !artistName) {
      commandProblem('Enter a track and artist.', 'lyrics');
      (title ? artist : track).focus();
      return;
    }
    track.value = title;
    artist.value = artistName;
    send({ type: 'find_lyrics', title, artist: artistName }, 'lyrics');
  });
  lyricsTemplate.before(lyricsForm, lines);
  return {
    form: lyricsForm,
    lines,
    track,
    artist,
    submit,
    feedback,
    gap,
    trackDefault: '',
    artistDefault: '',
    resultKey: '',
    timedLines: [],
    activeLine: null,
    activeWord: null,
  };
}

function lyricsLine(text) {
  const line = document.createElement('li');
  line.className = 'lyrics-line';
  line.dir = 'auto';
  line.textContent = text;
  return line;
}

function timedLyricsLine({ timeMs, text, words }) {
  const element = lyricsLine(text);
  const timedWords = [];
  if (
    text &&
    words.length &&
    words.map((word) => word.text).join('') === text
  ) {
    for (const word of words) {
      const span = document.createElement('span');
      span.textContent = word.text;
      timedWords.push({ timeMs: word.timeMs, element: span });
    }
    element.replaceChildren(...timedWords.map((word) => word.element));
  }
  return { timeMs, element, words: timedWords, gap: text === '' };
}

function updateLyrics(lyrics, selectionChanged = false) {
  renderedLyrics = lyrics ?? null;
  if (!lyrics) {
    lyricsError = '';
    if (!lyricsView) return false;
    cancelLyricsClock();
    const wasFocused = removeView(lyricsView.form, lyricsView.lines);
    lyricsView = null;
    return wasFocused;
  }

  lyricsView ??= mountLyrics();
  const view = lyricsView;
  if (selectionChanged) lyricsError = '';
  if (selectionChanged || view.track.value === view.trackDefault)
    view.track.value = lyrics.track;
  if (selectionChanged || view.artist.value === view.artistDefault)
    view.artist.value = lyrics.artist;
  view.trackDefault = lyrics.track;
  view.artistDefault = lyrics.artist;

  const finding =
    lyrics.pending ||
    (pending?.context === 'lyrics' &&
      pending.current === renderedState?.current);
  const result = finding || lyricsSwitchingActive ? null : lyrics.result;
  const resultKey = result ? JSON.stringify(result) : '';
  if (selectionChanged || view.resultKey !== resultKey) {
    view.gap.remove();
    view.activeLine = view.activeWord = null;
    view.timedLines =
      result?.kind === 'synced' ? result.lines.map(timedLyricsLine) : [];
    const rows =
      result?.kind === 'plain'
        ? result.lines.map(lyricsLine)
        : view.timedLines.map((line) => line.element);
    if (!rows.length && view.lines.contains(document.activeElement))
      view.track.focus();
    view.lines.replaceChildren(...rows);
    view.lines.scrollTop = 0;
    view.resultKey = resultKey;
  }
  view.lines.hidden = view.form.hidden || !view.lines.childElementCount;

  const hasDuration = hasLyricsDuration(lyrics);
  view.submit.setAttribute(
    'aria-disabled',
    String(Boolean(pending) || !hasDuration),
  );
  const problem = lyricsError || (!finding && lyrics.problem);
  let message = '';
  if (lyricsSwitchingActive) message = 'Opening the next video…';
  else if (problem) message = problem;
  else if (finding) message = 'Finding lyrics…';
  else if (!hasDuration) message = 'Waiting for video duration…';
  else if (result?.kind === 'instrumental') message = 'Instrumental track.';
  view.feedback.classList.toggle('error', Boolean(problem));
  if (view.feedback.textContent !== message)
    view.feedback.textContent = message;
  updateLyricsTiming();
  return false;
}

function lyricBoundaryAfter(items, timeMs) {
  let first = 0;
  let end = items.length;
  while (first < end) {
    const middle = Math.floor((first + end) / 2);
    if (items[middle].timeMs <= timeMs) first = middle + 1;
    else end = middle;
  }
  return first;
}

function scheduleLyricCue(deadline) {
  if (deadline === lyricCueDeadline) return;
  if (lyricCueTimer !== null) window.clearTimeout(lyricCueTimer);
  lyricCueTimer = null;
  lyricCueDeadline = deadline;
  if (deadline !== null) {
    lyricCueTimer = window.setTimeout(
      () => {
        lyricCueTimer = lyricCueDeadline = null;
        updateLyricsTiming();
      },
      Math.max(0, Math.ceil(deadline - performance.now())),
    );
  }
}

function cancelLyricsClock() {
  lyricsClock = null;
  scheduleLyricCue(null);
}

function receiveLyricsClock(transport) {
  cancelLyricsClock();
  if (
    !transport?.clockRunning ||
    transport.blocked ||
    !controlsVisible() ||
    playerProblemText.textContent ||
    editingPosition ||
    interruptsLyricsClock(pending?.command)
  )
    return;

  const { positionMs, duration, playbackRate } = transport;
  const endMs = duration * 1000;
  if (
    !Number.isFinite(positionMs) ||
    positionMs < 0 ||
    !Number.isFinite(endMs) ||
    positionMs >= endMs
  )
    return;
  const rate =
    Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  const receivedAt = performance.now();
  const limitMs = Math.min(endMs, positionMs + LYRIC_SAMPLE_INTERVAL_MS * rate);
  lyricsClock = {
    positionMs,
    receivedAt,
    rate,
    limitMs,
    expiresAt:
      receivedAt +
      Math.min(LYRIC_SAMPLE_INTERVAL_MS, (limitMs - positionMs) / rate),
  };
}

function keepLyricInView(list, line, moving) {
  const viewport = list.getBoundingClientRect();
  const row = line.getBoundingClientRect();
  const offset =
    row.top < viewport.top
      ? row.top - viewport.top
      : Math.max(
          0,
          Math.min(row.top - viewport.top, row.bottom - viewport.bottom),
        );
  if (offset) {
    const smooth =
      moving && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    list.scrollBy({ top: offset, behavior: smooth ? 'smooth' : 'auto' });
  }
}

function updateLyricsTiming() {
  const view = lyricsView;
  if (
    !view ||
    view.lines.hidden ||
    !view.timedLines.length ||
    !controlsVisible()
  ) {
    scheduleLyricCue(null);
    view?.gap.removeAttribute('data-running');
    return;
  }

  const clock = lyricsClock;
  const now = performance.now();
  const moving = Boolean(clock && now < clock.expiresAt);
  const timeMs = clock
    ? moving
      ? Math.min(
          clock.limitMs,
          clock.positionMs + (now - clock.receivedAt) * clock.rate,
        )
      : clock.limitMs
    : renderedTransport?.positionMs;
  const nextLineIndex = Number.isFinite(timeMs)
    ? lyricBoundaryAfter(view.timedLines, timeMs)
    : 0;
  const line = view.timedLines[nextLineIndex - 1] ?? null;
  const nextWordIndex = line ? lyricBoundaryAfter(line.words, timeMs) : 0;
  const word = line?.words[nextWordIndex - 1] ?? null;
  if (line !== view.activeLine) {
    view.activeLine?.element.removeAttribute('aria-current');
    view.activeLine = line;
    view.gap.remove();
    if (line) {
      line.element.setAttribute('aria-current', 'true');
      if (line.gap) line.element.append(view.gap);
      keepLyricInView(view.lines, line.element, moving);
    }
  }
  if (line?.gap) view.gap.toggleAttribute('data-running', moving);
  if (word !== view.activeWord) {
    view.activeWord?.element.removeAttribute('data-active-word');
    word?.element.setAttribute('data-active-word', '');
    view.activeWord = word;
  }

  let deadline = null;
  if (moving) {
    const nextCue = Math.min(
      view.timedLines[nextLineIndex]?.timeMs ?? Infinity,
      line?.words[nextWordIndex]?.timeMs ?? Infinity,
    );
    if (nextCue <= clock.limitMs) {
      deadline = Math.min(
        clock.expiresAt,
        clock.receivedAt + (nextCue - clock.positionMs) / clock.rate,
      );
    } else if (line?.gap) {
      deadline = clock.expiresAt;
    }
  }
  scheduleLyricCue(deadline);
}

window.renderPearState = (
  {
    entries,
    current,
    titles,
    metadata,
    metadataProblem,
    catalog,
    browserSearch,
    lyrics,
    lyricsSwitching,
    savedPlaylists,
    account,
    preferencesProblem,
    legal,
    publicPlaylist,
  },
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
  const context = acknowledged?.context ?? 'queue';
  if (context === 'legal') legalCommandProblem = error ?? '';
  const restoreFocus = updateLegal(legal);
  if (command?.type === 'ready') {
    source.disabled = false;
    add.disabled = false;
  }
  if (legal && !legal.accepted) {
    updateSelectionArtwork(null, null);
    renderedTransport = null;
    return;
  }

  const index = entries.indexOf(current);
  const hasSelection = index !== -1;
  const playlistChanged = playingPublicPlaylist !== (publicPlaylist === true);
  playingPublicPlaylist = publicPlaylist === true;
  const selectedMetadata =
    hasSelection && !playingPublicPlaylist ? metadata : null;
  const officialTitle = selectedMetadata?.title.trim();
  const entryTitles = entries.map((id) => videoTitle(titles, id));
  if (officialTitle) entryTitles[index] = officialTitle;
  const currentTitle = entryTitles[index];
  const selectionChanged =
    renderedState !== null && current !== renderedState.current;
  const active = document.activeElement;
  if (command?.type === 'accept_legal' || queueInputs.contains(active))
    queueInputsOpen = true;
  updateQueueInputs(!entries.length);
  const selectionLabel = playingPublicPlaylist
    ? 'YouTube playlist'
    : hasSelection
      ? currentTitle || current
      : '';
  if (selection.textContent !== selectionLabel) {
    selection.textContent = selectionLabel;
    selection.title = selectionLabel;
  }
  selection.classList.toggle(
    'video-id',
    hasSelection && !currentTitle && !playingPublicPlaylist,
  );
  updateSelectionAttribution(selectedMetadata?.channel.trim());
  if (!panel.hidden)
    updateSelectionArtwork(
      playingPublicPlaylist ? null : current,
      selectedMetadata?.thumbnailUrl,
    );
  selectionPanel.hidden = !hasSelection && !playingPublicPlaylist;
  panel.toggleAttribute('data-empty', selectionPanel.hidden);
  position.textContent =
    hasSelection && !playingPublicPlaylist
      ? `${index + 1} of ${entries.length}`
      : '';
  previous.disabled = playingPublicPlaylist || index <= 0;
  next.disabled =
    playingPublicPlaylist || !hasSelection || index >= entries.length - 1;
  returnToQueue.hidden = !playingPublicPlaylist;
  previous.hidden = next.hidden = playingPublicPlaylist;
  openBrowser.disabled = !hasSelection && !playingPublicPlaylist;

  if (active === previous && previous.disabled)
    (next.disabled ? primaryInput() : next).focus();
  if (active === next && next.disabled)
    (previous.disabled ? primaryInput() : previous).focus();
  if (active === openBrowser && openBrowser.disabled) primaryInput().focus();

  const oldEntries = renderedState?.entries ?? [];
  const changed =
    !renderedState ||
    entries.length !== oldEntries.length ||
    entries.some(
      (id, i) =>
        id !== oldEntries[i] || entryTitles[i] !== renderedState.entryTitles[i],
    ) ||
    current !== renderedState.current;
  const nextId = hasSelection ? entries[index + 1] : null;
  if (changed) updateQueue(entries, current, entryTitles, nextId);
  renderedState = { entries, current, entryTitles, nextId };
  shuffle.hidden = !hasSelection || entries.length - index - 1 < 2;
  if (active === shuffle && shuffle.hidden)
    (filter.hidden ? source : filter).focus({ preventScroll: true });

  let confirmation = '';
  if (!error && command?.type === 'add') {
    if (context === 'queue' && source.value === command.source)
      source.value = '';
    const added = entries.length - acknowledged.entryCount;
    if (added > 1) confirmation = `Added ${added} videos to the queue.`;
    else if (added === 1) confirmation = 'Added to the queue.';
    else if (command.source.trim().includes('\n'))
      confirmation = 'These videos are already in the queue.';
    else confirmation = 'Video is already in the queue.';
  }
  if (error && command?.type === 'add' && active === add) source.focus();
  if (!error && command?.type === 'play_next') {
    if (acknowledged.entryCount === 0 && current === command.id)
      confirmation = 'Added to the queue.';
    else if (nextId === command.id) confirmation = 'Queued to play next.';
  }
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
  if (
    !error &&
    command?.type === 'shuffle_upcoming' &&
    entries.some((id, i) => id !== oldEntries[i])
  ) {
    confirmation = 'Shuffled upcoming videos.';
  }
  if (!error && context === 'library') {
    if (command.type === 'save_playlist') confirmation = 'Playlist saved.';
    if (command.type === 'rename_playlist') confirmation = 'Playlist renamed.';
    if (command.type === 'remove_playlist') confirmation = 'Playlist removed.';
    if (command.type === 'append_playlist') {
      const added = entries.length - acknowledged.entryCount;
      if (added > 1) confirmation = `Added ${added} videos to the queue.`;
      else if (added === 1) confirmation = 'Added 1 video to the queue.';
      else confirmation = 'All playlist videos are already in the queue.';
    }
  }

  if (context === 'public-playlist') {
    playlistFeedback.textContent = error ?? '';
    if (!error) {
      playlistDetails.open = false;
      returnToQueue.focus({ preventScroll: true });
    }
  } else if (context === 'search') {
    catalogSearchError = error ?? '';
  } else if (context === 'playlist-page') {
    catalogPageError =
      command.revision === catalog?.playlist?.revision ? (error ?? '') : '';
  } else if (context === 'browser-search') {
    browserSearchError = error ?? '';
  } else if (context === 'result-add') {
    catalogAddFeedback = {
      message: error || confirmation,
      error: Boolean(error),
    };
  } else if (context === 'lyrics') {
    lyricsError = acknowledged.current === current ? (error ?? '') : '';
  } else if (context === 'account') {
    accountFeedback = error ?? '';
  } else if (context === 'library') {
    libraryFeedback = { message: error || confirmation, error: Boolean(error) };
  } else if (context === 'audio') {
    audioProblem.textContent = error ?? '';
  } else if (context !== 'legal' && (acknowledged || error !== null)) {
    errorText.textContent = error ?? '';
  }
  if (
    (acknowledged &&
      context !== 'legal' &&
      context !== 'audio' &&
      context !== 'browser-search' &&
      context !== 'playlist-page') ||
    command?.type === 'accept_legal' ||
    notice
  ) {
    statusText.textContent = [context === 'queue' ? confirmation : '', notice]
      .filter(Boolean)
      .join(' ');
  }
  if (selectionChanged || playlistChanged) renderedTransport = null;
  lyricsSwitchingActive = Boolean(lyricsSwitching);
  updateQueueAvailability();
  if (
    selectionChanged ||
    playlistChanged ||
    playerProblem ||
    lyricsSwitchingActive
  )
    cancelLyricsClock();
  const catalogWasFocused = updateCatalog(catalog, browserSearch === true);
  const lyricsWasFocused = updateLyrics(
    playingPublicPlaylist ? null : lyrics,
    selectionChanged || playlistChanged,
  );
  renderedAccount = account ?? null;
  const libraryWasFocused = updateLibrary(
    savedPlaylists,
    context === 'library' && !error ? command : null,
  );
  updateViews();
  if (catalogWasFocused || lyricsWasFocused || libraryWasFocused)
    primaryInput().focus();
  const problem = playerProblem ?? '';
  const problemChanged = playerProblemText.textContent !== problem;
  if (problemChanged) playerProblemText.textContent = problem;
  const providerProblem = playingPublicPlaylist ? '' : (metadataProblem ?? '');
  if (metadataProblemText.textContent !== providerProblem) {
    metadataProblemText.textContent = providerProblem;
  }
  if (preferencesProblemText.textContent !== (preferencesProblem ?? '')) {
    preferencesProblemText.textContent = preferencesProblem ?? '';
  }
  if (selectionChanged || playlistChanged || problemChanged) updateTransport();
  else if (acknowledged) updateAudioOutput();
  if (restoreFocus) {
    const previousFocus = focusBeforeLegal;
    focusBeforeLegal = null;
    previousFocus?.focus({ preventScroll: true });
    if (document.activeElement !== previousFocus) primaryInput().focus();
  }
  if (!panel.hidden && focusAddOnReady) focusQueueAdd();
  if (active === returnToQueue && returnToQueue.hidden)
    primaryInput().focus({ preventScroll: true });
};

playlistForm.addEventListener('submit', (event) => {
  event.preventDefault();
  send(
    { type: 'play_public_playlist', source: playlistLink.value.trim() },
    'public-playlist',
  );
});

returnToQueue.addEventListener('click', () => {
  send({ type: 'return_to_queue' });
});

acceptLegal.addEventListener('click', () => {
  if (renderedLegal && !renderedLegal.accepted) {
    send({ type: 'accept_legal', revision: renderedLegal.revision }, 'legal');
  }
});
declineLegal.addEventListener('click', () => {
  if (renderedLegal && !renderedLegal.accepted)
    send({ type: 'decline_legal' }, 'legal');
});
openLocalAudio.addEventListener('click', () => {
  if (renderedLegal && !renderedLegal.accepted) {
    send({ type: 'open_local_audio' }, 'legal');
  }
});
closeLegal.addEventListener('click', () => {
  if (renderedLegal?.accepted) send({ type: 'close_legal' }, 'legal');
});
document.getElementById('legal-youtube-terms').addEventListener('click', () => {
  send({ type: 'open_legal_link', link: 'youtube_terms' }, 'legal');
});
document
  .getElementById('legal-google-privacy')
  .addEventListener('click', () => {
    send({ type: 'open_legal_link', link: 'google_privacy' }, 'legal');
  });

form.addEventListener('submit', (event) => {
  event.preventDefault();
  send({ type: 'add', source: source.value });
});
addLinks.addEventListener('click', () => {
  queueInputsOpen = !queueInputsOpen;
  updateQueueInputs();
  if (queueInputsOpen) source.focus();
});
queueInputs.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.isComposing || addLinks.hidden) return;
  event.preventDefault();
  queueInputsOpen = false;
  updateQueueInputs();
  addLinks.focus();
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
shuffle.addEventListener('click', () => {
  if (!shuffle.hidden && shuffle.getAttribute('aria-disabled') !== 'true')
    send({ type: 'shuffle_upcoming' });
});
previous.addEventListener('click', () => send({ type: 'previous' }));
playToggle.addEventListener('click', () => {
  if (!playToggle.disabled) {
    send({ type: 'set_playback', playing: !renderedTransport.playing });
  }
});
document.addEventListener('keydown', (event) => {
  if (
    event.code !== 'Space' ||
    event.defaultPrevented ||
    event.isComposing ||
    event.repeat ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    pending ||
    panel.hidden ||
    !legalPanel.hidden ||
    playToggle.disabled ||
    playToggle.hidden
  )
    return;
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest(
      'input, textarea, button, select, a, summary, #catalog-results, [contenteditable], [tabindex]:not([tabindex="-1"])',
    )
  )
    return;
  event.preventDefault();
  playToggle.click();
});
next.addEventListener('click', () => send({ type: 'next' }));
openBrowser.addEventListener('click', () => send({ type: 'open_browser' }));

audioToggle.addEventListener('click', () => {
  audioExpanded = !audioExpanded;
  if (!audioExpanded) editingVolume = false;
  updateAudioOutput();
});
audioControls.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.isComposing) return;
  event.preventDefault();
  audioExpanded = false;
  editingVolume = false;
  updateAudioOutput();
  audioToggle.focus();
});
mute.addEventListener('click', () => {
  if (!mute.disabled)
    send({ type: 'set_muted', muted: !renderedTransport.muted }, 'audio');
});
volume.addEventListener('input', () => {
  if (volume.disabled || pending) {
    updateAudioOutput();
    return;
  }
  editingVolume = true;
  updateVolumeValue();
});
volume.addEventListener('change', () => {
  editingVolume = false;
  if (volume.disabled || pending) {
    updateAudioOutput();
    return;
  }
  if (volume.valueAsNumber !== renderedTransport.volume) {
    send({ type: 'set_volume', volume: volume.valueAsNumber }, 'audio');
  }
});
function cancelVolumePreview() {
  if (!editingVolume) return;
  editingVolume = false;
  updateAudioOutput();
}
volume.addEventListener('pointercancel', cancelVolumePreview);
volume.addEventListener('blur', cancelVolumePreview);
window.addEventListener('blur', cancelVolumePreview);

seek.addEventListener('pointerdown', () => {
  editingPosition = true;
  cancelLyricsClock();
  updateLyricsTiming();
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
  cancelLyricsClock();
  updateLyricsTiming();
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
