'use strict';

// SOURCE ONLY. Imports are inert. No local execution or CI is admitted here.
const CARRIER_PATHS = [
  '.github/workflows/tests.yml',
  'scripts/api-music-nonloopback-admission.json',
  'scripts/api-music-nonloopback-carrier.cjs',
  'scripts/api-music-nonloopback-carrier.node.cjs',
];
const CARRIER_CHANGES = CARRIER_PATHS.map(
  (file, index) => (index === 0 ? 'M' : 'A') + '\t' + file,
);
const SOURCE_HEAD = 'b4ea9b35420995122e7a050c232cce0e46adf581';
const SOURCE_TREE = 'c2617ab2362ae674bc343591a53a35b8a9d5d36c';
const SOURCE_PARENT = '9659187ca3b7663e78039def9d929bc1b586ef58';
const STATIC_SVG = 'assets/generated/icons/mac/icon.icon/Assets/SVG Image.svg';
const fail = (reason) => {
  throw Error(reason);
};
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, names) =>
  object(v) && Object.keys(v).sort().join('|') === [...names].sort().join('|');
const sha = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const head = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const image = (v) => typeof v === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(v);
const numberId = (v) => typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v);
function admit(policy, mode, actual) {
  const bad = () => fail('ADMISSION_UNPROVEN');
  if (
    !head(SOURCE_HEAD) || !head(SOURCE_TREE) || !head(SOURCE_PARENT) ||
    !['inspect', 'qualify'].includes(mode) ||
    !keys(policy, [
      'schema',
      'sourceHead',
      'sourceTree',
      'sourceParent',
      'nodeVersion',
      'pnpmVersion',
      'lockSHA256',
      'cliSHA256',
      'platforms',
    ]) ||
    policy.schema !== 1 ||
    policy.sourceHead !== SOURCE_HEAD ||
    policy.sourceTree !== SOURCE_TREE ||
    policy.sourceParent !== SOURCE_PARENT ||
    policy.nodeVersion !== 'v24.20.0' ||
    policy.pnpmVersion !== '11.28.6' ||
    !sha(policy.lockSHA256) ||
    !sha(policy.cliSHA256) ||
    !Array.isArray(policy.platforms) ||
    policy.platforms.length !== 3
  )
    bad();
  const triples = [
    ['ubuntu-24.04', 'linux', 'x64'],
    ['macos-latest', 'darwin', 'arm64'],
    ['windows-latest', 'win32', 'x64'],
  ];
  policy.platforms.forEach((row, i) => {
    if (
      !keys(row, [
        'label',
        'platform',
        'arch',
        'imageOS',
        'imageVersion',
        'nodeSHA256',
        'systemRoot',
        'powerShellIdentity',
      ]) ||
      [row.label, row.platform, row.arch].join('|') !== triples[i].join('|') ||
      !(row.imageOS === null || image(row.imageOS)) ||
      !(row.imageVersion === null || image(row.imageVersion)) ||
      !(row.nodeSHA256 === null || sha(row.nodeSHA256)) ||
      (row.platform === 'win32'
        ? row.systemRoot !== 'C:\\Windows' ||
          row.powerShellIdentity !== 'MICROSOFT_AUTHENTICODE_VALID'
        : row.systemRoot !== null || row.powerShellIdentity !== null)
    )
      bad();
  });
  const row = policy.platforms.find((row) => row.platform === actual.platform);
  if (!row || row.arch !== actual.arch) bad();
  if (
    mode === 'qualify' &&
    (!image(row.imageVersion) ||
      !sha(row.nodeSHA256) ||
      (row.imageOS !== null && row.imageOS !== actual.imageOS) ||
      row.imageVersion !== actual.imageVersion ||
      actual.nodeVersion !== policy.nodeVersion ||
      row.nodeSHA256 !== actual.nodeSHA256 ||
      (row.platform === 'win32' &&
        (row.systemRoot !== actual.systemRoot ||
          row.powerShellIdentity !== actual.powerShellIdentity)))
  )
    bad();
  return row;
}
function bindSource(policy, value) {
  const bad = () => fail('SOURCE_UNPROVEN');
  if (
    !head(SOURCE_HEAD) || !head(SOURCE_TREE) || !head(SOURCE_PARENT) ||
    !head(policy.sourceHead) || !head(policy.sourceTree) || !head(policy.sourceParent) ||
    policy.sourceHead !== SOURCE_HEAD || policy.sourceTree !== SOURCE_TREE || policy.sourceParent !== SOURCE_PARENT ||
    value.event !== 'workflow_dispatch' ||
    value.repository !== 'deruta74/pear-desktop' ||
    value.ref !== 'refs/heads/diagnostic/api-nonloopback-qualified-f6' ||
    !head(value.expectedCarrierSHA) ||
    value.head !== value.expectedCarrierSHA ||
    value.githubSHA !== value.head ||
    value.workflowRef !==
      'deruta74/pear-desktop/.github/workflows/tests.yml@' + value.ref ||
    value.workflowSHA !== value.head ||
    value.parents !== policy.sourceHead ||
    value.sourceTree !== policy.sourceTree ||
    value.sourceParent !== policy.sourceParent ||
    !sha(value.expectedWorkflowSHA256) ||
    value.workflowSHA256 !== value.expectedWorkflowSHA256 ||
    !sha(value.expectedHelperSHA256) ||
    value.helperSHA256 !== value.expectedHelperSHA256 ||
    !sha(value.expectedPolicySHA256) ||
    value.policySHA256 !== value.expectedPolicySHA256 ||
    !Array.isArray(value.changes) ||
    [...value.changes].sort().join('|') !==
      [...CARRIER_CHANGES].sort().join('|') ||
    value.trackedDirty !== false ||
    !Array.isArray(value.unexpectedFiles) ||
    value.unexpectedFiles.length
  )
    bad();
}
function makePlan(policy, row, env, node, manifestSHA256, jobId) {
  if (
    !numberId(jobId) ||
    !numberId(env.GITHUB_RUN_ID) ||
    !numberId(env.GITHUB_RUN_ATTEMPT) ||
    !sha(manifestSHA256)
  )
    fail('ADMISSION_UNPROVEN');
  return {
    schema: 1,
    disposableRunner: true,
    platform: row.platform,
    arch: row.arch,
    image: env.ImageVersion,
    repository: 'deruta74/pear-desktop',
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    jobId,
    expectedHead: policy.sourceHead,
    expectedTree: policy.sourceTree,
    sourceManifestSHA256: manifestSHA256,
    node,
    cliSHA256: policy.cliSHA256,
    lockSHA256: policy.lockSHA256,
  };
}
function runnerManifest(complete) {
  const runtime = {};
  for (const [file, hash] of Object.entries(complete)) {
    if (file === STATIC_SVG) continue;
    if (!/^[A-Za-z0-9_.@/-]+$/.test(file) || !sha(hash))
      fail('SOURCE_UNPROVEN');
    runtime[file] = hash;
  }
  return runtime;
}
function runnerEnvironment(env, nodeDirectory, privateRoot, path) {
  const out = {
    CI: '1',
    PATH: nodeDirectory,
    HOME: privateRoot,
    USERPROFILE: privateRoot,
    TEMP: path.join(privateRoot, 'tmp'),
    TMP: path.join(privateRoot, 'tmp'),
    TMPDIR: path.join(privateRoot, 'tmp'),
  };
  for (const name of [
    'GITHUB_ACTIONS',
    'RUNNER_ENVIRONMENT',
    'RUNNER_TEMP',
    'GITHUB_REPOSITORY',
    'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT',
    'ImageVersion',
  ])
    out[name] = env[name];
  if (env.SystemRoot) out.SystemRoot = env.SystemRoot;
  return out;
}

