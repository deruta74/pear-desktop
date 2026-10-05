interface DocumentBinding {
  contents: Electron.WebContents;
}

const documents = new WeakMap<Electron.Session, Map<string, DocumentBinding>>();
const pending = new WeakMap<Electron.Session, Set<Electron.WebContents>>();

/** Bind only windows explicitly supplied by the application's plugin backend. */
export const setBlockerDocument = (
  session: Electron.Session,
  owner: string,
  contents: Electron.WebContents | null,
): (() => void) => {
  const entries = documents.get(session) ?? new Map<string, DocumentBinding>();
  if (!contents) {
    entries.delete(owner);
    return () => {};
  }
  // A new binding is a distinct lease even when WebContents is reused.
  const binding = { contents };
  entries.set(owner, binding);
  documents.set(session, entries);
  return () => {
    if (entries.get(owner) === binding) entries.delete(owner);
  };
};

/** Ghostery's registered preload starts on a new document; scriptlets need it. */
export const reloadBlockerDocuments = (session: Electron.Session): void => {
  const current = documents.get(session);
  if (!current?.size) return;
  const queued = pending.get(session);
  if (queued) {
    for (const { contents } of current.values()) queued.add(contents);
    return;
  }
  const targets = new Set(
    [...current.values()].map(({ contents }) => contents),
  );
  pending.set(session, targets);
  // A rebuild disables and enables contexts synchronously. Coalesce both so
  // the new native preload is installed before one bounded document reload.
  queueMicrotask(() => {
    pending.delete(session);
    for (const contents of targets) {
      if (contents.isDestroyed() || contents.session !== session) continue;
      const url = contents.getURL();
      if (!url || url === 'about:blank' || url.startsWith('devtools://'))
        continue;
      contents.reload();
    }
  });
};
