import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  rename,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { build } from 'vite';
import { _electron as electron } from '@playwright/test';
import {
  waitForStartupFacts,
  assertStartupFacts,
  terminateStartupProcess,
  nativeStartupPid,
} from './electron-startup.js';

const root = path.resolve(import.meta.dirname, '../..');

/** Actual isolated BrowserWindow/Session fixture; every HTTP(S) request is intercepted. */
export async function scrobblerAuthNative(
  options: { observeDownloads?: boolean } = {},
) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pear-scrobbler-window-'),
  );
  const profile = path.join(directory, 'profile');
  await mkdir(profile);
  const observer = path.join(
    root,
    'tests/helpers/electron-startup-observer.cjs',
  );
  if (
    createHash('sha256')
      .update(await readFile(observer))
      .digest('hex') !==
    'd4cedd12f3ba30afe05b597e1e35237c6dc9f4454ae18f6a3aecf21a3e9fe81c'
  )
    throw Error('Unexpected native PID observer');
  const production = path.join(
    root,
    'src/plugins/scrobbler/services/ws-auth-window.ts',
  );
  const entry = path.join(directory, 'bundle.ts');
  await writeFile(
    entry,
    (existsSync(production)
      ? `export {openScrobblingAuthWindow} from ${JSON.stringify(production)};`
      : `export function openScrobblingAuthWindow(){const ready=Promise.reject(new Error('Missing native auth window'));ready.catch(()=>{});return {ready,closed:Promise.resolve(),close(){}}}`) +
      `export {WsAuthController} from ${JSON.stringify(path.join(root, 'src/plugins/scrobbler/services/ws-auth.ts'))};`,
  );
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: directory,
      emptyOutDir: false,
      minify: false,
      lib: { entry, formats: ['cjs'], fileName: () => 'adapter.cjs' },
      rollupOptions: { external: ['electron', 'node:crypto'] },
    },
  });
  await writeFile(
    path.join(directory, 'parent.html'),
    '<html><body>Owned parent fixture</body></html>',
  );
  const script = `
const {app,BrowserWindow,session}=require('electron'),fs=require('node:fs'),path=require('node:path');
const owned=${JSON.stringify(directory)};app.setPath('userData',${JSON.stringify(profile)});fs.mkdirSync(path.join(owned,'downloads'));app.setPath('downloads',path.join(owned,'downloads'));fs.mkdirSync(path.join(owned,'sessionData'));app.setPath('sessionData',path.join(owned,'sessionData'));
const pages={mode:'normal',pending:[],requests:0};const created=[],handlers=new Map(),readyHandlers=new Map(),shows=new Map(),partitions=[];
// Opt-in passive witness only. It never replaces, wraps or reorders production listeners.
const observeDownloads = ${JSON.stringify(options.observeDownloads === true)};
const downloadStages = [],
  downloadItems = [],
  downloadSessions = new WeakMap(),
  downloadListenerIds = new WeakMap(),
  downloadObserverFunctions = new Set();
let nextDownloadSession = 0,
  nextDownloadListener = 0;
const fileFacts = () => {
  const facts = {
    entries: 0,
    files: 0,
    tmpFiles: 0,
    fixtureFiles: 0,
    otherEntries: 0,
    bytes: 0,
    vanishedAfterRead: 0,
    statFailures: 0,
  };
  const names = fs.readdirSync(path.join(owned, 'downloads'));
  facts.entries = names.length;
  for (const name of names) {
    try {
      const stat = fs.lstatSync(path.join(owned, 'downloads', name));
      if (stat.isFile()) {
        facts.files++;
        facts.bytes += stat.size;
        if (name.endsWith('.tmp')) facts.tmpFiles++;
        else if (name === 'owned.bin') facts.fixtureFiles++;
        else facts.otherEntries++;
      } else facts.otherEntries++;
    } catch (error) {
      if (error?.code === 'ENOENT') facts.vanishedAfterRead++;
      else facts.statFailures++;
    }
  }
  return facts;
};
const downloadSessionId = (ses) => {
  if (!downloadSessions.has(ses))
    downloadSessions.set(ses, ++nextDownloadSession);
  return downloadSessions.get(ses);
};
const downloadListenerId = (fn) => {
  if (!downloadListenerIds.has(fn))
    downloadListenerIds.set(fn, ++nextDownloadListener);
  return downloadListenerIds.get(fn);
};
const guards = (ses) =>
  ses
    .listeners('will-download')
    .filter((fn) => !downloadObserverFunctions.has(fn))
    .map(downloadListenerId);
const itemFacts = (item) => {
  const facts = {};
  for (const [key, method] of [
    ['state', 'getState'],
    ['receivedBytes', 'getReceivedBytes'],
    ['totalBytes', 'getTotalBytes'],
    ['paused', 'isPaused'],
    ['canResume', 'canResume'],
  ]) {
    try {
      facts[key] = item[method]();
    } catch {
      facts[key + 'Unavailable'] = true;
    }
  }
  return facts;
};
const downloadMark = (stage, details = {}) => {
  if (!observeDownloads) return;
  let physical;
  try {
    physical = fileFacts();
  } catch {
    physical = { readUnavailable: true };
  }
  downloadStages.push({ stage, time: Date.now(), ...details, physical });
};
const observeSession = (ses) => {
  if (!observeDownloads) return;
  const sessionId = downloadSessionId(ses);
  const add = (event, fn) => {
    downloadObserverFunctions.add(fn);
    ses.on(event, fn);
  };
  add('newListener', (event, fn) => {
    if (event === 'will-download' && !downloadObserverFunctions.has(fn)) {
      const listenerId = downloadListenerId(fn);
      downloadMark('guard-register-before', {
        sessionId,
        listenerId,
        activeGuardIds: guards(ses),
      });
      queueMicrotask(() =>
        downloadMark('guard-register-after', {
          sessionId,
          listenerId,
          activeGuardIds: guards(ses),
        }),
      );
    }
  });
  add('removeListener', (event, fn) => {
    if (event === 'will-download' && !downloadObserverFunctions.has(fn))
      downloadMark('guard-remove-after', {
        sessionId,
        listenerId: downloadListenerId(fn),
        activeGuardIds: guards(ses),
      });
  });
  add('will-download', (event, item, contents) => {
    const itemId = downloadItems.length + 1;
    downloadItems.push({ item, itemId, sessionId });
    const activeGuardIds = guards(ses),
      preventedBefore = event.defaultPrevented === true;
    downloadMark('will-download-before-guard', {
      sessionId,
      itemId,
      windowId: (() => {
        try {
          return BrowserWindow.fromWebContents(contents)?.id ?? null;
        } catch {
          return null;
        }
      })(),
      activeGuardIds,
      prevented: preventedBefore,
      item: itemFacts(item),
    });
    item.on('updated', (_event, state) =>
      downloadMark('item-updated', {
        sessionId,
        itemId,
        state,
        item: itemFacts(item),
      }),
    );
    item.on('done', (_event, state) =>
      downloadMark('item-done', {
        sessionId,
        itemId,
        state,
        item: itemFacts(item),
      }),
    );
    queueMicrotask(() =>
      downloadMark('will-download-after-emission', {
        sessionId,
        itemId,
        activeGuardIds: guards(ses),
        prevented: event.defaultPrevented === true,
        guardCallInferred:
          activeGuardIds.length === 1 &&
          !preventedBefore &&
          event.defaultPrevented === true,
        item: itemFacts(item),
      }),
    );
  });
};
const downloadObservation = {
  mark: downloadMark,
  snapshot: (stage, ses) => {
    downloadMark(stage, {
      sessionId: downloadSessionId(ses),
      activeGuardIds: guards(ses),
      items: downloadItems.map((value) => ({
        itemId: value.itemId,
        sessionId: value.sessionId,
        ...itemFacts(value.item),
      })),
    });
    return downloadStages[downloadStages.length - 1];
  },
  stages: () => downloadStages.map((value) => ({ ...value })),
};

const observeWindow = (win) => {
  const contents = win.webContents;
  if (observeDownloads) {
    contents.on(
      'did-fail-load',
      (_event, code, _description, url, mainFrame) => {
        const sessionId = downloadSessionId(contents.session);
        const kind = (() => {
          try {
            return new URL(url).pathname === '/download'
              ? 'download'
              : 'other-fixture';
          } catch {
            return 'unknown';
          }
        })();
        downloadMark('did-fail-load-before-production', {
          windowId: win.id,
          sessionId,
          code,
          mainFrame,
          kind,
          activeGuardIds: guards(contents.session),
        });
        queueMicrotask(() =>
          downloadMark('did-fail-load-after-emission', {
            windowId: win.id,
            sessionId,
            code,
            mainFrame,
            kind,
            windowDestroyed: win.isDestroyed(),
            activeGuardIds: guards(sesForFailure),
          }),
        );
        const sesForFailure = contents.session;
      },
    );
    win.on('closed', () => downloadMark('window-closed', { windowId: win.id }));
    contents.on('destroyed', () =>
      downloadMark('contents-destroyed', { windowId: win.id }),
    );
  }
};

const intercept=async request=>{pages.requests++;globalThis.AuthWindowFixture?.trace('HTTPS request');if(pages.mode==='hold')await new Promise(yes=>pages.pending.push(yes));if(pages.mode==='failure')throw Error('Owned load failure');if(new URL(request.url).pathname==='/download'){if(!observeDownloads)return new Response('owned download fixture',{headers:{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename=owned.bin'}});downloadMark('download-response-enter',{fixtureBodyBytes:Buffer.byteLength('owned download fixture')});const response=new Response('owned download fixture',{headers:{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename=owned.bin'}});downloadMark('download-response-return',{fixtureBodyBytes:Buffer.byteLength('owned download fixture')});return response;}return new Response('<html><body>Owned HTTPS login fixture<script>window.onbeforeunload=()=>"hold";<\/script></body></html>',{headers:{'Content-Type':'text/html'}})};
const permissions=new Map();const permissionChecks=new Map();const clears=[];const configured=new WeakSet();const configure=ses=>{if(configured.has(ses))return;configured.add(ses);observeSession(ses);const request=ses.setPermissionRequestHandler.bind(ses),check=ses.setPermissionCheckHandler.bind(ses);ses.setPermissionRequestHandler=handler=>{permissions.set(ses,handler);request(handler)};ses.setPermissionCheckHandler=handler=>{permissionChecks.set(ses,handler);check(handler)};for(const method of ['clearStorageData','clearCache']){const native=ses[method].bind(ses);ses[method]=(...args)=>{const promise=native(...args);clears.push({session:ses,method,promise});return promise;};}ses.protocol.handle('https',intercept);ses.protocol.handle('http',intercept);};
const taskPath=path.join(owned,'task.json');let lastTask=0;
fs.watchFile(taskPath,{interval:5},async()=>{if(!fs.existsSync(taskPath))return;const task=JSON.parse(fs.readFileSync(taskPath,'utf8'));if(task.id<=lastTask)return;lastTask=task.id;try{const fn=eval('('+task.source+')');const result=await fn(require('electron'),task.arg);fs.writeFileSync(path.join(owned,'result.tmp'),JSON.stringify({id:task.id,ok:true,result}));fs.renameSync(path.join(owned,'result.tmp'),path.join(owned,'result.json'));}catch(error){fs.writeFileSync(path.join(owned,'result.tmp'),JSON.stringify({id:task.id,ok:false,error:String(error?.name||'Error')}));fs.renameSync(path.join(owned,'result.tmp'),path.join(owned,'result.json'));}});
app.on('session-created',configure);app.on('window-all-closed',()=>{});
app.on('browser-window-created',(_event,win)=>{created.push(win);globalThis.AuthWindowFixture?.trace('window-created '+win.id);const contents=win.webContents;observeWindow(win);contents.on('will-navigate',(event,url)=>globalThis.AuthWindowFixture?.trace('navigate args '+typeof url+' '+typeof event.url));contents.on('did-finish-load',()=>globalThis.AuthWindowFixture?.trace('finished window '+win.id));const native=contents.setWindowOpenHandler.bind(contents);contents.setWindowOpenHandler=handler=>{handlers.set(contents.id,handler);native(details=>{globalThis.AuthWindowFixture?.trace('popup-handler begin');const answer=handler(details);globalThis.AuthWindowFixture?.trace('popup-handler '+answer.action);if(answer.createWindow){const creator=answer.createWindow;answer.createWindow=options=>{globalThis.AuthWindowFixture?.trace('popup-create begin '+Object.keys(options).join(',')+' prefs '+Object.keys(options.webPreferences||{}).join(','));const child=creator(options);globalThis.AuthWindowFixture?.trace('popup-create finish');return child;};}return answer;})};const on=win.on.bind(win);win.on=(event,handler)=>{if(event==='ready-to-show')readyHandlers.set(win.id,handler);return on(event,handler)};const show=win.show.bind(win);win.show=()=>{shows.set(win.id,(shows.get(win.id)||0)+1);return show()};if(globalThis.AuthWindowFixture?.abortOnCreate)globalThis.AuthWindowFixture.abortOnCreate.abort();});
(async()=>{await app.whenReady();configure(session.defaultSession);const parentSession=session.fromPartition('scrobble-owned-parent',{cache:false});configure(parentSession);const createParent=()=>{const win=new BrowserWindow({show:true,width:300,height:200,webPreferences:{session:parentSession,sandbox:true,contextIsolation:true,nodeIntegration:false}});win.loadFile(path.join(owned,'parent.html'));return win};
 const adapter=require('./adapter.cjs');globalThis.AuthWindowFixture={trace:phase=>fs.appendFileSync(path.join(owned,'trace.log'),phase+String.fromCharCode(10)),...adapter,main:createParent(),parentSession,defaultSession:session.defaultSession,pages,created,handlers,readyHandlers,shows,partitions,clears,permissions,permissionChecks,downloadObservation,downloadFiles:()=>fs.readdirSync(path.join(owned,'downloads')),createParent};
})().catch(()=>app.exit(1));
`;
  await writeFile(path.join(directory, 'entry.cjs'), script);
  const facts = path.join(directory, 'startup.json');
  const env = { ...process.env, PEAR_TEST_STARTUP_FACTS: facts };
  delete env.ELECTRON_RUN_AS_NODE;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let processClosed: Promise<void> | undefined;
  const waitForProcessClose = async () => {
    if (!processClosed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        processClosed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(Error('Owned auth fixture process close budget expired')),
            3000,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  try {
    app = await electron.launch({
      cwd: directory,
      args: [
        '--require',
        observer,
        path.join(directory, 'entry.cjs'),
        `--user-data-dir=${profile}`,
        '--disable-gpu',
        '--use-mock-keychain',
      ],
      env,
    });
    app.on('window', (page) =>
      page.on('dialog', (dialog) => {
        dialog.accept().catch(() => {});
      }),
    );
    const child = app.process();
    processClosed = new Promise((resolve) =>
      child.once('close', () => resolve()),
    );
    const startup = await waitForStartupFacts(child, facts);
    await assertStartupFacts(child, startup, profile);
    let closed = false;
    let nextTask = 0;
    return {
      app,
      async evaluate<T, A = undefined>(
        task: (electron: typeof import('electron'), arg: A) => T | Promise<T>,
        arg?: A,
      ): Promise<T> {
        const id = ++nextTask;
        const target = path.join(directory, 'task.json');
        await writeFile(
          target + '.tmp',
          JSON.stringify({ id, source: task.toString(), arg }),
        );
        await rename(target + '.tmp', target);
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          try {
            const packet = JSON.parse(
              await readFile(path.join(directory, 'result.json'), 'utf8'),
            );
            if (packet.id === id) {
              if (!packet.ok)
                throw new Error(`Native fixture task failed (${packet.error})`);
              return packet.result as T;
            }
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !('code' in error) ||
              error.code !== 'ENOENT'
            )
              throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('Native fixture task budget expired');
      },
      async trace() {
        try {
          return await readFile(path.join(directory, 'trace.log'), 'utf8');
        } catch {
          return '';
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              await terminateStartupProcess(child);
            } catch {
              if (child.exitCode === null && child.signalCode === null) {
                const pid = await nativeStartupPid(child);
                const exited = once(child, 'exit', {
                  signal: AbortSignal.timeout(1000),
                });
                process.kill(pid, 'SIGKILL');
                await exited;
              }
            }
          }
        } finally {
          await waitForProcessClose();
          await rm(directory, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
          });
        }
      },
    };
  } catch (error) {
    if (
      app &&
      app.process().exitCode === null &&
      app.process().signalCode === null
    )
      await terminateStartupProcess(app.process());
    await waitForProcessClose();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    throw error;
  }
}