const FAILURE_STAGES = new Set([
  'BINDING',
  'TOOL_IMAGE',
  'NODE_PIN',
  'WINDOWS_RESOLVER',
  'WINDOWS_PROBE',
  'PRIVATE_ROOT',
  'PRIVATE_FILES',
  'ENV_PUBLISH',
  'OWNERSHIP',
  'TOOL_PINS',
  'MANIFEST',
  'PLAN',
  'CHILD',
  'RESULT_PARSE',
  'POST_PINS',
  'REMOVAL',
  'EMISSION',
]);
const FAILURE_REASONS = new Set([
  'HOST_UNPROVEN',
  'SOURCE_UNPROVEN',
  'ADMISSION_UNPROVEN',
  'POWERSHELL_UNPROVEN',
  'WINDOWS_PRIVATE_ROOT_UNPROVEN',
  'WINDOWS_PRIVATE_TEMP_UNPROVEN',
  'WINDOWS_HELPER_NO_CLOSE',
  'PRIVATE_TEMP_FAILED',
  'OWNERSHIP_UNPROVEN',
  'FILE_UNPROVEN',
  'DEPENDENCY_UNPROVEN',
  'RUNNER_UNPROVEN',
  'RUNNER_EVIDENCE_REJECTED',
  'CLEANUP_FAILED',
  'INVALID_PLAN',
  'PIN_MISMATCH',
]);
const OS_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EEXIST',
  'ENOTDIR',
  'EISDIR',
  'EIO',
  'ENOSPC',
  'EMFILE',
  'ENFILE',
  'EINVAL',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNRESET',
  'ENOBUFS',
  'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
]);
const SIGNALS = new Set([
  'SIGTERM',
  'SIGKILL',
  'SIGINT',
  'SIGHUP',
  'SIGQUIT',
  'SIGABRT',
  'SIGBUS',
  'SIGFPE',
  'SIGILL',
  'SIGPIPE',
  'SIGSEGV',
  'SIGUSR1',
  'SIGUSR2',
  'SIGBREAK',
  'SIGALRM',
  'SIGTRAP',
]);
const INNER_REASONS = new Set([
  'INVALID_PLAN',
  'PIN_MISMATCH',
  'TOPOLOGY_UNAVAILABLE',
  'WINDOWS_PRIVATE_TEMP_UNPROVEN',
  'PRIVATE_TEMP_FAILED',
  'ADMISSION_WRITE_FAILED',
  'CHILD_FAILED',
  'CHILD_NO_CLOSE',
  'CHILD_TIMEOUT',
  'CHILD_OUTPUT_LIMIT',
  'CHILD_CANCELLED',
  'CHILD_SPAWN_FAILED',
  'CHILD_LOG_FAILED',
  'INVALID_REPORT',
  'CLEANUP_FAILED',
  'CANCELLED',
  'WINDOWS_HELPER_NO_CLOSE',
]);
function ownData(value, name) {
  try {
    if (value === null || !['object', 'function'].includes(typeof value))
      return { known: false };
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor) return { known: true, value: undefined };
    return Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? { known: true, value: descriptor.value }
      : { known: false };
  } catch {
    return { known: false };
  }
}
function osCode(error) {
  const field = ownData(error, 'code');
  return field.known &&
    typeof field.value === 'string' &&
    OS_CODES.has(field.value)
    ? field.value
    : 'UNKNOWN';
}
function errorReason(error) {
  for (const key of ['code', 'message']) {
    const field = ownData(error, key);
    if (
      field.known &&
      typeof field.value === 'string' &&
      FAILURE_REASONS.has(field.value)
    )
      return field.value;
  }
  return 'UNKNOWN';
}
function failureLedger(command) {
  return {
    command,
    stage: 'BINDING',
    probe: null,
    child: null,
    inner: null,
    tool: { cliSHA256: null, cliVersion: null },
    primary: null,
  };
}
const boundedNumber = (v, max) =>
  Number.isSafeInteger(v) && v >= 0 && v <= max ? v : null;
