export const normalizeCollectionText = (value: string) =>
  value.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
const termsFor = (query: string) =>
  normalizeCollectionText(query.slice(0, 256))
    .trim()
    .split(/\s+/)
    .filter(Boolean);
export const matchesCollectionText = (text: string, query: string) => {
  const normalized = normalizeCollectionText(text);
  return termsFor(query).every((term) => normalized.includes(term));
};
export const isCollectionLocation = (location: string) => {
  try {
    const url = new URL(location);
    return (
      url.hostname === 'music.youtube.com' &&
      (url.pathname === '/playlist' ||
        (url.pathname === '/watch' && !!url.searchParams.get('list')) ||
        url.pathname.startsWith('/library') ||
        /^\/browse\/(?:MPRE|VL|FEmusic_library)/.test(url.pathname))
    );
  } catch {
    return false;
  }
};

const isWatchLocation = (location: string) => {
  try {
    const url = new URL(location);
    return url.hostname === 'music.youtube.com' && url.pathname === '/watch';
  } catch {
    return false;
  }
};

const collectionKey = (location: string) => {
  try {
    const url = new URL(location);
    return url.pathname === '/playlist' || url.pathname === '/watch'
      ? `${url.origin}/playlist?list=${url.searchParams.get('list') ?? ''}`
      : `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
};

type Labels = {
  label: string;
  placeholder: string;
  clear: string;
  results: (matches: number, total: number) => string;
};
const ROW = 'ytmusic-responsive-list-item-renderer';
const SHELVES =
  '#browse-page ytmusic-playlist-shelf-renderer, #browse-page ytmusic-shelf-renderer, ytmusic-browse-response ytmusic-playlist-shelf-renderer, ytmusic-browse-response ytmusic-shelf-renderer';

/** Filter only already-loaded collection rows. No pagination, account access or polling. */
export const startPlaylistSearch = (
  doc: Document,
  labels: Labels,
): (() => void) => {
  const view = doc.defaultView;
  if (!view) return () => {};
  let stopped = false;
  let eligible = isCollectionLocation(view.location.href);
  let ownerKey = collectionKey(view.location.href);
  let frame: number | undefined;
  let shelf: HTMLElement | undefined;
  let box: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  let status: HTMLParagraphElement | undefined;
  let clear: HTMLButtonElement | undefined;
  let query = '';
  let widgetEpoch = 0;
  const cache = new WeakMap<HTMLElement, string>();
  const hidden = new Map<HTMLElement, { value: string; priority: string }>();
  const restore = (row: HTMLElement) => {
    const original = hidden.get(row);
    if (!original) return;
    // A later external display change belongs to its author, not this filter.
    if (
      row.style.getPropertyValue('display') === 'none' &&
      row.style.getPropertyPriority('display') === 'important'
    ) {
      if (original.value)
        row.style.setProperty('display', original.value, original.priority);
      else row.style.removeProperty('display');
    }
    hidden.delete(row);
  };
  const detach = (preserveQuery = false) => {
    widgetEpoch++;
    rowsObserver.disconnect();
    for (const row of hidden.keys()) restore(row);
    box?.remove();
    shelf = undefined;
    box = undefined;
    input = undefined;
    status = undefined;
    clear = undefined;
    if (!preserveQuery) query = '';
  };
  const apply = () => {
    if (!shelf?.isConnected || stopped) return;
    const rows = [...shelf.querySelectorAll<HTMLElement>(ROW)];
    for (const row of hidden.keys()) if (!shelf.contains(row)) restore(row);
    const terms = termsFor(query);
    let matches = 0;
    for (const row of rows) {
      let text = cache.get(row);
      if (text === undefined) {
        text = normalizeCollectionText(row.textContent ?? '');
        cache.set(row, text);
      }
      const match = terms.every((term) => text.includes(term));
      if (match) {
        matches++;
        restore(row);
      } else {
        if (
          !hidden.has(row) ||
          row.style.getPropertyValue('display') !== 'none' ||
          row.style.getPropertyPriority('display') !== 'important'
        )
          hidden.set(row, {
            value: row.style.getPropertyValue('display'),
            priority: row.style.getPropertyPriority('display'),
          });
        row.style.setProperty('display', 'none', 'important');
      }
    }
    const message = labels.results(matches, rows.length);
    if (status && status.textContent !== message) status.textContent = message;
    if (clear) clear.disabled = !query;
  };
  const visible = (candidate: HTMLElement) => {
    for (
      let node: HTMLElement | null = candidate;
      node;
      node = node.parentElement
    ) {
      if (
        node.hidden ||
        node.getAttribute('aria-hidden') === 'true' ||
        view.getComputedStyle(node).display === 'none'
      )
        return false;
    }
    return true;
  };
  const effectiveKey = () =>
    isWatchLocation(view.location.href) && shelf?.isConnected && visible(shelf)
      ? ownerKey
      : collectionKey(view.location.href);
  const mount = (knownShelf?: HTMLElement) => {
    if (stopped || !eligible) return;
    const candidate = (
      knownShelf
        ? [knownShelf]
        : [...doc.querySelectorAll<HTMLElement>(SHELVES)]
    ).find(
      (node) =>
        visible(node) &&
        node.querySelector(ROW) &&
        (!isWatchLocation(view.location.href) ||
          node === knownShelf ||
          node.localName === 'ytmusic-playlist-shelf-renderer'),
    );
    if (!candidate) return;
    shelf = candidate;
    box = doc.createElement('div');
    box.className = 'pear-playlist-search';
    box.setAttribute('role', 'search');
    const label = doc.createElement('label');
    const title = doc.createElement('span');
    title.textContent = labels.label;
    input = doc.createElement('input');
    input.type = 'search';
    input.maxLength = 256;
    input.autocomplete = 'off';
    input.value = query;
    input.placeholder = labels.placeholder;
    label.append(title, input);
    clear = doc.createElement('button');
    clear.type = 'button';
    clear.textContent = labels.clear;
    clear.disabled = !query;
    status = doc.createElement('p');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    box.append(label, clear, status);
    shelf.prepend(box);
    const epoch = ++widgetEpoch;
    const ownedInput = input;
    const ownedBox = box;
    const active = () =>
      !stopped &&
      widgetEpoch === epoch &&
      input === ownedInput &&
      box === ownedBox &&
      ownedBox.isConnected;
    const reset = () => {
      if (!input || !active()) return;
      input.value = '';
      query = '';
      schedule();
      input.focus();
    };
    input.addEventListener('input', () => {
      if (!active()) return;
      query = input?.value.slice(0, 256) ?? '';
      schedule();
    });
    input.addEventListener('keydown', (event) => {
      if (active() && event.key === 'Escape' && query) {
        event.preventDefault();
        event.stopPropagation();
        reset();
      }
    });
    clear.addEventListener('click', reset);
    rowsObserver.observe(shelf, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };
  const schedule = () => {
    if (stopped || frame !== undefined) return;
    frame = view.requestAnimationFrame(() => {
      frame = undefined;
      if (stopped) return;
      if (effectiveKey() !== ownerKey) {
        route();
        return;
      }
      if (shelf && (!shelf.isConnected || !visible(shelf))) detach(true);
      else if (shelf && !box?.isConnected) {
        const known = shelf;
        detach(true);
        mount(known);
      }
      if (!shelf) mount();
      apply();
    });
  };
  const rowsObserver = new view.MutationObserver((records) => {
    let changed = false;
    for (const record of records) {
      if (box?.contains(record.target)) continue;
      const element =
        record.target.nodeType === 1
          ? (record.target as Element)
          : record.target.parentElement;
      const row = element?.closest<HTMLElement>(ROW);
      if (row) cache.delete(row);
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node.nodeType !== 1) continue;
        const element = node as HTMLElement;
        if (element.matches(ROW)) cache.delete(element);
        for (const nested of element.querySelectorAll<HTMLElement>(ROW))
          cache.delete(nested);
      }
      changed = true;
    }
    if (changed) schedule();
  });
  const pageObserver = new view.MutationObserver((records) => {
    // Playback/menus elsewhere do not rescan an already-owned connected shelf.
    if (
      !shelf?.isConnected ||
      records.some(
        (record) =>
          record.type === 'attributes' &&
          (record.target === shelf || record.target.contains(shelf!)),
      )
    )
      schedule();
  });
  const route = () => {
    if (stopped) return;
    const knownVisible = !!shelf?.isConnected && visible(shelf);
    const nextKey = effectiveKey();
    const sameCollection = nextKey === ownerKey;
    ownerKey = nextKey;
    eligible =
      isCollectionLocation(view.location.href) ||
      (isWatchLocation(view.location.href) && knownVisible);
    if (!eligible || !sameCollection || !knownVisible)
      detach(eligible && sameCollection);
    pageObserver.disconnect();
    if (eligible) {
      pageObserver.observe(doc.body ?? doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden', 'aria-hidden'],
      });
      schedule();
    }
  };
  const navigation = (view as Window & { navigation?: EventTarget }).navigation;
  doc.addEventListener('yt-navigate-finish', route);
  view.addEventListener('yt-navigate-finish', route);
  navigation?.addEventListener('currententrychange', route);
  view.addEventListener('popstate', route);
  route();
  return () => {
    if (stopped) return;
    stopped = true;
    pageObserver.disconnect();
    rowsObserver.disconnect();
    doc.removeEventListener('yt-navigate-finish', route);
    view.removeEventListener('yt-navigate-finish', route);
    navigation?.removeEventListener('currententrychange', route);
    view.removeEventListener('popstate', route);
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = undefined;
    detach();
  };
};

const isVisibleSearchContext = (node: HTMLElement, view: Window) => {
  if (!node.isConnected) return false;
  for (
    let parent: HTMLElement | null = node;
    parent;
    parent = parent.parentElement
  ) {
    if (
      parent.hidden ||
      parent.getAttribute('aria-hidden') === 'true' ||
      view.getComputedStyle(parent).display === 'none'
    )
      return false;
  }
  return true;
};

type NameScope = 'sidebar' | 'dialog';
const nameScopes = {
  sidebar: {
    root: 'ytmusic-guide-section-renderer:nth-of-type(2)',
    list: '#items',
    row: 'ytmusic-guide-entry-renderer',
    title: '.title',
  },
  dialog: {
    root: 'ytmusic-add-to-playlist-renderer',
    list: '#playlists',
    row: 'ytmusic-playlist-add-to-option-renderer',
    title: '#title',
  },
};

/** Independent, loaded-name filter. Closing/replacing a native surface releases all display ownership. */
export const startPlaylistNameScope = (
  doc: Document,
  labels: Labels,
  scope: NameScope,
): (() => void) => {
  const view = doc.defaultView;
  if (!view) return () => {};
  const selectors = nameScopes[scope];
  let stopped = false;
  let frame: number | undefined;
  let root: HTMLElement | undefined;
  let box: HTMLElement | undefined;
  let query = '';
  let releaseWidget: (() => void) | undefined;
  const hidden = new Map<HTMLElement, { value: string; priority: string }>();
  const restore = (row: HTMLElement) => {
    const prior = hidden.get(row);
    if (
      prior &&
      row.style.display === 'none' &&
      row.style.getPropertyPriority('display') === 'important'
    ) {
      if (prior.value)
        row.style.setProperty('display', prior.value, prior.priority);
      else row.style.removeProperty('display');
    }
    hidden.delete(row);
  };
  const detach = () => {
    releaseWidget?.();
    releaseWidget = undefined;
    for (const row of hidden.keys()) restore(row);
    box?.remove();
    box = undefined;
    root = undefined;
    query = '';
  };
  const update = () => {
    if (stopped) return;
    const next = [...doc.querySelectorAll<HTMLElement>(selectors.root)].find(
      (node) =>
        isVisibleSearchContext(node, view) &&
        node.querySelector(selectors.list),
    );
    if (root !== next || (box && !box.isConnected)) detach();
    if (!next) return;
    if (!root) {
      root = next;
      box = doc.createElement('div');
      box.className = 'pear-playlist-search pear-playlist-name-search';
      box.dataset.playlistSearch = scope;
      box.setAttribute('role', 'search');
      const label = doc.createElement('label');
      const title = doc.createElement('span');
      title.textContent = labels.label;
      const input = doc.createElement('input');
      input.type = 'search';
      input.maxLength = 256;
      input.placeholder = labels.placeholder;
      input.autocomplete = 'off';
      const clear = doc.createElement('button');
      clear.type = 'button';
      clear.textContent = labels.clear;
      const status = doc.createElement('p');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      label.append(title, input);
      box.append(label, clear, status);
      root.querySelector(selectors.list)!.before(box);
      const change = () => {
        query = input.value.slice(0, 256);
        schedule();
      };
      const reset = () => {
        input.value = '';
        change();
        input.focus();
      };
      const escape = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && !e.isComposing && query) {
          e.preventDefault();
          e.stopPropagation();
          reset();
        }
      };
      input.addEventListener('input', change);
      input.addEventListener('keydown', escape);
      clear.addEventListener('click', reset);
      releaseWidget = () => {
        input.removeEventListener('input', change);
        input.removeEventListener('keydown', escape);
        clear.removeEventListener('click', reset);
      };
    }
    const rows = [
      ...root.querySelectorAll<HTMLElement>(
        `${selectors.list} ${selectors.row}`,
      ),
    ];
    for (const row of hidden.keys()) if (!rows.includes(row)) restore(row);
    let matches = 0;
    for (const row of rows) {
      const title = row.querySelector(selectors.title);
      const match = matchesCollectionText(
        title?.getAttribute('title') || title?.textContent || '',
        query,
      );
      if (match) {
        matches++;
        restore(row);
      } else {
        if (
          !hidden.has(row) ||
          row.style.display !== 'none' ||
          row.style.getPropertyPriority('display') !== 'important'
        )
          hidden.set(row, {
            value: row.style.getPropertyValue('display'),
            priority: row.style.getPropertyPriority('display'),
          });
        if (
          row.style.display !== 'none' ||
          row.style.getPropertyPriority('display') !== 'important'
        )
          row.style.setProperty('display', 'none', 'important');
      }
    }
    const status = box!.querySelector('p')!;
    const text = labels.results(matches, rows.length);
    if (status.textContent !== text) status.textContent = text;
    box!.querySelector('button')!.disabled = !query;
  };
  const schedule = () => {
    if (stopped || frame !== undefined) return;
    frame = view.requestAnimationFrame(() => {
      frame = undefined;
      update();
    });
  };
  const observer = new view.MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          !box?.contains(record.target) &&
          !(
            record.type === 'attributes' &&
            (record.target as Element).matches(selectors.row) &&
            hidden.has(record.target as HTMLElement) &&
            (record.target as HTMLElement).style.display === 'none'
          ),
      )
    )
      schedule();
  });
  observer.observe(doc.body ?? doc.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['hidden', 'aria-hidden', 'style', 'title'],
  });
  schedule();
  return () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = undefined;
    detach();
  };
};

/** Adapted from @ekloff's #4808; use endpoint identity, never translated menu text. */
export const startPlaylistNameSearch = (
  doc: Document,
  labels: Labels,
): (() => void) => {
  const view = doc.defaultView;
  if (!view) return () => {};
  const releases = (['sidebar', 'dialog'] as const).map((scope) =>
    startPlaylistNameScope(doc, labels, scope),
  );
  let stopped = false;
  let cancelPending: (() => void) | undefined;
  const visible = (selector: string) =>
    [...doc.querySelectorAll<HTMLElement>(selector)].find((node) =>
      isVisibleSearchContext(node, view),
    );
  const focus = (input: HTMLElement) => {
    input.focus();
    (input as HTMLInputElement).select();
  };
  const dialogInput = () => visible('[data-playlist-search="dialog"] input');
  const readTrack = (media: Element | null): unknown =>
    (
      media as (Element & { getVideoData?: () => { video_id?: string } }) | null
    )?.getVideoData?.()?.video_id;
  const keydown = (e: KeyboardEvent) => {
    if (
      stopped ||
      e.defaultPrevented ||
      e.isComposing ||
      e.repeat ||
      e.altKey ||
      e.shiftKey ||
      !(e.metaKey || e.ctrlKey)
    )
      return;
    const target = e.target as Element | null;
    if (
      target?.closest?.(
        'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]',
      ) &&
      !target.closest('.pear-playlist-search')
    )
      return;
    const key = e.key.toLowerCase();
    if (key === 'f') {
      const sidebarContext =
        target?.closest?.(nameScopes.sidebar.root) ||
        doc.activeElement?.closest(nameScopes.sidebar.root);
      const input =
        dialogInput() ??
        (sidebarContext
          ? visible('[data-playlist-search="sidebar"] input')
          : visible('.pear-playlist-search:not([data-playlist-search]) input'));
      if (input) {
        e.preventDefault();
        focus(input);
      }
    } else if (key === 'l') {
      const input = dialogInput();
      if (input) {
        e.preventDefault();
        focus(input);
        return;
      }
      const button = visible(
        'ytmusic-player-bar ytmusic-menu-renderer #button, ytmusic-player-bar ytmusic-menu-renderer button, ytmusic-player-bar ytmusic-menu-renderer tp-yt-paper-icon-button',
      );
      if (!button) return;
      const menu = button.closest('ytmusic-menu-renderer');
      const media = doc.querySelector('#movie_player');
      let track: unknown;
      try {
        track = readTrack(media);
      } catch {
        return;
      }
      if (!menu || typeof track !== 'string' || !track) return;
      e.preventDefault();
      cancelPending?.();
      const href = view.location.href;
      const container =
        doc.querySelector('ytmusic-popup-container') ?? doc.body;
      const previousItems = new Set<Element>();
      for (const item of container.querySelectorAll<HTMLElement>(
        'ytmusic-menu-service-item-renderer, ytmusic-menu-navigation-item-renderer',
      )) {
        if (isVisibleSearchContext(item, view)) previousItems.add(item);
      }
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        active = false;
        observer.disconnect();
        if (timer !== undefined) clearTimeout(timer);
        doc.removeEventListener('videodatachange', cleanup);
        doc.removeEventListener('yt-navigate-finish', cleanup);
        view.removeEventListener('yt-navigate-finish', cleanup);
        if (cancelPending === cleanup) cancelPending = undefined;
      };
      const stillCurrent = () => {
        const trackNow = readTrack(media);
        return (
          active &&
          !stopped &&
          menu.isConnected &&
          button.isConnected &&
          doc.querySelector('#movie_player') === media &&
          trackNow === track &&
          view.location.href === href
        );
      };
      const isOwnedMenu = (item: Element) => {
        const origin = item.closest('tp-yt-paper-listbox')?.parentElement as
          | (HTMLElement & {
              ytEventForwardingBehavior?: {
                forwarder_?: { eventSink?: HTMLElement };
              };
            })
          | null
          | undefined;
        return (
          origin?.ytEventForwardingBehavior?.forwarder_?.eventSink === menu
        );
      };
      const click = () => {
        try {
          if (!stillCurrent() || !isVisibleSearchContext(button, view)) {
            cleanup();
            return;
          }
          for (const item of container.querySelectorAll<HTMLElement>(
            'ytmusic-menu-popup-renderer ytmusic-menu-service-item-renderer, ytmusic-menu-popup-renderer ytmusic-menu-navigation-item-renderer',
          )) {
            if (
              previousItems.has(item) ||
              !isVisibleSearchContext(item, view) ||
              !isOwnedMenu(item)
            )
              continue;
            type SaveEndpoint = {
              addToPlaylistEndpoint?: { videoId?: unknown };
            };
            const data = (
              item as HTMLElement & {
                data?: SaveEndpoint & {
                  serviceEndpoint?: SaveEndpoint;
                  defaultServiceEndpoint?: SaveEndpoint;
                  navigationEndpoint?: SaveEndpoint;
                };
              }
            ).data;
            const endpoint =
              data?.addToPlaylistEndpoint ??
              data?.serviceEndpoint?.addToPlaylistEndpoint ??
              data?.defaultServiceEndpoint?.addToPlaylistEndpoint ??
              data?.navigationEndpoint?.addToPlaylistEndpoint;
            if (endpoint?.videoId !== track) continue;
            if (
              !isOwnedMenu(item) ||
              !container.contains(item) ||
              !stillCurrent()
            )
              return;
            cleanup();
            item.click();
            return;
          }
        } catch {
          // Site accessors may change while YouTube Music replaces the menu.
          cleanup();
        }
      };
      const observer = new view.MutationObserver(click);
      cancelPending = cleanup;
      observer.observe(container, {
        childList: true,
        subtree: true,
        attributeFilter: ['hidden', 'aria-hidden', 'style', 'opened'],
      });
      doc.addEventListener('videodatachange', cleanup);
      doc.addEventListener('yt-navigate-finish', cleanup);
      view.addEventListener('yt-navigate-finish', cleanup);
      timer = setTimeout(cleanup, 1000);
      button.click();
      click();
    }
  };
  doc.addEventListener('keydown', keydown);
  return () => {
    if (stopped) return;
    stopped = true;
    cancelPending?.();
    doc.removeEventListener('keydown', keydown);
    for (const release of releases) release();
  };
};
