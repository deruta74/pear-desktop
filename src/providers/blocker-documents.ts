const documents = new WeakMap<
  Electron.Session,
  Map<string, Electron.WebContents>
>();
const pending = new WeakMap<Electron.Session, Set<Electron.WebContents>>();

/** Bind only windows explicitly supplied by the application's plugin backend. */
export const setBlockerDocument = (
  session: Electron.Session,
  owner: string,
  contents: Electron.WebContents | null,
): void => {
  const entries =
    documents.get(session) ?? new Map<string, Electron.WebContents>();
  if (contents) entries.set(owner, contents);
  else entries.delete(owner);
  documents.set(session, entries);
};

/** Ghostery's registered preload starts on a new document; scriptlets need it. */
export const reloadBlockerDocuments = (session: Electron.Session): void => {
  const current = documents.get(session);
  if (!current?.size) return;
  const queued = pending.get(session);
  if (queued) {
    for (const contents of current.values()) queued.add(contents);
    return;
  }
  const targets = new Set(current.values());
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