function childFacts(value, elapsedMs) {
  const status = ownData(value, 'status'),
    signal = ownData(value, 'signal'),
    error = ownData(value, 'error'),
    killed = ownData(value, 'killed');
  const code = boundedNumber(status.value, 255),
    sig = signal.known
      ? signal.value === null
        ? null
        : SIGNALS.has(signal.value)
          ? signal.value
          : 'UNKNOWN'
      : 'UNKNOWN';
  const normalClose =
    status.known &&
    code !== null &&
    signal.known &&
    signal.value === null &&
    error.known &&
    !error.value;
  const errorCode = osCode(error.value),
    errorKilled = ownData(error.value, 'killed');
  return {
    normalClose,
    code,
    signal: sig,
    errorCode,
    timedOut: errorCode === 'UNKNOWN' ? null : errorCode === 'ETIMEDOUT',
    killed:
      typeof killed.value === 'boolean'
        ? killed.value
        : typeof errorKilled.value === 'boolean'
          ? errorKilled.value
          : null,
    elapsedMs: boundedNumber(elapsedMs, 300000),
    stdoutBytes: null,
    stderrBytes: null,
  };
}
const PROBE_PHASES = ['ENTRY','INPUT_READ','INPUT_PARSED','PATH_FILE_CHECKED','SIGNATURE_BEGIN','SIGNATURE_RETURNED','VERSION_READY'];
const PROBE_TRANSCRIPT = 'PDP2:0\nPDP2:1\nPDP2:2\nPDP2:3\nPDP2:4\nPDP2:5\nPDP2:6\n';
function probePhaseStream(stderr, stdout) {
  const out = {version:2,state:'UNAVAILABLE',last:null,completed:0};
  if (!Buffer.isBuffer(stderr)) return out;
  if (stderr.length > 49 || (Buffer.isBuffer(stdout) && stderr.length + stdout.length > 1024)) {
    out.state='OVERSIZE'; return out;
  }
  if (!stderr.length) { out.state='ABSENT'; return out; }
  if (!stderr.equals(Buffer.from(PROBE_TRANSCRIPT,'ascii').subarray(0,stderr.length))) { out.state='INVALID'; return out; }
  out.completed=Math.floor(stderr.length/7);
  out.last=out.completed ? PROBE_PHASES[out.completed-1] : null;
  out.state=stderr.length===49 ? 'COMPLETE' : stderr.length%7===0 ? 'PREFIX' : 'TRUNCATED';
  return out;
}
// Closed-key own-data snapshots; traps can throw but never become raw diagnostics.
function recordData(value, required, optional=[]) {
  try {
    if (!value || typeof value!=='object' || Array.isArray(value)) throw Error();
    const proto=Object.getPrototypeOf(value);
    if (proto!==null && proto!==Object.prototype) throw Error();
    const names=Reflect.ownKeys(value), out={};
    if (required.some(k=>!names.includes(k))) throw Error();
    for (const k of names) {
      if (typeof k!=='string' || (!required.includes(k)&&!optional.includes(k))) throw Error();
      const d=Object.getOwnPropertyDescriptor(value,k);
      if (!d || !Object.hasOwn(d,'value') || !d.enumerable || d.value===undefined) throw Error();
      out[k]=d.value;
    }
    return out;
  } catch { fail('RUNNER_EVIDENCE_REJECTED'); }
}
function phaseFacts(value) {
  try {
    const v=recordData(value,['version','state','last','completed']);
    if (v.version!==2 || !Number.isInteger(v.completed) || v.completed<0 || v.completed>7 ||
        v.last!==(v.completed ? PROBE_PHASES[v.completed-1] : null)) throw Error();
    if (v.state==='COMPLETE' ? v.completed!==7 : v.state==='PREFIX' ? v.completed<1||v.completed>6 :
        v.state==='TRUNCATED' ? v.completed>6 :
        !['ABSENT','INVALID','OVERSIZE','UNAVAILABLE'].includes(v.state)||v.completed!==0) throw Error();
    return v;
  } catch { return {version:2,state:'UNAVAILABLE',last:null,completed:0}; }
}
const CHILD_ORIGINS = new Set(['CHILD_FAILED','CHILD_NO_CLOSE','CHILD_TIMEOUT','CHILD_OUTPUT_LIMIT','CHILD_CANCELLED','CHILD_SPAWN_FAILED','CHILD_LOG_FAILED']);
function safeChildFailure(value, finalReason) {
  try {
    const v=recordData(value,['version','origin','disposition','child','reporter','scan','target','errors','first']);
    const c=recordData(v.child,['closed','code','signal','reason']), t=recordData(v.target,['specs','tests','results','statusMask']), e=recordData(v.errors,['root','target']);
    const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
    if (v.version!==1 || !CHILD_ORIGINS.has(v.origin) ||
        (CHILD_ORIGINS.has(finalReason) ? v.origin!==finalReason : !['CLEANUP_FAILED','CANCELLED'].includes(finalReason)) ||
        !['RETURNED','REJECTED','UNKNOWN'].includes(v.disposition) ||
        !(c.closed===null||typeof c.closed==='boolean') ||
        !(c.code===null||integer(c.code,-2147483648,4294967295)) ||
        !(c.signal===null||c.signal==='UNKNOWN'||SIGNALS.has(c.signal)) ||
        !(c.reason===null||['TIMEOUT','OUTPUT_LIMIT','CANCELLED','SPAWN_FAILED','LOG_FAILED','UNKNOWN'].includes(c.reason)) ||
        !['EMPTY','VALID','INVALID','UNAVAILABLE'].includes(v.reporter) || !['COMPLETE','LIMIT','UNKNOWN'].includes(v.scan)) throw Error();
    for (const k of ['specs','tests','results','statusMask']) if (!(t[k]===null||integer(t[k],0,k==='statusMask'?31:64))) throw Error();
    for (const k of ['root','target']) if (!(e[k]===null||integer(e[k],0,64))) throw Error();
    let first=null;
    if (v.first!==null) {
      first=recordData(v.first,['name','code','file','line','column']);
      if (!['Error','TypeError','SyntaxError','RangeError','ReferenceError','AssertionError','TimeoutError','AggregateError','UNKNOWN'].includes(first.name) ||
          !['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','ERR_PACKAGE_PATH_NOT_EXPORTED','ERR_REQUIRE_ESM','ERR_UNKNOWN_FILE_EXTENSION','ERR_UNSUPPORTED_DIR_IMPORT','ERR_ASSERTION','ENOENT','EACCES','EPERM','EADDRINUSE','EADDRNOTAVAIL','ETIMEDOUT','UNKNOWN'].includes(first.code) ||
          !['TEST','REMOTE_FIXTURE','MODULE_HELPER','REQUEST_HELPER','UNKNOWN'].includes(first.file) ||
          (first.file==='UNKNOWN' ? first.line!==null||first.column!==null : !integer(first.line,1,1000000)||!integer(first.column,1,1000000))) throw Error();
    }
    if (v.scan==='COMPLETE') {
      if (v.reporter!=='VALID' || [...Object.values(t),...Object.values(e)].some(n=>n===null) || e.root+e.target>64 ||
          (t.specs===0&&(t.tests!==0||t.results!==0||t.statusMask!==0||e.target!==0)) ||
          (t.tests===0&&(t.results!==0||t.statusMask!==0||e.target!==0)) ||
          (t.results===0&&(t.statusMask!==0||e.target!==0)) || (t.results>0&&t.statusMask===0) ||
          [1,2,4,8,16].filter(bit=>(t.statusMask&bit)!==0).length>t.results ||
          (first!==null&&e.root+e.target===0)) throw Error();
    } else if ([...Object.values(t),...Object.values(e)].some(n=>n!==null)||first!==null) throw Error();
    if ((['EMPTY','INVALID'].includes(v.reporter)&&v.scan!=='UNKNOWN') || (v.reporter==='UNAVAILABLE'&&v.scan==='COMPLETE')) throw Error();
    if (v.disposition!=='RETURNED' && (c.closed!==null||c.code!==null||c.signal!=='UNKNOWN'||c.reason!=='UNKNOWN'||v.reporter!=='UNAVAILABLE'||v.scan!=='UNKNOWN')) throw Error();
    const out={version:1,origin:v.origin,disposition:v.disposition,child:{closed:c.closed,code:c.code,signal:c.signal,reason:c.reason},reporter:v.reporter,scan:v.scan,target:{specs:t.specs,tests:t.tests,results:t.results,statusMask:t.statusMask},errors:{root:e.root,target:e.target},first:first===null?null:{name:first.name,code:first.code,file:first.file,line:first.line,column:first.column}};
    if (Buffer.byteLength(JSON.stringify(out),'utf8')>1024) throw Error();
    return out;
  } catch { fail('RUNNER_EVIDENCE_REJECTED'); }
}
function innerFailureValue(reason, value, present) {
  if (CHILD_ORIGINS.has(reason) || present) return safeChildFailure(value,reason);
  return null;
}
function formatResult(value) {
  const bytes=JSON.stringify(value,null,2)+'\n';
  if (Buffer.byteLength(bytes,'utf8')>8192) fail('FILE_UNPROVEN');
  return bytes;
}
function emptyProtocols(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value)!==Array.prototype) return false;
    const names=Reflect.ownKeys(value), length=Object.getOwnPropertyDescriptor(value,'length');
    return names.length===1 && names[0]==='length' && length && Object.hasOwn(length,'value') && length.value===0;
  } catch { return false; }
}
function probeFacts(value) {
  if (!value) return null;
  const out = {};
  for (const key of [
    'returned',
    'normalClose',
    'killed',
    'timedOut',
    'jsonParsed',
    'schemaValid',
    'trusted',
    'versionShapeValid',
  ]) {
    const f = ownData(value, key);
    out[key] = typeof f.value === 'boolean' ? f.value : null;
  }
  for (const [key, max] of [
    ['code', 255],
    ['elapsedMs', 300000],
    ['stdoutBytes', 2 * 1024 * 1024],
    ['stderrBytes', 2 * 1024 * 1024],
  ])
    out[key] = boundedNumber(ownData(value, key).value, max);
  const sig = ownData(value, 'signal').value;
  out.signal = sig === null ? null : SIGNALS.has(sig) ? sig : 'UNKNOWN';
  const code = ownData(value, 'errorCode').value;
  out.errorCode = OS_CODES.has(code) ? code : 'UNKNOWN';
  out.phaseStream = phaseFacts(ownData(value,'phaseStream').value);
  return out;
}
function rememberFailure(ledger, error) {
  function safeChildFacts(value) {
    if (!value) return null;
    const out = {};
    for (const key of ['normalClose', 'killed', 'timedOut']) {
      const v = ownData(value, key).value;
      out[key] = typeof v === 'boolean' ? v : null;
    }
    for (const [key, max] of [
      ['code', 255],
      ['elapsedMs', 300000],
      ['stdoutBytes', 2 * 1024 * 1024],
      ['stderrBytes', 2 * 1024 * 1024],
    ])
      out[key] = boundedNumber(ownData(value, key).value, max);
    const signal = ownData(value, 'signal').value;
    out.signal =
      signal === null ? null : SIGNALS.has(signal) ? signal : 'UNKNOWN';
    const code = ownData(value, 'errorCode').value;
    out.errorCode = OS_CODES.has(code) ? code : 'UNKNOWN';
    return out;
  }
  function safeInnerFacts(value) {
    if (!value) return null;
    const validated = ownData(value, 'validated').value === true,
      reason = ownData(value, 'reason').value,
      phase = ownData(value, 'phase').value;
    const phases = new Set([
      'PINS',
      'PLAN',
      'TOPOLOGY',
      'ADMISSION',
      'REPORT',
      'CLEANUP',
      'CANCELLED',
      'CHILD',
      'PRIVATE_TEMP',
    ]);
    const valid = validated && INNER_REASONS.has(reason) && phases.has(phase);
    return {
      validated: valid,
      reason: valid ? reason : 'UNKNOWN',
      phase: valid ? phase : 'UNKNOWN',
      cleanup:
        valid && ownData(value, 'cleanup').value === 'UNPROVEN'
          ? 'UNPROVEN'
          : null,
      outerReapRequired:
        valid && ownData(value, 'outerReapRequired').value === true
          ? true
          : null,
    };
  }

  if (ledger.primary) return ledger.primary;
  const child = safeChildFacts(ledger.child),
    cliSHA = ownData(ledger.tool, 'cliSHA256').value,
    cliVersion = ownData(ledger.tool, 'cliVersion').value;
  let inner=safeInnerFacts(ledger.inner), innerFailure=null;
  if (inner?.validated) {
    try {
      const summary=ownData(ledger.inner,'innerFailure').value;
      innerFailure=innerFailureValue(inner.reason,summary,summary!==undefined&&summary!==null);
    } catch {
      inner={validated:false,reason:'UNKNOWN',phase:'UNKNOWN',cleanup:null,outerReapRequired:null};
    }
  }
  ledger.primary = {
    version: 3,
    command: ['preflight', 'prepare', 'run', 'cleanup'].includes(ledger.command)
      ? ledger.command
      : 'UNKNOWN',
    stage: FAILURE_STAGES.has(ledger.stage) ? ledger.stage : 'UNKNOWN',
    reason: errorReason(error),
    osCode: osCode(error),
    probe: probeFacts(ledger.probe),
    child,
    inner,
    innerFailure,
    tool: {
      cliSHA256: sha(cliSHA) ? cliSHA : null,
      cliVersion:
        typeof cliVersion === 'string' &&
        /^\d{1,3}\.\d{1,4}\.\d{1,4}$/.test(cliVersion)
          ? cliVersion
          : null,
    },
  };
  return ledger.primary;
}
function failureProvenance(observed) {
  const out = {};
  for (const key of ['sourceHead', 'sourceTree', 'carrierHead', 'carrierTree'])
    out[key] = head(ownData(observed, key).value)
      ? ownData(observed, key).value
      : null;
  out.registeredWorkflowId = '376634247';
  out.diagnosticRef = 'diagnostic/api-nonloopback-qualified-f6';
  for (const key of [
    'workflowSHA256',
    'helperSHA256',
    'policySHA256',
    'nodeSHA256',
  ])
    out[key] = sha(ownData(observed, key).value)
      ? ownData(observed, key).value
      : null;
  const platform = ownData(observed, 'platform').value,
    arch = ownData(observed, 'arch').value,
    nodeVersion = ownData(observed, 'nodeVersion').value,
    rootMatch = ownData(observed, 'systemRootMatches').value;
  out.platform = ['linux', 'darwin', 'win32'].includes(platform)
    ? platform
    : null;
  out.arch = ['x64', 'arm64'].includes(arch) ? arch : null;
  for (const key of ['imageOS', 'imageVersion'])
    out[key] = image(ownData(observed, key).value)
      ? ownData(observed, key).value
      : null;
  out.nodeVersion =
    typeof nodeVersion === 'string' &&
    /^v\d{1,3}\.\d{1,4}\.\d{1,4}$/.test(nodeVersion)
      ? nodeVersion
      : null;
  out.systemRootMatches = typeof rootMatch === 'boolean' ? rootMatch : null;
  return out;
}
function errorArtifact(ledger, observed, reason) {
  return {
    schema: 1,
    status: 'UNPROVEN',
    reason: [
      'CARRIER_FAILED',
      'CARRIER_RUN_UNPROVEN',
      'CARRIER_CLEANUP_UNPROVEN',
    ].includes(reason)
      ? reason
      : 'CARRIER_FAILED',
    manifestScope: 'CARRIER_HEAD_TRACKED_FILES',
    provenance: failureProvenance(observed),
    processAbsence: 'UNPROVEN',
    outerReap: 'HOSTED_VM_AT_JOB_END',
    diagnostics: ledger.primary,
  };
}
function safeInnerFailure(bytes, plan) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > 65536) throw Error();
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw Error();
    const parsed = JSON.parse(text),
      expected = [
        'schema',
        'status',
        'reason',
        'protocols',
        'platform',
        'arch',
        'image',
        'expectedHead',
        'expectedTree',
        'sourceManifestSHA256',
        'nodeVersion',
        'nodeSHA256',
        'cliSHA256',
        'lockSHA256',
        'certSHA256',
        'runURL',
        'jobId',
        'endpointLabel',
      ],
      optional = ['cleanup', 'outerReapRequired', 'childFailure'];
    const value=recordData(parsed,expected,optional);
    if (
      !object(value) ||
      !expected.every((k) => Object.hasOwn(value, k)) ||
      Object.keys(value).some(
        (k) => !expected.includes(k) && !optional.includes(k),
      ) ||
      value.schema !== 1 ||
      value.status !== 'UNPROVEN' ||
      !INNER_REASONS.has(value.reason) ||
      !emptyProtocols(value.protocols)
    )
      throw Error();
    const wanted = {
      platform: plan.platform,
      arch: plan.arch,
      image: plan.image,
      expectedHead: plan.expectedHead,
      expectedTree: plan.expectedTree,
      sourceManifestSHA256: plan.sourceManifestSHA256,
      nodeVersion: plan.node.version,
      nodeSHA256: plan.node.sha256,
      cliSHA256: plan.cliSHA256,
      lockSHA256: plan.lockSHA256,
      certSHA256:
        '597b4509e1ad0c12b69402bc0cff55bcb3f28603dea13a36623eb38891d109a3',
      runURL:
        'https://github.com/' +
        plan.repository +
        '/actions/runs/' +
        plan.runId +
        '/attempts/' +
        plan.attempt,
      jobId: plan.jobId,
      endpointLabel: 'runner-owned-v4',
    };
    for (const [k, v] of Object.entries(wanted))
      if (value[k] !== v) throw Error();
    if (Object.hasOwn(value, 'cleanup') && value.cleanup !== 'UNPROVEN')
      throw Error();
    if (
      Object.hasOwn(value, 'outerReapRequired') &&
      value.outerReapRequired !== true
    )
      throw Error();
    const innerFailure=innerFailureValue(value.reason,value.childFailure,Object.hasOwn(value,'childFailure'));
    const reason = value.reason,
      phase =
        reason === 'PIN_MISMATCH'
          ? 'PINS'
          : reason === 'INVALID_PLAN'
            ? 'PLAN'
            : reason === 'TOPOLOGY_UNAVAILABLE'
              ? 'TOPOLOGY'
              : reason === 'ADMISSION_WRITE_FAILED'
                ? 'ADMISSION'
                : reason === 'INVALID_REPORT'
                  ? 'REPORT'
                  : reason === 'CLEANUP_FAILED'
                    ? 'CLEANUP'
                    : reason === 'CANCELLED'
                      ? 'CANCELLED'
                      : reason.startsWith('CHILD')
                        ? 'CHILD'
                        : 'PRIVATE_TEMP';
    return {
      validated: true,
      reason,
      phase,
      cleanup: value.cleanup ?? null,
      outerReapRequired: value.outerReapRequired ?? null,
      innerFailure,
    };
  } catch {
    fail('RUNNER_EVIDENCE_REJECTED');
  }
}

function verifyPowerShellIdentity(tool, io, diagnostic) {
  const program = String.raw`
[Console]::Error.Write([string]::Concat('PDP2:0',[char]10));[Console]::Error.Flush()
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$WarningPreference='SilentlyContinue'
try {
  $inputLine=[Console]::In.ReadLine()
  [Console]::Error.Write([string]::Concat('PDP2:1',[char]10));[Console]::Error.Flush()
  $request=$inputLine|ConvertFrom-Json
  [Console]::Error.Write([string]::Concat('PDP2:2',[char]10));[Console]::Error.Flush()
  $tool=[IO.Path]::GetFullPath([string]$request.tool)
  if($tool -cne [string]$request.tool){throw 'unavailable'}
  $item=Get-Item -LiteralPath $tool -Force
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'unavailable'}
  [Console]::Error.Write([string]::Concat('PDP2:3',[char]10));[Console]::Error.Flush()
  [Console]::Error.Write([string]::Concat('PDP2:4',[char]10));[Console]::Error.Flush()
  $signature=Get-AuthenticodeSignature -LiteralPath $tool
  [Console]::Error.Write([string]::Concat('PDP2:5',[char]10));[Console]::Error.Flush()
  if($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)'){throw 'unavailable'}
  $v=[Diagnostics.FileVersionInfo]::GetVersionInfo($tool)
  $version=@($v.FileMajorPart,$v.FileMinorPart,$v.FileBuildPart,$v.FilePrivatePart)-join '.'
  [Console]::Error.Write([string]::Concat('PDP2:6',[char]10));[Console]::Error.Flush()
  [Console]::Write(('{"version":1,"trusted":true,"fileVersion":"'+$version+'"}'))
}catch{[Console]::Write('{"version":1,"trusted":false}');exit 1}
`;
  const facts = {
    returned: null,
    normalClose: null,
    code: null,
    signal: null,
    errorCode: 'UNKNOWN',
    timedOut: null,
    killed: null,
    elapsedMs: null,
    stdoutBytes: null,
    stderrBytes: null,
    jsonParsed: null,
    schemaValid: null,
    trusted: null,
    versionShapeValid: null,
    phaseStream: probePhaseStream(undefined),
  };
  const started = Date.now();
  try {
    const input = JSON.stringify({ tool }) + '\n';
    if (Buffer.byteLength(input) > 16384) throw Error();
    let raw;
    try {
      raw = io.spawnSync(
        tool,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(program, 'utf16le').toString('base64'),
        ],
        {
          shell: false,
          windowsHide: true,
          encoding: null,
          input,
          timeout: 15000,
          killSignal: 'SIGKILL',
          maxBuffer: 1024,
          env: {
            CI: '1',
            SystemRoot: io.env.SystemRoot,
            PATH: io.env.PATH,
            TEMP: io.parent,
            TMP: io.parent,
          },
        },
      );
      facts.returned = true;
    } catch (error) {
      facts.returned = false;
      facts.errorCode = osCode(error);
      throw error;
    }
    const transport = childFacts(raw, Date.now() - started);
    for (const key of [
      'normalClose',
      'code',
      'signal',
      'errorCode',
      'timedOut',
      'killed',
    ])
      facts[key] = transport[key];
    const stdout = ownData(raw, 'stdout').value,
      stderr = ownData(raw, 'stderr').value;
    facts.stdoutBytes = Buffer.isBuffer(stdout)
      ? boundedNumber(stdout.length, 2 * 1024 * 1024)
      : null;
    facts.stderrBytes = Buffer.isBuffer(stderr)
      ? boundedNumber(stderr.length, 2 * 1024 * 1024)
      : null;
    facts.phaseStream=probePhaseStream(stderr,stdout);
    let value;
    if (
      transport.normalClose &&
      Buffer.isBuffer(stdout) &&
      stdout.length <= 256
    ) {
      try {
        value = JSON.parse(stdout.toString('utf8'));
        facts.jsonParsed = true;
        facts.schemaValid =
          keys(value, ['version', 'trusted', 'fileVersion']) &&
          value.version === 1;
        const trust = ownData(value, 'trusted').value;
        facts.trusted = typeof trust === 'boolean' ? trust : null;
        const version = ownData(value, 'fileVersion').value;
        facts.versionShapeValid =
          typeof version === 'string'
            ? /^\d{1,10}(\.\d{1,10}){3}$/.test(version)
            : null;
      } catch {
        facts.jsonParsed = false;
        facts.schemaValid = false;
      }
    }
    if (
      !transport.normalClose ||
      transport.code !== 0 ||
      !Buffer.isBuffer(stdout) ||
      stdout.length > 256 ||
      !Buffer.isBuffer(stderr) ||
      facts.phaseStream.state !== 'COMPLETE' ||
      stdout.length + stderr.length > 1024
    )
      throw Error();
    if (
      !keys(value, ['version', 'trusted', 'fileVersion']) ||
      value.version !== 1 ||
      value.trusted !== true ||
      typeof value.fileVersion !== 'string' ||
      !/^\d{1,10}(\.\d{1,10}){3}$/.test(value.fileVersion)
    )
      throw Error();
    return value.fileVersion;
  } catch (error) {
    if (facts.errorCode === 'UNKNOWN') facts.errorCode = osCode(error);
    fail('POWERSHELL_UNPROVEN');
  } finally {
    facts.elapsedMs = boundedNumber(Date.now() - started, 300000);
    // Diagnostic recorder failure cannot change the primary probe result.
    try {
      if (diagnostic && typeof diagnostic === 'object')
        for (const [key, value] of Object.entries(facts))
          Object.defineProperty(diagnostic, key, {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
    } catch {}
  }
}
// This schema validates data emitted by the pinned runner; no raw Playwright or error text is copied.
function safeRunner(value, plan) {
  const expected = [
    'schema',
    'status',
    'reason',
    'protocols',
    'platform',
    'arch',
    'image',
    'expectedHead',
    'expectedTree',
    'sourceManifestSHA256',
    'nodeVersion',
    'nodeSHA256',
    'cliSHA256',
    'lockSHA256',
    'certSHA256',
    'runURL',
    'jobId',
    'endpointLabel',
  ];
  const optional = ['cleanup', 'outerReapRequired', 'childFailure'];
  value=recordData(value,expected,optional);
  if (
    !object(value) ||
    !expected.every((k) => Object.hasOwn(value, k)) ||
    Object.keys(value).some(
      (k) => !expected.includes(k) && !optional.includes(k),
    )
  )
    fail('RUNNER_EVIDENCE_REJECTED');
  const reasons = [
    'CHECKPOINTS_COMPLETE',
    'INVALID_PLAN',
    'PIN_MISMATCH',
    'TOPOLOGY_UNAVAILABLE',
    'WINDOWS_PRIVATE_TEMP_UNPROVEN',
    'PRIVATE_TEMP_FAILED',
    'ADMISSION_WRITE_FAILED',
    'CHILD_FAILED',
    'CHILD_NO_CLOSE',
    'CHILD_TIMEOUT',
    'CHILD_OUTPUT_LIMIT',
    'CHILD_CANCELLED',
    'CHILD_SPAWN_FAILED',
    'CHILD_LOG_FAILED',
    'INVALID_REPORT',
    'CLEANUP_FAILED',
    'CANCELLED',
    'WINDOWS_HELPER_NO_CLOSE',
  ];
  if (
    value.schema !== 1 ||
    !['PASS', 'UNPROVEN'].includes(value.status) ||
    !reasons.includes(value.reason) ||
    value.platform !== plan.platform ||
    value.arch !== plan.arch ||
    value.image !== plan.image ||
    value.expectedHead !== plan.expectedHead ||
    value.expectedTree !== plan.expectedTree ||
    value.sourceManifestSHA256 !== plan.sourceManifestSHA256 ||
    value.nodeVersion !== plan.node.version ||
    value.nodeSHA256 !== plan.node.sha256 ||
    value.cliSHA256 !== plan.cliSHA256 ||
    value.lockSHA256 !== plan.lockSHA256 ||
    value.certSHA256 !==
      '597b4509e1ad0c12b69402bc0cff55bcb3f28603dea13a36623eb38891d109a3' ||
    value.runURL !==
      'https://github.com/' +
        plan.repository +
        '/actions/runs/' +
        plan.runId +
        '/attempts/' +
        plan.attempt ||
    value.jobId !== plan.jobId ||
    value.endpointLabel !== 'runner-owned-v4' ||
    (Object.hasOwn(value, 'cleanup') && value.cleanup !== 'UNPROVEN') ||
    (Object.hasOwn(value, 'outerReapRequired') &&
      value.outerReapRequired !== true) ||
    !Array.isArray(value.protocols)
  )
    fail('RUNNER_EVIDENCE_REJECTED');
  if (value.status === 'PASS') {
    if (
      value.reason !== 'CHECKPOINTS_COMPLETE' ||
      Object.hasOwn(value,'childFailure') ||
      value.protocols.length !== 2 ||
      value.cleanup ||
      value.outerReapRequired
    )
      fail('RUNNER_EVIDENCE_REJECTED');
    // Accepted runner already parses the actual Playwright report. Repeat its exact
    // telemetry shape/leaf allowlist here so the artifact boundary rejects extra strings.
    const shape = {
      version: 1,
      endpoint: {
        label: 'owned-v4',
        family: 4,
        observations: 'integer',
        port: 'integer',
        nonloopback: true,
        peerMatchesAdmission: true,
        localMatchesAdmission: true,
        owned: true,
        epochs: 'epochs',
      },
      tls: {
        encrypted: 'boolean',
        versions: 'versions',
        verifiedResponses: 'integer',
        peerLeafFingerprint256: 'fingerprint',
      },
      pages: {
        firstItems: 100,
        secondItems: 51,
        nativeFetchesForPaging: 1,
        replayNativeDelta: 0,
      },
      ownership: {
        retiredA: true,
        distinctAB: true,
        oldCursorStatus: 404,
        oldReceiptStatus: 409,
      },
      counts: {
        requests: 'integer',
        nativeReadPackets: 'integer',
        controlsAfterAccepted: 1,
        controlsAfterReplay: 1,
        controlsFinal: 2,
        cancelPackets: 1,
        holdsBeforeLoss: 2,
        holdsAfterLoss: 2,
        holdsAfterSettlement: 0,
      },
      cleanup: {
        serverListening: false,
        brokerDispatched: 0,
        brokerQueued: 0,
        openRequestClients: 0,
        openServerSockets: 0,
        held: 0,
        ownedStoreRemoval: 'completed',
      },
    };
    function check(v, s) {
      if (object(s)) {
        if (!keys(v, Object.keys(s))) fail('RUNNER_EVIDENCE_REJECTED');
        for (const key of Object.keys(s)) check(v[key], s[key]);
      } else if (s === 'integer') {
        if (!Number.isSafeInteger(v) || v < 0 || v > 65535)
          fail('RUNNER_EVIDENCE_REJECTED');
      } else if (s === 'boolean') {
        if (typeof v !== 'boolean') fail('RUNNER_EVIDENCE_REJECTED');
      } else if (s === 'epochs') {
        if (!Array.isArray(v) || v.length !== 4)
          fail('RUNNER_EVIDENCE_REJECTED');
        ['disabled', 'A', 'B', 'configured'].forEach((label, i) => {
          if (
            !keys(v[i], ['label', 'observations']) ||
            v[i].label !== label ||
            !Number.isInteger(v[i].observations) ||
            v[i].observations < 1 ||
            v[i].observations > 256
          )
            fail('RUNNER_EVIDENCE_REJECTED');
        });
      } else if (s === 'versions') {
        if (
          !Array.isArray(v) ||
          v.length > 2 ||
          new Set(v).size !== v.length ||
          v.some((x) => !['TLSv1.2', 'TLSv1.3'].includes(x))
        )
          fail('RUNNER_EVIDENCE_REJECTED');
      } else if (s === 'fingerprint') {
        if (
          v !== null &&
          v !==
            'fb6e906aa7015cfe4194ac90bd771a3b4f4d2eecef8ba4614b079a59138f35b1'
        )
          fail('RUNNER_EVIDENCE_REJECTED');
      } else if (v !== s) fail('RUNNER_EVIDENCE_REJECTED');
    }
    const checkpoints = [
      'actual_nonempty_socket_facts',
      'search100plus51_replay',
      'distinct_grants_default_disabled',
      'namespace_headers',
      'accepted_receipt_exact_replay',
      'terminal_owner_cursor_receipt',
      'two_client_logical_cancel_physical_hold',
      'bounded_cleanup',
    ];
    ['HTTP', 'TLS'].forEach((protocol, i) => {
      const p = value.protocols[i];
      if (
        !keys(p, ['protocol', 'checkpoints', 'outcome', 'telemetry']) ||
        p.protocol !== protocol ||
        p.outcome !== 'PASS' ||
        JSON.stringify(p.checkpoints) !== JSON.stringify(checkpoints)
      )
        fail('RUNNER_EVIDENCE_REJECTED');
      check(p.telemetry, shape);
      const { endpoint: e, tls: t, counts: c } = p.telemetry;
      if (
        e.observations < 1 ||
        e.observations > 256 ||
        e.port < 1 ||
        e.epochs.reduce((n, r) => n + r.observations, 0) !== e.observations ||
        c.requests !== e.observations ||
        c.nativeReadPackets < 5 ||
        c.nativeReadPackets > 128 ||
        c.nativeReadPackets > c.requests ||
        t.verifiedResponses > e.observations
      )
        fail('RUNNER_EVIDENCE_REJECTED');
      if (
        protocol === 'HTTP'
          ? t.encrypted ||
            t.versions.length ||
            t.verifiedResponses ||
            t.peerLeafFingerprint256 !== null
          : !t.encrypted ||
            !t.versions.length ||
            t.verifiedResponses < 1 ||
            t.peerLeafFingerprint256 === null
      )
        fail('RUNNER_EVIDENCE_REJECTED');
    });
  } else {
    if (!emptyProtocols(value.protocols)) fail('RUNNER_EVIDENCE_REJECTED');
    const innerFailure=innerFailureValue(value.reason,value.childFailure,Object.hasOwn(value,'childFailure'));
    if (innerFailure!==null) value.childFailure=innerFailure;
  }
  return JSON.parse(JSON.stringify(value));
}
module.exports = {
  CARRIER_PATHS,
  CARRIER_CHANGES,
  admit,
  bindSource,
  makePlan,
  runnerEnvironment,
  safeRunner,
  verifyPowerShellIdentity,
  runnerManifest,
  failureLedger,
  rememberFailure,
  safeInnerFailure,
  childFacts,
  probePhaseStream,
  safeChildFailure,
  formatResult,
};

if (typeof require !== 'undefined' && require.main === module)
  main().catch(() => {
    process.stderr.write('CARRIER_UNPROVEN\n');
    process.exitCode = 1;
  });
async function main() {
  const e = process.env,
    command = process.argv[2],
    mode = e.CARRIER_MODE;
  // Before any runtime builtin, file access, child, or directory creation.
  if (
    !head(SOURCE_HEAD) || !head(SOURCE_TREE) || !head(SOURCE_PARENT) ||
    process.argv.length !== 3 ||
    !['preflight', 'prepare', 'run', 'cleanup'].includes(command) ||
    mode !== 'qualify' ||
    e.GITHUB_ACTIONS !== 'true' ||
    e.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    !head(e.EXPECTED_CARRIER_SHA) ||
    !sha(e.EXPECTED_WORKFLOW_SHA256) ||
    !sha(e.EXPECTED_HELPER_SHA256) ||
    !sha(e.EXPECTED_POLICY_SHA256)
  )
    fail('HOST_UNPROVEN');
  const fs = require('node:fs'),
    fsp = fs.promises,
    path = require('node:path'),
    crypto = require('node:crypto'),
    cp = require('node:child_process');
  const cwd = path.resolve(__dirname, '..'),
    safe = path.join(cwd, 'api-music-nonloopback-safe');
  const digest = (b) => crypto.createHash('sha256').update(b).digest('hex');
  async function read(file, max = 16 * 1024 * 1024) {
    const handle = await fsp.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > max) fail('FILE_UNPROVEN');
      const bytes = await handle.readFile();
      if (bytes.length > max) fail('FILE_UNPROVEN');
      return bytes;
    } finally {
      await handle.close();
    }
  }
  const git = (...args) =>
    cp
      .execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      })
      .trim();
  const ledger = failureLedger(command),
    observed = {};
  let sourceBound = false,
    safeOwned = false,
    safeAttempted = false,
    resultAttempted = false,
    failureOuterReason = 'CARRIER_FAILED';
  async function emitFailure() {
    const value = errorArtifact(ledger, observed, failureOuterReason),
      bytes = formatResult(value);
    if (!safeOwned) {
      if (safeAttempted) fail('OWNERSHIP_UNPROVEN');
      safeAttempted = true;
      await fsp.mkdir(safe, { recursive: false, mode: 0o700 });
      safeOwned = true;
    }
    // A prior write attempt is not ownership proof for a failed/partial path.
    // Never retry or overwrite an existing result while reporting its failure.
    if (resultAttempted) fail('OWNERSHIP_UNPROVEN');
    resultAttempted = true;
    await fsp.writeFile(path.join(safe, 'result.json'), bytes, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  try {
    const policy = JSON.parse(
      await read(
        path.join(__dirname, 'api-music-nonloopback-admission.json'),
        16384,
      ),
    );
    const names = (text) => (text ? text.split(/\r?\n/) : []);
    const untracked = names(git('ls-files', '--others', '--exclude-standard'));
    const binding = {
      event: e.GITHUB_EVENT_NAME,
      repository: e.GITHUB_REPOSITORY,
      ref: e.GITHUB_REF,
      githubSHA: e.GITHUB_SHA,
      workflowRef: e.GITHUB_WORKFLOW_REF,
      workflowSHA: e.GITHUB_WORKFLOW_SHA,
      expectedCarrierSHA: e.EXPECTED_CARRIER_SHA,
      head: git('rev-parse', 'HEAD'),
      parents: git('show', '-s', '--format=%P', 'HEAD'),
      sourceTree: git('rev-parse', policy.sourceHead + '^{tree}'),
      sourceParent: git('show', '-s', '--format=%P', policy.sourceHead),
      workflowSHA256: digest(await read(path.join(cwd, CARRIER_PATHS[0]))),
      expectedWorkflowSHA256: e.EXPECTED_WORKFLOW_SHA256,
      helperSHA256: digest(await read(path.join(cwd, CARRIER_PATHS[2]))),
      expectedHelperSHA256: e.EXPECTED_HELPER_SHA256,
      policySHA256: digest(await read(path.join(cwd, CARRIER_PATHS[1]))),
      expectedPolicySHA256: e.EXPECTED_POLICY_SHA256,
      changes: names(
        git('diff', '--name-status', '--no-renames', policy.sourceHead, 'HEAD'),
      ),
      trackedDirty: git('status', '--porcelain', '--untracked-files=no') !== '',
      unexpectedFiles: untracked.filter(
        (p) =>
          ![
            'api-music-runtime-manifest.json',
            'api-music-nonloopback-safe/result.json',
          ].includes(p),
      ),
    };
    bindSource(policy, binding);
    sourceBound = true;
    Object.assign(observed, {
      sourceHead: policy.sourceHead,
      sourceTree: binding.sourceTree,
      carrierHead: binding.head,
      workflowSHA256: binding.workflowSHA256,
      helperSHA256: binding.helperSHA256,
      policySHA256: binding.policySHA256,
      platform: process.platform,
      arch: process.arch,
    });
    ledger.stage = 'TOOL_IMAGE';
    observed.imageOS = image(e.ImageOS) ? e.ImageOS : null;
    observed.imageVersion = image(e.ImageVersion) ? e.ImageVersion : null;
    if (!image(e.ImageOS) || !image(e.ImageVersion)) fail('HOST_UNPROVEN');
    const actual = {
      platform: process.platform,
      arch: process.arch,
      imageOS: e.ImageOS,
      imageVersion: e.ImageVersion,
      nodeVersion: process.version,
      nodeSHA256: null,
    };
    observed.nodeVersion = actual.nodeVersion;
    ledger.stage = 'NODE_PIN';
    actual.nodeSHA256 = digest(await read(process.execPath, 256 * 1024 * 1024));
    observed.nodeSHA256 = actual.nodeSHA256;
    ledger.stage = 'TOOL_IMAGE';
    const row = admit(policy, 'inspect', actual);
    if (
      row.imageVersion !== e.ImageVersion ||
      (row.imageOS !== null && row.imageOS !== e.ImageOS)
    )
      fail('ADMISSION_UNPROVEN');
    if (command === 'preflight') {
      if (policy.platforms.some((r) => !r.imageVersion || !r.nodeSHA256))
        fail('ADMISSION_UNPROVEN');
      process.stdout.write('SOURCE_BOUND\n');
      return;
    }
    ledger.stage = 'NODE_PIN';
    if (
      actual.nodeVersion !== policy.nodeVersion ||
      actual.nodeSHA256 !== row.nodeSHA256
    )
      fail('ADMISSION_UNPROVEN');
    if (process.platform === 'win32') {
      // Read only the fixed tool chain. No executable or path comes from input.
      ledger.stage = 'WINDOWS_RESOLVER';
      if (e.SystemRoot !== row.systemRoot) fail('POWERSHELL_UNPROVEN');
      const {
        resolveWindowsPowerShell,
      } = require('./api-music-windows-private-root.cjs');
      const tools = await resolveWindowsPowerShell({
        fsp,
        path,
        systemRoot: e.SystemRoot,
      });
      actual.systemRoot = tools.systemRoot;
      observed.systemRootMatches = tools.systemRoot === row.systemRoot;
      ledger.stage = 'WINDOWS_PROBE';
      ledger.probe = {};
      actual.powerShellFileVersion = verifyPowerShellIdentity(
        tools.powerShell,
        {
          spawnSync: cp.spawnSync,
          env: {
            SystemRoot: tools.systemRoot,
            PATH: path.dirname(process.execPath),
          },
          parent: e.RUNNER_TEMP,
        },
        ledger.probe,
      );
      actual.powerShellIdentity = 'MICROSOFT_AUTHENTICODE_VALID';
    }
    const { systemRoot, ...safeActual } = actual;
    ledger.stage = 'BINDING';
    const carrierTree = git('rev-parse', 'HEAD^{tree}');
    if (!head(carrierTree)) fail('SOURCE_UNPROVEN');
    observed.carrierTree = carrierTree;
    const provenance = {
      sourceHead: policy.sourceHead,
      sourceTree: policy.sourceTree,
      carrierHead: e.GITHUB_SHA,
      carrierTree,
      registeredWorkflowId: '376634247',
      diagnosticRef: 'diagnostic/api-nonloopback-qualified-f6',
      workflowSHA256: e.EXPECTED_WORKFLOW_SHA256,
      helperSHA256: e.EXPECTED_HELPER_SHA256,
      policySHA256: e.EXPECTED_POLICY_SHA256,
      ...safeActual,
      systemRootMatches:
        process.platform === 'win32' ? systemRoot === row.systemRoot : null,
    };
    if (mode !== 'qualify') fail('ADMISSION_UNPROVEN');
    ledger.stage = 'TOOL_IMAGE';
    admit(policy, mode, actual);
    const {
      createPrivateTempDirectory,
      removeOwnedTemp,
      validatePlan,
    } = require('./qualify-api-music-nonloopback.cjs');
    const remove = (directory) =>
      removeOwnedTemp(directory, {
        remove: (v) =>
          fsp.rm(v, {
            recursive: true,
            force: true,
            maxRetries: 2,
            retryDelay: 100,
          }),
        setTimeout,
        clearTimeout,
      });
    const marker = {
      schema: 1,
      carrier: e.GITHUB_SHA,
      run: e.GITHUB_RUN_ID,
      attempt: e.GITHUB_RUN_ATTEMPT,
    };
    if (command === 'prepare') {
      ledger.stage = 'PRIVATE_ROOT';
      const root = await createPrivateTempDirectory({
        fsp,
        path,
        runnerTemp: e.RUNNER_TEMP,
        platform: process.platform,
        setTimeout,
        clearTimeout,
        makeWindowsPrivateDirectory:
          process.platform === 'win32'
            ? (parent) =>
                require('./api-music-windows-private-root.cjs').createWindowsPrivateDirectory(
                  parent,
                  {
                    fsp,
                    path,
                    systemRoot: e.SystemRoot,
                    spawn: cp.spawn,
                    env: { PATH: path.dirname(process.execPath) },
                    setTimeout,
                    clearTimeout,
                    signalSource: process,
                    removeOwnedTemp,
                  },
                )
            : undefined,
      });
      ledger.stage = 'PRIVATE_FILES';
      await fsp.writeFile(
        path.join(root, 'owner.json'),
        JSON.stringify(marker),
        {
          flag: 'wx',
          mode: 0o600,
        },
      );
      await fsp.writeFile(path.join(root, 'empty-user.npmrc'), '', {
        flag: 'wx',
        mode: 0o600,
      });
      await fsp.writeFile(path.join(root, 'empty-global.npmrc'), '', {
        flag: 'wx',
        mode: 0o600,
      });
      ledger.stage = 'ENV_PUBLISH';
      await fsp.appendFile(
        e.GITHUB_ENV,
        'PEAR_MUSIC_CARRIER_PRIVATE_ROOT=' + root + '\n',
      );
      return;
    }
    ledger.stage = 'OWNERSHIP';
    const root = e.PEAR_MUSIC_CARRIER_PRIVATE_ROOT;
    if (
      typeof root !== 'string' ||
      path.dirname(root) !== path.resolve(e.RUNNER_TEMP) ||
      !path.basename(root).startsWith('pear-music-nonloopback-')
    )
      fail('OWNERSHIP_UNPROVEN');
    if (command === 'cleanup') {
      try {
        await fsp.lstat(root);
      } catch (error) {
        if (ownData(error, 'code').value === 'ENOENT') return;
        throw error;
      }
    }
    if (
      (await fsp.realpath(root)) !== root ||
      JSON.stringify(
        JSON.parse(await read(path.join(root, 'owner.json'), 1024)),
      ) !== JSON.stringify(marker)
    )
      fail('OWNERSHIP_UNPROVEN');
    if (command === 'cleanup') {
      // An interrupted/failed runner may retain descendants. Preserve its private
      // directory for disposable VM teardown, rather than deleting beneath it.
      if (fs.existsSync(path.join(root, 'reap-required'))) return;
      ledger.stage = 'REMOVAL';
      await remove(root);
      return;
    }
    if (command !== 'run') fail('HOST_UNPROVEN');
    ledger.stage = 'EMISSION';
    safeAttempted = true;
    await fsp.mkdir(safe, { recursive: false, mode: 0o700 });
    safeOwned = true;
    let result = {
      schema: 1,
      status: 'UNPROVEN',
      reason: 'CARRIER_FAILED',
      manifestScope: 'CARRIER_HEAD_TRACKED_FILES',
      provenance,
      processAbsence: 'UNPROVEN',
      outerReap: 'HOSTED_VM_AT_JOB_END',
    };
    let mayRemove = false;
    try {
      ledger.stage = 'TOOL_PINS';
      if (
        digest(await read(path.join(cwd, 'pnpm-lock.yaml'))) !==
          policy.lockSHA256 ||
        (ledger.tool.cliSHA256 = digest(
          await read(path.join(cwd, 'node_modules/@playwright/test/cli.js')),
        )) !== policy.cliSHA256
      )
        fail('DEPENDENCY_UNPROVEN');
      const installed = JSON.parse(
        await read(
          path.join(cwd, 'node_modules/@playwright/test/package.json'),
        ),
      );
      ledger.tool.cliVersion = installed.version;
      if (installed.version !== '1.61.1') fail('DEPENDENCY_UNPROVEN');
      ledger.stage = 'MANIFEST';
      const manifest = {};
      for (const file of names(git('ls-tree', '-r', '--name-only', 'HEAD'))) {
        if (
          !/^[A-Za-z0-9_.@/ -]+$/.test(file) ||
          file.split('/').some((p) => !p || p === '.' || p === '..')
        )
          fail('SOURCE_UNPROVEN');
        const target = path.join(cwd, file);
        if ((await fsp.realpath(target)) !== target) fail('SOURCE_UNPROVEN');
        manifest[file] = digest(await read(target));
      }
      // All current carrier HEAD files, including the fixed static SVG, are bound here. Only
      // that non-executable asset is omitted from the runner's stricter grammar.
      const completeBytes = Buffer.from(JSON.stringify(manifest));
      await fsp.writeFile(
        path.join(root, 'complete-carrier-manifest.json'),
        completeBytes,
        { flag: 'wx', mode: 0o600 },
      );
      const manifestBytes = Buffer.from(
        JSON.stringify(runnerManifest(manifest)),
      );
      await fsp.writeFile(
        path.join(cwd, 'api-music-runtime-manifest.json'),
        manifestBytes,
        { flag: 'wx', mode: 0o600 },
      );
      ledger.stage = 'PLAN';
      const plan = makePlan(
        policy,
        row,
        e,
        {
          path: process.execPath,
          version: process.version,
          sha256: actual.nodeSHA256,
        },
        digest(manifestBytes),
        e.QUALIFICATION_JOB_ID,
      );
      validatePlan(plan);
      const planFile = path.join(root, 'plan.json');
      await fsp.writeFile(planFile, JSON.stringify(plan), {
        flag: 'wx',
        mode: 0o600,
      });
      ledger.stage = 'CHILD';
      const stdout = fs.openSync(path.join(root, 'runner.stdout'), 'wx', 0o600),
        stderr = fs.openSync(path.join(root, 'runner.stderr'), 'wx', 0o600);
      let child;
      ledger.stage = 'CHILD';
      const childStarted = Date.now();
      try {
        child = cp.spawnSync(
          process.execPath,
          [
            path.join(__dirname, 'qualify-api-music-nonloopback.cjs'),
            '--execute-admitted-runner',
            planFile,
          ],
          {
            cwd,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', stdout, stderr],
            timeout: 215000,
            killSignal: 'SIGKILL',
            env: runnerEnvironment(
              e,
              path.dirname(process.execPath),
              root,
              path,
            ),
          },
        );
      } finally {
        fs.closeSync(stdout);
        fs.closeSync(stderr);
      }
      ledger.child = childFacts(child, Date.now() - childStarted);
      if (!ledger.child.normalClose || ledger.child.code !== 0) {
        if (ledger.child.normalClose) {
          try {
            const bytes = await read(path.join(root, 'runner.stdout'), 65536);
            ledger.child.stdoutBytes = bytes.length;
            ledger.inner = safeInnerFailure(bytes, plan);
          } catch {
            ledger.inner = {
              validated: false,
              reason: 'UNKNOWN',
              phase: 'UNKNOWN',
              cleanup: null,
              outerReapRequired: null,
            };
          }
        }
        fail('RUNNER_UNPROVEN');
      }
      ledger.stage = 'RESULT_PARSE';
      const runnerBytes = await read(path.join(root, 'runner.stdout'), 65536);
      ledger.child.stdoutBytes = runnerBytes.length;
      const qualified = safeRunner(
        JSON.parse(runnerBytes.toString('utf8')),
        plan,
      );
      if (qualified.status !== 'PASS') {
        try {
          ledger.inner = safeInnerFailure(runnerBytes, plan);
        } catch {
          ledger.inner = {
            validated: false,
            reason: 'UNKNOWN',
            phase: 'UNKNOWN',
            cleanup: null,
            outerReapRequired: null,
          };
        }
        fail('RUNNER_UNPROVEN');
      }
      ledger.stage = 'POST_PINS';
      // Source and key tool pins are checked again after the child, before PASS.
      if (
        git('status', '--porcelain', '--untracked-files=no') !== '' ||
        (observed.nodeSHA256 = digest(
          await read(process.execPath, 256 * 1024 * 1024),
        )) !== actual.nodeSHA256 ||
        (ledger.tool.cliSHA256 = digest(
          await read(path.join(cwd, 'node_modules/@playwright/test/cli.js')),
        )) !== policy.cliSHA256
      )
        fail('SOURCE_UNPROVEN');
      for (const [file, hash] of Object.entries(manifest))
        if (digest(await read(path.join(cwd, file))) !== hash)
          fail('SOURCE_UNPROVEN');
      if (
        names(git('ls-files', '--others', '--exclude-standard')).some(
          (file) =>
            ![
              'api-music-runtime-manifest.json',
              'api-music-nonloopback-safe/result.json',
            ].includes(file),
        )
      )
        fail('SOURCE_UNPROVEN');
      ledger.stage = 'REMOVAL';
      mayRemove = true;
      await remove(root);
      result = {
        ...result,
        status: 'PASS',
        reason: 'MEASURED_PROTOCOLS_AND_OWNED_DIRECTORY_CLEANUP',
        qualification: qualified,
        completeCarrierManifestSHA256: digest(completeBytes),
        runnerCarrierManifestSHA256: digest(manifestBytes),
        dependencyPolicy: {
          pnpmVersion: policy.pnpmVersion,
          lockSHA256: policy.lockSHA256,
          cliSHA256: policy.cliSHA256,
          installScripts: false,
          pnpmfile: false,
          browserDownload: false,
          electronDownload: false,
        },
      };
    } catch (error) {
      rememberFailure(ledger, error);
      if (!mayRemove)
        await fsp
          .writeFile(path.join(root, 'reap-required'), '1', {
            flag: 'wx',
            mode: 0o600,
          })
          .catch(() => {});
      failureOuterReason = mayRemove
        ? 'CARRIER_CLEANUP_UNPROVEN'
        : 'CARRIER_RUN_UNPROVEN';
      result = errorArtifact(ledger, observed, failureOuterReason);
      process.exitCode = 1;
    }
    ledger.stage = 'EMISSION';
    const resultBytes=formatResult(result);
    resultAttempted = true;
    await fsp.writeFile(
      path.join(safe, 'result.json'),
      resultBytes,
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    rememberFailure(ledger, error);
    process.exitCode = 1;
    if (failureOuterReason === 'CARRIER_FAILED' && command === 'run')
      failureOuterReason = 'CARRIER_RUN_UNPROVEN';
    if (command === 'cleanup' && ledger.primary.stage === 'REMOVAL')
      failureOuterReason = 'CARRIER_CLEANUP_UNPROVEN';
    if (sourceBound) {
      try {
        await emitFailure();
      } catch {
        /* No raw emission error may replace the primary failure. */
      }
    }
    throw error;
  }
}
