'use strict';
// C5 derivative: e4075b27c57f4b4b7d3858be9e5683bd48b23836; original SHA256
// 62c5a529780fbd87fbf901d93f347a422c72b41524ac4e9016ade56548299981.
// Inert import. Windows entry points are deliberately absent.
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
  const bytes=JSON.stringify(value);
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
    command: ['bind-source', 'prepare', 'install', 'qualify', 'cleanup'].includes(ledger.command)
      ? ledger.command
      : 'UNKNOWN',
    stage: FAILURE_STAGES.has(ledger.stage) ? ledger.stage : 'UNKNOWN',
    reason: errorReason(error),
    osCode: osCode(error),
    probe: null,
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
  out.registeredWorkflowId = numberId(observed.registeredWorkflowId) ? observed.registeredWorkflowId : null;
  out.diagnosticRef = typeof observed.diagnosticRef === 'string' && /^refs\/heads\/[A-Za-z0-9_./-]{1,150}$/.test(observed.diagnosticRef) ? observed.diagnosticRef : null;
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
    manifestScope: 'SEPARATE_QUALIFIED_SOURCE',
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

// New real POSIX adapters start here. All effects are injected below this boundary.
const POLICY = 'scripts/api-music-posix-policy.json';
const INVENTORY = 'scripts/api-music-posix-source.json';
const WORKFLOW = '.github/workflows/tests.yml';
const HELPER = 'scripts/api-music-posix-carrier.cjs';
const CERT = '597b4509e1ad0c12b69402bc0cff55bcb3f28603dea13a36623eb38891d109a3';
const LEAF = 'fb6e906aa7015cfe4194ac90bd771a3b4f4d2eecef8ba4614b079a59138f35b1';
const SOURCE_LIMIT = 16 * 1024 * 1024;
const DEPENDENCY_LIMITS = {entries: 250000, file: 512 * 1024 * 1024, total: 8 * 1024 ** 3, ms: 60000};
const number = (v) => Number.isSafeInteger(v) && v > 0;
const absolute = (v) => typeof v === 'string' && v.startsWith('/') && v.length <= 1024 && !/[\x00-\x1f]/.test(v);
const inside = (root, p) => p === root || p.startsWith(root + '/');
const bytewise = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const json = (b) => {
  const s = b.toString('utf8');
  if (!Buffer.from(s).equals(b)) fail('FILE_UNPROVEN');
  return JSON.parse(s);
};
// Public observations only. These never contribute to admission or safe-result cells.
function publicFacts(runtime, e) {
  const member = (value, allowed) => allowed.includes(value) ? value : null;
  return {tag:'PEAR_POSIX_BOOTSTRAP',platform:member(runtime.platform,['linux','darwin','win32']),arch:member(runtime.arch,['x64','arm64','ia32']),
    nodeVersion:typeof runtime.version==='string' && /^v\d{1,3}\.\d{1,4}\.\d{1,4}$/.test(runtime.version)?runtime.version:null,
    runnerOS:member(e.RUNNER_OS,['Linux','macOS','Windows']),runnerArch:member(e.RUNNER_ARCH,['X64','ARM64','X86']),
    imageOS:image(e.ImageOS)?e.ImageOS:null,imageVersion:image(e.ImageVersion)?e.ImageVersion:null};
}
function formatToolObservation(check, facts) {
  if (!['NODE_VERSION','NODE_CANONICAL','NODE_SHA256','PNPM_CANONICAL','PNPM_ENTRY_SHA256','PNPM_ENTRY_LAYOUT','PNPM_PACKAGE_VERSION','PNPM_TREE',
    'PLAYWRIGHT_CLI_CANONICAL','PLAYWRIGHT_CLI_SHA256','PLAYWRIGHT_PACKAGE_CANONICAL','PLAYWRIGHT_PACKAGE_VERSION'].includes(check)) return null;
  const out={tag:'PEAR_POSIX_TOOL',check,completed:facts.completed===true};
  if (out.completed) {
    out.matches=typeof facts.matches==='boolean'?facts.matches:null;
    if (['NODE_VERSION','PNPM_PACKAGE_VERSION','PLAYWRIGHT_PACKAGE_VERSION'].includes(check))
      out.version=typeof facts.version==='string' && /^v?\d{1,3}\.\d{1,4}\.\d{1,4}$/.test(facts.version)?facts.version:null;
    if (['NODE_SHA256','PNPM_ENTRY_SHA256','PNPM_TREE','PLAYWRIGHT_CLI_SHA256'].includes(check)) out.sha256=sha(facts.sha256)?facts.sha256:null;
    if (check==='PNPM_TREE') { out.entries=boundedNumber(facts.entries,30000);out.files=boundedNumber(facts.files,30000);out.bytes=boundedNumber(facts.bytes,256*1024*1024); }
  }
  return JSON.stringify(out)+'\n';
}
function observeTool(io, check, facts) {
  // A diagnostic sink failure cannot change the original pin result or exception.
  try { if (io.observeTool) io.observeTool(formatToolObservation(check,facts)); } catch {}
}
function formatInventoryObservation(event, probe, success) {
  const member=(value,allowed)=>allowed.includes(value)?value:'UNKNOWN';
  const count=(value,max)=>typeof value==='number' && !Number.isNaN(value)?Math.max(0,Math.min(max,Math.trunc(value))):null;
  return JSON.stringify({tag:'PEAR_POSIX_INVENTORY',event:member(event,['BEGIN','END']),success:typeof success==='boolean'?success:null,
    operation:member(probe.operation,['START','COMPLETE','CLOCK','CLOCK_IO','STAT_IO','REALPATH_IO','ROOT_MEMBERSHIP','CANONICAL_MATCH','READDIR_IO','DIRECTORY_NAMES',
      'ENTRY_LIMIT','NODE_KIND','FILE_SIZE','TOTAL_BYTES','READ_IO','READ_LENGTH','DIGEST_IO','WALL_TIMEOUT','TIMER_SETUP','TIMER_CLEAR']),
    root:member(probe.root,['DEPENDENCIES','STORE']),kind:member(probe.kind,['file','directory','symlink','other']),member:typeof probe.member==='boolean'?probe.member:null,
    entries:count(probe.entries,250001),files:count(probe.files,250000),bytes:count(probe.bytes,8589934592),largestFile:count(probe.largestFile,536870913),elapsedMs:count(probe.elapsedMs,60001)})+'\n';
}
function observeInventory(io, event, probe, success) {
  try { if (io.observeInventory) io.observeInventory(formatInventoryObservation(event,probe,success)); } catch {}
}
function guard(command, runtime) {
  if (!['bind-source', 'prepare', 'install', 'qualify', 'cleanup'].includes(command) ||
      !((runtime.platform === 'linux' && runtime.arch === 'x64') || (runtime.platform === 'darwin' && runtime.arch === 'arm64')))
    fail('HOST_UNPROVEN');
}
function staticPolicy(policy, runtime) {
  if (!keys(policy, ['schema', 'source', 'platforms']) || policy.schema !== 1 ||
      !keys(policy.source, ['head','tree','trackedCount','runnerCount','sourceInventorySHA256','lockSHA256','packageSHA256','certificateSHA256','leafFingerprint256','staticOmission'])) fail('ADMISSION_UNPROVEN');
  const s = policy.source;
  if (!head(s.head) || !head(s.tree) || !number(s.trackedCount) || s.trackedCount > 10000 ||
      s.runnerCount !== s.trackedCount - 1 || s.staticOmission !== STATIC_SVG || s.certificateSHA256 !== CERT || s.leafFingerprint256 !== LEAF ||
      !['sourceInventorySHA256','lockSHA256','packageSHA256'].every((k) => sha(s[k])) || !Array.isArray(policy.platforms) || policy.platforms.length !== 2) fail('ADMISSION_UNPROVEN');
  const triples = [['linux','x64','ubuntu-24.04'], ['darwin','arm64','macos-26']];
  policy.platforms.forEach((r, i) => {
    if (!keys(r, ['platform','arch','runnerLabelCandidate','imageOS','imageVersion','nodeSHA256','pnpmEntrySHA256','pnpmPackageClosureSHA256','cliSHA256','nodeVersion','nodeCanonicalPathExpected','pnpmVersion','pnpmCanonicalEntryPathExpected','playwrightVersion']) ||
        [r.platform,r.arch,r.runnerLabelCandidate].join('|') !== triples[i].join('|') || !image(r.imageOS) || !image(r.imageVersion) ||
        !['nodeSHA256','pnpmEntrySHA256','pnpmPackageClosureSHA256','cliSHA256'].every((k) => sha(r[k])) ||
        r.nodeVersion !== 'v24.22.0' || r.pnpmVersion !== '11.28.6' || r.playwrightVersion !== '1.61.1' ||
        !absolute(r.nodeCanonicalPathExpected) || !absolute(r.pnpmCanonicalEntryPathExpected)) fail('ADMISSION_UNPROVEN');
  });
  return policy.platforms.find((r) => r.platform === runtime.platform && r.arch === runtime.arch);
}
async function bind(command, io, e) {
  const p = io.path, cwd = io.runtime.cwd;
  if (!absolute(cwd) || await io.realpath(cwd) !== cwd || e.GITHUB_ACTIONS !== 'true' || e.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      e.GITHUB_EVENT_NAME !== 'workflow_dispatch' || e.GITHUB_REPOSITORY !== 'deruta74/pear-desktop' ||
      !head(e.EXPECTED_CARRIER_SHA) || !head(e.EXPECTED_CARRIER_TREE) || !numberId(e.EXPECTED_REGISTERED_WORKFLOW_ID) ||
      !numberId(e.GITHUB_RUN_ID) || !numberId(e.GITHUB_RUN_ATTEMPT) ||
      typeof e.EXPECTED_REF !== 'string' || !/^refs\/heads\/[A-Za-z0-9_./-]{1,150}$/.test(e.EXPECTED_REF) ||
      e.GITHUB_REF !== e.EXPECTED_REF || e.GITHUB_SHA !== e.EXPECTED_CARRIER_SHA || e.GITHUB_WORKFLOW_SHA !== e.EXPECTED_CARRIER_SHA ||
      e.GITHUB_WORKFLOW_REF !== e.GITHUB_REPOSITORY + '/' + WORKFLOW + '@' + e.EXPECTED_REF) fail('SOURCE_UNPROVEN');
  const policy = json(await io.read(p.join(cwd, POLICY), SOURCE_LIMIT)), row = staticPolicy(policy, io.runtime);
  for (const [file, key] of [[WORKFLOW,'EXPECTED_WORKFLOW_SHA256'], [HELPER,'EXPECTED_HELPER_SHA256'], [POLICY,'EXPECTED_POLICY_SHA256']])
    if (!sha(e[key]) || io.hash(await io.read(p.join(cwd, file), SOURCE_LIMIT)) !== e[key]) fail('SOURCE_UNPROVEN');
  if (await io.git(cwd, ['rev-parse','HEAD']) !== e.EXPECTED_CARRIER_SHA ||
      await io.git(cwd, ['rev-parse','HEAD^{tree}']) !== e.EXPECTED_CARRIER_TREE ||
      await io.git(cwd, ['status','--porcelain','--untracked-files=no']) !== '') fail('SOURCE_UNPROVEN');
  if (e.ImageOS !== row.imageOS || e.ImageVersion !== row.imageVersion) fail('ADMISSION_UNPROVEN');
  const sourceRoot = io.runtime.sourceRoot || p.join(cwd, 'qualified-source');
  if (e.PEAR_SOURCE_ROOT !== sourceRoot || !absolute(sourceRoot) || await io.realpath(sourceRoot) !== sourceRoot) fail('SOURCE_UNPROVEN');
  const ctx = {policy,row,cwd,sourceRoot,carrier:{head:e.EXPECTED_CARRIER_SHA,tree:e.EXPECTED_CARRIER_TREE}};
  if (command !== 'cleanup') ctx.source = await measureSource(ctx, io);
  return ctx;
}
async function measureSource(ctx, io) {
  const s = ctx.policy.source, bytes = await io.read(io.path.join(ctx.cwd, INVENTORY), 4 * 1024 * 1024);
  if (io.hash(bytes) !== s.sourceInventorySHA256) fail('SOURCE_UNPROVEN');
  const inventory = json(bytes);
  if (inventory.head !== s.head || inventory.tree !== s.tree || inventory.trackedCount !== s.trackedCount || !Array.isArray(inventory.entries) || inventory.entries.length !== s.trackedCount ||
      await io.git(ctx.sourceRoot, ['rev-parse','HEAD']) !== s.head || await io.git(ctx.sourceRoot, ['rev-parse','HEAD^{tree}']) !== s.tree ||
      await io.git(ctx.sourceRoot, ['status','--porcelain','--untracked-files=no']) !== '') fail('SOURCE_UNPROVEN');
  const raw = await io.git(ctx.sourceRoot, ['ls-tree','-r','-z','HEAD']);
  const observed = raw.split('\0').filter(Boolean).map((line) => {
    const m = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
    if (!m) fail('SOURCE_UNPROVEN');
    return {path:m[3], mode:m[1], type:'blob', blob:m[2]};
  }).sort((a,b) => bytewise(a.path,b.path));
  const expected = [...inventory.entries].sort((a,b) => bytewise(a.path,b.path));
  if (JSON.stringify(observed) !== JSON.stringify(expected) || observed.length !== s.trackedCount) fail('SOURCE_UNPROVEN');
  const complete = {}, seen = new Set();
  for (const r of observed) {
    if (!keys(r, ['path','mode','type','blob']) || seen.has(r.path) || !/^[A-Za-z0-9_.@/ -]+$/.test(r.path) || r.path.split('/').some((v) => !v || v === '.' || v === '..') ||
        (r.path !== STATIC_SVG && !/^[A-Za-z0-9_.@/-]+$/.test(r.path))) fail('SOURCE_UNPROVEN');
    seen.add(r.path);
    const file = io.path.join(ctx.sourceRoot, r.path), stat = await io.stat(file);
    if (await io.realpath(file) !== file || stat.kind !== 'file' || ((stat.mode & 0o111) !== 0) !== (r.mode === '100755')) fail('SOURCE_UNPROVEN');
    const actual = await io.read(file, SOURCE_LIMIT);
    if (io.blob(actual) !== r.blob) fail('SOURCE_UNPROVEN');
    complete[r.path] = io.hash(actual);
  }
  const runner = runnerManifest(complete);
  if (!seen.has(STATIC_SVG) || Object.keys(runner).length !== s.runnerCount ||
      complete['package.json'] !== s.packageSHA256 || complete['pnpm-lock.yaml'] !== s.lockSHA256 || complete['tests/fixtures/api-music-http-tls/cert.pem'] !== CERT) fail('SOURCE_UNPROVEN');
  // Entire exact source tree includes the shared service/store bundler and every patch.
  return {complete,runner,completeCount:s.trackedCount,runnerCount:s.runnerCount,
    completeSHA256:io.hash(Buffer.from(JSON.stringify(complete))),runnerSHA256:io.hash(Buffer.from(JSON.stringify(runner)))};
}
async function nodePins(ctx, io) {
  const r = ctx.row;
  let check='NODE_VERSION';
  try {
    observeTool(io,check,{completed:true,version:io.runtime.version,matches:io.runtime.version===r.nodeVersion});
    if (io.runtime.version!==r.nodeVersion) fail('ADMISSION_UNPROVEN');
    check='NODE_CANONICAL';const canonical=await io.realpath(io.runtime.execPath);
    observeTool(io,check,{completed:true,matches:canonical===r.nodeCanonicalPathExpected});
    if (canonical!==r.nodeCanonicalPathExpected) fail('ADMISSION_UNPROVEN');
    check='NODE_SHA256';const digest=io.hash(await io.read(r.nodeCanonicalPathExpected,256*1024*1024));
    observeTool(io,check,{completed:true,sha256:digest,matches:digest===r.nodeSHA256});
    if (digest!==r.nodeSHA256) fail('ADMISSION_UNPROVEN');
  } catch (error) { observeTool(io,check,{completed:false});throw error; }
}
async function measureTree(roots, limits, io) {
  // Only the installed dependencies/store inventory emits these two records.
  const probe=keys(roots,['dependencies','store'])?{operation:'START',root:'UNKNOWN',kind:'UNKNOWN',member:null,entries:0,files:0,bytes:0,largestFile:0,elapsedMs:0}:null;
  if (probe) observeInventory(io,'BEGIN',probe,null);
  let timer, boundary;
  try {
    let result;
    try { result=await Promise.race([scanTree(roots,limits,io,probe),new Promise((_,reject) => {
      try { timer=io.setTimeout(() => { boundary='WALL_TIMEOUT';reject(Error('DEPENDENCY_UNPROVEN')); },limits.ms); }
      catch (error) { boundary='TIMER_SETUP';throw error; }
    })]); }
    finally { try { io.clearTimeout(timer); } catch (error) { boundary='TIMER_CLEAR';throw error; } }
    if (probe) { probe.operation='COMPLETE';observeInventory(io,'END',probe,true); }
    return result;
  } catch (error) {
    if (probe) { if (boundary) probe.operation=boundary;observeInventory(io,'END',probe,false); }
    throw error;
  }
}
async function scanTree(roots, limits, io, probe) {
  if (probe) probe.operation='CLOCK_IO';
  const records = [], seen = new Map(), start = io.now(); let entries = 0, files = 0, bytes = 0;
  const rootRows = Object.entries(roots).sort(([a],[b]) => bytewise(a,b));
  const locate = (file) => { const row = rootRows.find(([,root]) => inside(root,file)); if (probe) probe.member=!!row; if (!row) { if (probe) probe.operation='ROOT_MEMBERSHIP';fail('DEPENDENCY_UNPROVEN'); } return row[0] + (file === row[1] ? '' : '/' + io.path.relative(row[1], file)); };
  const pending = rootRows.map(([label, root]) => [root,label,true]);
  while (pending.length) {
    if (probe) probe.operation='CLOCK_IO';
    const elapsed=io.now()-start;if (probe) probe.elapsedMs=elapsed;
    if (elapsed > limits.ms) { if (probe) probe.operation='CLOCK';fail('DEPENDENCY_UNPROVEN'); }
    const [file,label,isRoot] = pending.pop();
    if (probe) { probe.root=label==='store'||label.startsWith('store/')?'STORE':'DEPENDENCIES';probe.kind='UNKNOWN';probe.member=null;probe.operation='STAT_IO'; }
    const stat = await io.stat(file);
    if (probe) probe.kind=stat.kind;
    if (!isRoot) { ++entries;if (probe) probe.entries=entries;if (entries > limits.entries) { if (probe) probe.operation='ENTRY_LIMIT';fail('DEPENDENCY_UNPROVEN'); } }
    if (probe) probe.operation='REALPATH_IO';
    const canonical = await io.realpath(file); locate(canonical);
    if (stat.kind === 'symlink') { records.push([label,'symlink',locate(canonical)]); continue; }
    if (canonical !== file) { if (probe) probe.operation='CANONICAL_MATCH';fail('DEPENDENCY_UNPROVEN'); }
    if (stat.kind === 'directory') {
      if (probe) probe.operation='READDIR_IO';
      const names = await io.readdir(file);
      if (!Array.isArray(names) || names.length > limits.entries || names.some((n) => typeof n !== 'string' || !n || /[\/\x00-\x1f]/.test(n) || n === '.' || n === '..')) { if (probe) probe.operation='DIRECTORY_NAMES';fail('DEPENDENCY_UNPROVEN'); }
      for (const name of names.sort(bytewise).reverse()) pending.push([io.path.join(file,name),label + '/' + name,false]);
    } else if (stat.kind === 'file') {
      if (probe && typeof stat.size==='number' && !Number.isNaN(stat.size)) probe.largestFile=Math.max(probe.largestFile,stat.size);
      if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > limits.file) { if (probe) probe.operation='FILE_SIZE';fail('DEPENDENCY_UNPROVEN'); }
      if (seen.has(canonical)) { records.push([label,'reference',seen.get(canonical)]); continue; }
      if (bytes + stat.size > limits.total) { if (probe) probe.operation='TOTAL_BYTES';fail('DEPENDENCY_UNPROVEN'); }
      if (probe) probe.operation='READ_IO';
      const data = await io.read(file, limits.file);
      if (data.length !== stat.size) { if (probe) probe.operation='READ_LENGTH';fail('DEPENDENCY_UNPROVEN'); }
      bytes += data.length; files++;if (probe) { probe.bytes=bytes;probe.files=files;probe.operation='DIGEST_IO'; } seen.set(canonical,label); records.push([label,'file',io.hash(data)]);
    } else { if (probe) probe.operation='NODE_KIND';fail('DEPENDENCY_UNPROVEN'); }
  }
  if (probe) probe.operation='CLOCK_IO';
  const elapsed=io.now()-start;if (probe) probe.elapsedMs=elapsed;
  if (elapsed > limits.ms) { if (probe) probe.operation='CLOCK';fail('DEPENDENCY_UNPROVEN'); }
  records.sort((a,b) => bytewise(a[0],b[0]));
  if (probe) probe.operation='DIGEST_IO';
  return {sha256:io.hash(Buffer.from(JSON.stringify(records))),entries,files,bytes};
}
async function toolPins(ctx, io, installed = false, root) {
  await nodePins(ctx,io);
  const r = ctx.row, entry = r.pnpmCanonicalEntryPathExpected;
  let check='PNPM_CANONICAL';
  try {
  const canonical=await io.realpath(entry);observeTool(io,check,{completed:true,matches:canonical===entry});
  if (canonical!==entry) fail('DEPENDENCY_UNPROVEN');
  check='PNPM_ENTRY_SHA256';const entrySHA256=io.hash(await io.read(entry,SOURCE_LIMIT));
  observeTool(io,check,{completed:true,sha256:entrySHA256,matches:entrySHA256===r.pnpmEntrySHA256});
  if (entrySHA256!==r.pnpmEntrySHA256) fail('DEPENDENCY_UNPROVEN');
  const pnpmRoot = io.path.dirname(io.path.dirname(entry));
  check='PNPM_ENTRY_LAYOUT';const layout=entry.endsWith('/bin/pnpm.cjs');observeTool(io,check,{completed:true,matches:layout});
  if (!layout) fail('DEPENDENCY_UNPROVEN');
  check='PNPM_PACKAGE_VERSION';const version=json(await io.read(io.path.join(pnpmRoot,'package.json'),SOURCE_LIMIT)).version;
  observeTool(io,check,{completed:true,version,matches:version===r.pnpmVersion});
  if (version!==r.pnpmVersion) fail('DEPENDENCY_UNPROVEN');
  check='PNPM_TREE';const tree=await measureTree({pnpm:pnpmRoot},{entries:30000,file:64*1024*1024,total:256*1024*1024,ms:60000},io);
  observeTool(io,check,{completed:true,...tree,matches:tree.sha256===r.pnpmPackageClosureSHA256});
  if (tree.sha256!==r.pnpmPackageClosureSHA256) fail('DEPENDENCY_UNPROVEN');
  if (installed) {
    for (const [relative,want] of [['node_modules/@playwright/test/cli.js',r.cliSHA256], ['node_modules/@playwright/test/package.json',null]]) {
      check=want?'PLAYWRIGHT_CLI_CANONICAL':'PLAYWRIGHT_PACKAGE_CANONICAL';
      const canonical = await io.realpath(io.path.join(ctx.sourceRoot,relative));
      const member=[io.path.join(ctx.sourceRoot,'node_modules'),io.path.join(root,'store')].some((p) => inside(p,canonical));
      observeTool(io,check,{completed:true,matches:member});if (!member) fail('DEPENDENCY_UNPROVEN');
      check=want?'PLAYWRIGHT_CLI_SHA256':'PLAYWRIGHT_PACKAGE_VERSION';
      const data = await io.read(canonical,SOURCE_LIMIT);
      if (want) { const digest=io.hash(data);observeTool(io,check,{completed:true,sha256:digest,matches:digest===want});if (digest!==want) fail('DEPENDENCY_UNPROVEN'); }
      else { const version=json(data).version;observeTool(io,check,{completed:true,version,matches:version===r.playwrightVersion});if (version!==r.playwrightVersion) fail('DEPENDENCY_UNPROVEN'); }
    }
  }
  } catch (error) { observeTool(io,check,{completed:false});throw error; }
}
function childEnvironment(e, node, root, p) {
  const out = {CI:'1',PATH:p.dirname(node),HOME:p.join(root,'home'),TMPDIR:p.join(root,'tmp'),TMP:p.join(root,'tmp'),TEMP:p.join(root,'tmp'),
    npm_config_userconfig:p.join(root,'empty-user.npmrc'),npm_config_globalconfig:p.join(root,'empty-global.npmrc'),
    npm_config_ignore_scripts:'true',npm_config_registry:'https://registry.npmjs.org',ELECTRON_SKIP_BINARY_DOWNLOAD:'1',PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1'};
  for (const k of ['GITHUB_ACTIONS','RUNNER_ENVIRONMENT','GITHUB_REPOSITORY','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','ImageVersion']) out[k] = e[k];
  out.RUNNER_TEMP = p.join(root,'tmp');
  return out;
}
// This supervisor owns only the returned direct child. A close never proves descendants absent.
function runOwned(spec, kind, io) {
  const wall = kind === 'installer' ? 180000 : 210000, cap = kind === 'installer' ? 2 * 1024 * 1024 : 65536;
  return new Promise((resolve) => {
    let child, done = false, reason = null, bytes = 0; const stdout = [], stderr = [], timers = new Set(), handlers = new Map();
    const later = (fn, ms) => { const id = io.setTimeout(() => { timers.delete(id); fn(); },ms); timers.add(id); };
    const finish = (closed, code = null, signal = null) => {
      if (done) return; done = true;
      for (const id of timers) io.clearTimeout(id);
      for (const [s,fn] of handlers) io.signalSource.removeListener(s,fn);
      if (!closed) { child?.stdout?.destroy?.(); child?.stderr?.destroy?.(); child?.unref?.(); }
      resolve({closed,code,signal,reason,normal:closed && code === 0 && signal === null && reason === null,bytes,
        stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr)});
    };
    const terminate = (why) => {
      if (done || reason) return; reason = why;
      for (const id of timers) io.clearTimeout(id); timers.clear();
      try { child?.kill('SIGTERM'); } catch {}
      later(() => { try { child?.kill('SIGKILL'); } catch {} later(() => finish(false),2000); },3000);
    };
    const consume = (target, chunk) => {
      if (done || reason) return; const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes = Math.min(cap + 1, bytes + data.length);
      if (bytes > cap) { terminate('OUTPUT_LIMIT'); return; } target.push(data);
    };
    try {
      child = io.spawn(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,shell:false,stdio:['ignore','pipe','pipe']});
      child.stdout.on('data',(v) => consume(stdout,v)); child.stderr.on('data',(v) => consume(stderr,v));
      child.stdout.on('error',() => terminate('LOG_FAILED')); child.stderr.on('error',() => terminate('LOG_FAILED'));
      child.once('error',() => terminate('SPAWN_FAILED')); child.once('close',(code,signal) => finish(true,code,signal));
      for (const s of ['SIGINT','SIGTERM']) { const fn = () => terminate('CANCELLED'); handlers.set(s,fn); io.signalSource.on(s,fn); }
      later(() => terminate('TIMEOUT'),wall);
    } catch { reason = 'SPAWN_FAILED'; finish(true); }
  });
}
function marker(ctx,e) { return {schema:1,carrier:e.EXPECTED_CARRIER_SHA,tree:e.EXPECTED_CARRIER_TREE,run:e.GITHUB_RUN_ID,attempt:e.GITHUB_RUN_ATTEMPT,platform:ctx.row.platform}; }
async function ownedRoot(ctx,io,e) {
  const root = e.PEAR_POSIX_PRIVATE_ROOT, p = io.path;
  if (!absolute(root) || !absolute(e.RUNNER_TEMP) || p.dirname(root) !== e.RUNNER_TEMP || !p.basename(root).startsWith('pear-api-posix-') || await io.realpath(root) !== root) fail('OWNERSHIP_UNPROVEN');
  const st = await io.stat(root);
  if (st.kind !== 'directory' || (st.mode & 0o777) !== 0o700 || st.uid !== io.runtime.uid || JSON.stringify(json(await io.read(p.join(root,'owner.json'),2048))) !== JSON.stringify(marker(ctx,e))) fail('OWNERSHIP_UNPROVEN');
  return root;
}
async function allocatedIdentity(ctx,io,e) {
  const base = '/repos/deruta74/pear-desktop/actions/runs/' + e.GITHUB_RUN_ID;
  const run = await io.api(base), jobs = await io.api(base + '/attempts/' + e.GITHUB_RUN_ATTEMPT + '/jobs?per_page=100');
  if (String(run.id) !== e.GITHUB_RUN_ID || String(run.run_attempt) !== e.GITHUB_RUN_ATTEMPT || String(run.workflow_id) !== e.EXPECTED_REGISTERED_WORKFLOW_ID ||
      run.head_sha !== e.EXPECTED_CARRIER_SHA || run.repository?.full_name !== e.GITHUB_REPOSITORY ||
      !Number.isSafeInteger(jobs.total_count) || jobs.total_count < 1 || jobs.total_count > 100 || !Array.isArray(jobs.jobs) || jobs.jobs.length !== jobs.total_count) fail('ADMISSION_UNPROVEN');
  const rows = jobs.jobs.filter((j) => j.name === 'current-posix-api-' + ctx.row.platform && j.status === 'in_progress' && j.head_sha === e.EXPECTED_CARRIER_SHA);
  if (rows.length !== 1 || !number(rows[0].id) || String(rows[0].run_id) !== e.GITHUB_RUN_ID || String(rows[0].run_attempt) !== e.GITHUB_RUN_ATTEMPT) fail('ADMISSION_UNPROVEN');
  return String(rows[0].id);
}
function safeSource(source) { return {completeSHA256:source.completeSHA256,runnerSHA256:source.runnerSHA256,completeCount:source.completeCount,runnerCount:source.runnerCount}; }
function safeTransport(c) { return {closed:c.closed === true,normal:c.normal === true,code:boundedNumber(c.code,255),signal:c.signal === null ? null : SIGNALS.has(c.signal) ? c.signal : 'UNKNOWN',
  reason:c.reason === null ? null : ['TIMEOUT','OUTPUT_LIMIT','CANCELLED','SPAWN_FAILED','LOG_FAILED'].includes(c.reason) ? c.reason : 'UNKNOWN',bytes:boundedNumber(c.bytes,2*1024*1024+1)}; }
function safeFailure(value) {
  if (!value) return null;
  const l=failureLedger(value.command); l.stage=value.stage; l.child=value.child;
  l.inner=value.inner ? {...value.inner,innerFailure:value.innerFailure} : null; l.tool=value.tool || {};
  return rememberFailure(l,{message:value.reason,code:value.osCode});
}
function innerCleanup(state) {
  const inner = state.inner;
  if (!state.qualifierStarted) return {innerAttempt:'NOT_RUN',innerEffects:'NOT_RUN'};
  if (!inner) return {innerAttempt:'UNKNOWN',innerEffects:'UNKNOWN'};
  if (['INVALID_PLAN','PIN_MISMATCH','TOPOLOGY_UNAVAILABLE'].includes(inner.reason)) return {innerAttempt:'NOT_REACHED',innerEffects:'NOT_RUN'};
  if (inner.status === 'PASS' || inner.reason === 'INVALID_REPORT') return {innerAttempt:'ATTEMPTED',innerEffects:'REPORTED_COMPLETED'};
  if (CHILD_ORIGINS.has(inner.reason) || inner.reason === 'CLEANUP_FAILED' || inner.reason === 'ADMISSION_WRITE_FAILED') return {innerAttempt:'ATTEMPTED',innerEffects:'UNKNOWN'};
  return {innerAttempt:'UNKNOWN',innerEffects:'UNKNOWN'};
}
async function removeBounded(root,io) {
  let timer, timedOut=false;
  try { await Promise.race([io.rm(root),new Promise((_,reject) => { timer=io.setTimeout(() => {timedOut=true;reject(Error('CLEANUP_FAILED'));},5000); })]); return 'COMPLETED'; }
  catch { return timedOut?'UNKNOWN_AFTER_TIMEOUT':'UNPROVEN'; }
  finally { io.clearTimeout(timer); }
}
function finalResult(ctx,state,e,cleanup) {
  const expectedPlan={schema:1,disposableRunner:true,platform:ctx.row.platform,arch:ctx.row.arch,image:ctx.row.imageVersion,repository:e.GITHUB_REPOSITORY,
    runId:e.GITHUB_RUN_ID,attempt:e.GITHUB_RUN_ATTEMPT,jobId:state.jobId,expectedHead:ctx.policy.source.head,expectedTree:ctx.policy.source.tree,
    sourceManifestSHA256:state.source.runnerSHA256,node:{path:ctx.row.nodeCanonicalPathExpected,version:ctx.row.nodeVersion,sha256:ctx.row.nodeSHA256},cliSHA256:ctx.row.cliSHA256,lockSHA256:ctx.policy.source.lockSHA256};
  const qualification = state.inner && state.plan ? safeRunner(state.inner,expectedPlan) : null;
  const pass = !state.failed && !state.active && numberId(state.jobId) && state.phase === 'qualified' && state.postchecked === true && state.installer?.normal === true && state.outer?.normal === true &&
    qualification?.status === 'PASS' && state.toolsVerified===true && cleanup.furtherOuterDeletion === 'COMPLETED';
  const result = {schema:1,status:pass?'PASS':'UNPROVEN',reason:pass?'MEASURED_PROTOCOLS_AND_OWNED_DIRECTORY_CLEANUP':'CARRIER_RUN_UNPROVEN',adoptableCells:pass?2:0,
    source:{head:ctx.policy.source.head,tree:ctx.policy.source.tree,...safeSource(state.source)},
    carrier:{head:e.EXPECTED_CARRIER_SHA,tree:e.EXPECTED_CARRIER_TREE,workflowSHA256:e.EXPECTED_WORKFLOW_SHA256,helperSHA256:e.EXPECTED_HELPER_SHA256,policySHA256:e.EXPECTED_POLICY_SHA256},
    tools:{platform:ctx.row.platform,arch:ctx.row.arch,imageOS:ctx.row.imageOS,imageVersion:ctx.row.imageVersion,nodeVersion:ctx.row.nodeVersion,nodeSHA256:ctx.row.nodeSHA256,
      pnpmVersion:ctx.row.pnpmVersion,pnpmEntrySHA256:ctx.row.pnpmEntrySHA256,pnpmPackageClosureSHA256:ctx.row.pnpmPackageClosureSHA256,cliSHA256:ctx.row.cliSHA256,canonicalPathsVerified:state.toolsVerified===true},
    runtime:{repository:e.GITHUB_REPOSITORY,ref:e.EXPECTED_REF,workflowId:e.EXPECTED_REGISTERED_WORKFLOW_ID,runId:e.GITHUB_RUN_ID,attempt:e.GITHUB_RUN_ATTEMPT,jobId:numberId(state.jobId)?state.jobId:null},
    inventory:state.inventory && sha(state.inventory.sha256) ? {sha256:state.inventory.sha256,entries:boundedNumber(state.inventory.entries,250000),files:boundedNumber(state.inventory.files,250000),bytes:boundedNumber(state.inventory.bytes,8*1024**3)} : null,
    installer:state.installer?safeTransport(state.installer):null,outer:state.outer?safeTransport(state.outer):null,
    qualification,diagnostics:safeFailure(state.failure),cleanup,processAbsence:'UNPROVEN',outerReap:'DECLARED_HOSTED_VM_AT_JOB_END'};
  formatResult(result); return result;
}
async function handle(command,io,e) {
  guard(command,io.runtime); // Before any injected effect, also enforced before real imports by main.
  const ctx = await bind(command,io,e), p = io.path;
  if (command === 'bind-source') return;
  if (command === 'prepare') {
    await nodePins(ctx,io);
    if (e.PEAR_POSIX_PRIVATE_ROOT || !absolute(e.RUNNER_TEMP) || await io.realpath(e.RUNNER_TEMP) !== e.RUNNER_TEMP) fail('OWNERSHIP_UNPROVEN');
    const root = await io.mkdtemp(p.join(e.RUNNER_TEMP,'pear-api-posix-'));
    if (p.dirname(root) !== e.RUNNER_TEMP || !p.basename(root).startsWith('pear-api-posix-') || await io.realpath(root) !== root) fail('OWNERSHIP_UNPROVEN');
    await io.chmod(root,0o700);
    for (const name of ['home','tmp','store','logs']) await io.mkdir(p.join(root,name),{mode:0o700});
    for (const name of ['empty-user.npmrc','empty-global.npmrc']) await io.write(p.join(root,name),'',{flag:'wx',mode:0o600});
    await io.write(p.join(root,'owner.json'),JSON.stringify(marker(ctx,e)),{flag:'wx',mode:0o600});
    await io.write(p.join(root,'complete-source-manifest.json'),JSON.stringify(ctx.source.complete),{flag:'wx',mode:0o600});
    await io.write(p.join(root,'state.json'),JSON.stringify({schema:1,phase:'prepared',source:safeSource(ctx.source),active:null,failed:false,postchecked:false}),{flag:'wx',mode:0o600});
    await io.append(e.GITHUB_ENV,'PEAR_POSIX_PRIVATE_ROOT=' + root + '\n'); return;
  }
  const root = await ownedRoot(ctx,io,e), statePath = p.join(root,'state.json');
  const stateFile = await io.openState(statePath);
  try {
  const state = json(await stateFile.read());
  if (state.schema !== 1 || !state.source || !sha(state.source.completeSHA256) || !sha(state.source.runnerSHA256) ||
      state.source.completeCount !== ctx.policy.source.trackedCount || state.source.runnerCount !== ctx.policy.source.runnerCount) fail('OWNERSHIP_UNPROVEN');
  const save = () => stateFile.write(JSON.stringify(state));
  if (command === 'cleanup') {
    const cleanup = {...innerCleanup(state),furtherOuterDeletion:'WITHHELD'};
    if (!state.active && !state.hold) cleanup.furtherOuterDeletion = await removeBounded(root,io);
    const result = finalResult(ctx,state,e,cleanup), safe = p.join(ctx.cwd,'api-music-posix-safe');
    await io.mkdir(safe,{mode:0o700});
    if (await io.realpath(safe) !== safe) fail('OWNERSHIP_UNPROVEN');
    await io.write(p.join(safe,'result.json'),formatResult(result),{flag:'wx',mode:0o600}); return;
  }
  const ledger = failureLedger(command);
  try {
    if (state.failed || state.active || (command === 'install' ? state.phase !== 'prepared' : state.phase !== 'installed')) fail('OWNERSHIP_UNPROVEN');
    ledger.stage='TOOL_PINS'; await toolPins(ctx,io,command==='qualify',root); state.toolsVerified=true;
    if (ctx.source.completeSHA256 !== state.source.completeSHA256 || ctx.source.runnerSHA256 !== state.source.runnerSHA256) fail('SOURCE_UNPROVEN');
    if (command === 'install') {
      state.active='installer'; await save(); ledger.stage='CHILD';
      const child=await runOwned({command:ctx.row.nodeCanonicalPathExpected,args:[ctx.row.pnpmCanonicalEntryPathExpected,'install','--frozen-lockfile','--ignore-scripts','--ignore-pnpmfile','--config.manage-package-manager-versions=false','--store-dir',p.join(root,'store')],
        cwd:ctx.sourceRoot,env:childEnvironment(e,ctx.row.nodeCanonicalPathExpected,root,p)},'installer',io);
      state.installer=safeTransport(child); state.active=null; state.hold=!child.normal;
      await io.write(p.join(root,'logs/install.stdout'),child.stdout,{flag:'wx',mode:0o600}); await io.write(p.join(root,'logs/install.stderr'),child.stderr,{flag:'wx',mode:0o600});
      if (!child.normal) fail('DEPENDENCY_UNPROVEN');
      ledger.stage='TOOL_PINS'; await toolPins(ctx,io,true,root);
      state.inventory=await measureTree({dependencies:p.join(ctx.sourceRoot,'node_modules'),store:p.join(root,'store')},DEPENDENCY_LIMITS,io);
      const after=await measureSource(ctx,io); if (after.completeSHA256!==state.source.completeSHA256) fail('SOURCE_UNPROVEN');
      state.phase='installed'; await save(); return;
    }
    ledger.stage='PLAN'; state.jobId=await allocatedIdentity(ctx,io,e);
    const runtimeEnvelope={schema:1,allocatedRunId:e.GITHUB_RUN_ID,allocatedAttempt:e.GITHUB_RUN_ATTEMPT,apiUniqueJobId:state.jobId,apiWorkflowId:e.EXPECTED_REGISTERED_WORKFLOW_ID,
      apiJobName:'current-posix-api-'+ctx.row.platform,apiJobHeadSHA:ctx.carrier.head,measuredCarrierHead:ctx.carrier.head,measuredCarrierTree:ctx.carrier.tree,
      measuredSourceHead:ctx.policy.source.head,measuredSourceTree:ctx.policy.source.tree,actualPlatform:io.runtime.platform,actualArch:io.runtime.arch,
      actualImageOS:e.ImageOS,actualImageVersion:e.ImageVersion,actualNodeCanonicalPath:ctx.row.nodeCanonicalPathExpected,actualPnpmCanonicalEntryPath:ctx.row.pnpmCanonicalEntryPathExpected,
      completeSourceManifestSHA256:ctx.source.completeSHA256,runnerManifestSHA256:ctx.source.runnerSHA256,measuredInstalledDependencyInventorySHA256:state.inventory.sha256};
    await io.write(p.join(root,'runtime-envelope.json'),JSON.stringify(runtimeEnvelope),{flag:'wx',mode:0o600});
    const plan={schema:1,disposableRunner:true,platform:ctx.row.platform,arch:ctx.row.arch,image:ctx.row.imageVersion,repository:e.GITHUB_REPOSITORY,
      runId:e.GITHUB_RUN_ID,attempt:e.GITHUB_RUN_ATTEMPT,jobId:state.jobId,expectedHead:ctx.policy.source.head,expectedTree:ctx.policy.source.tree,
      sourceManifestSHA256:ctx.source.runnerSHA256,node:{path:ctx.row.nodeCanonicalPathExpected,version:ctx.row.nodeVersion,sha256:ctx.row.nodeSHA256},cliSHA256:ctx.row.cliSHA256,lockSHA256:ctx.policy.source.lockSHA256};
    io.qualifier.validatePlan(plan); state.plan=plan;
    await io.write(p.join(ctx.sourceRoot,'api-music-runtime-manifest.json'),JSON.stringify(ctx.source.runner),{flag:'wx',mode:0o600});
    await io.write(p.join(root,'plan.json'),JSON.stringify(plan),{flag:'wx',mode:0o600});
    state.qualifierStarted=true; state.active='qualifier'; await save(); ledger.stage='CHILD';
    const child=await runOwned({command:ctx.row.nodeCanonicalPathExpected,args:[p.join(ctx.sourceRoot,'scripts/qualify-api-music-nonloopback.cjs'),'--execute-admitted-runner',p.join(root,'plan.json')],
      cwd:ctx.sourceRoot,env:childEnvironment(e,ctx.row.nodeCanonicalPathExpected,root,p)},'qualifier',io);
    state.outer=safeTransport(child); state.active=null; state.hold=!child.normal;
    await io.write(p.join(root,'logs/qualifier.stdout'),child.stdout,{flag:'wx',mode:0o600}); await io.write(p.join(root,'logs/qualifier.stderr'),child.stderr,{flag:'wx',mode:0o600});
    try { state.inner=safeRunner(json(child.stdout),plan); } catch { state.hold=true; }
    if (!child.normal) fail('RUNNER_UNPROVEN');
    ledger.stage='RESULT_PARSE'; if (!state.inner || state.inner.status!=='PASS') { state.hold=true; fail('RUNNER_EVIDENCE_REJECTED'); }
    ledger.stage='POST_PINS'; await toolPins(ctx,io,true,root);
    if ((await measureSource(ctx,io)).completeSHA256!==state.source.completeSHA256) fail('SOURCE_UNPROVEN');
    state.postchecked=true; state.phase='qualified'; await save();
  } catch (error) {
    state.failed=true; rememberFailure(ledger,error); state.failure=ledger.primary; await save();
    // Fixed code only; no raw path/token/error reaches CLI or result.
    fail(errorReason(error));
  }
  } finally { await stateFile.close(); }
}

// Real adapter construction is unreachable from import or the pure entry.
function realIO(e) {
  const fs=require('node:fs'), fsp=fs.promises, path=require('node:path'), crypto=require('node:crypto'), cp=require('node:child_process'), https=require('node:https');
  const cwd=path.resolve(__dirname,'..');
  const read=async (file,max=SOURCE_LIMIT) => {
    if (await fsp.realpath(file)!==file) fail('FILE_UNPROVEN');
    const h=await fsp.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try { const s=await h.stat(), l=await fsp.lstat(file); if (!s.isFile()||s.size>max||s.dev!==l.dev||s.ino!==l.ino) fail('FILE_UNPROVEN'); const b=await h.readFile(); if (b.length>max||b.length!==s.size) fail('FILE_UNPROVEN'); return b; }
    finally { await h.close(); }
  };
  const openState=async (file) => {
    let h;
    try {
      if (await fsp.realpath(file)!==file) fail('OWNERSHIP_UNPROVEN');
      // Never truncate or follow a leaf before proving the opened identity.
      h=await fsp.open(file,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW);
      const identity=await h.stat(), max=1024*1024;
      const check=async () => {
        const s=await h.stat(), l=await fsp.lstat(file);
        if (await fsp.realpath(file)!==file || !s.isFile() || !l.isFile() || s.uid!==process.getuid() ||
            (s.mode&0o7777)!==0o600 || s.nlink!==1 || s.size>max || s.dev!==identity.dev || s.ino!==identity.ino ||
            s.dev!==l.dev || s.ino!==l.ino) fail('OWNERSHIP_UNPROVEN');
        return s;
      };
      await check();
      return {
        read:async () => {
          try { const s=await check(), b=await h.readFile(); await check(); if (b.length!==s.size || b.length>max) fail('OWNERSHIP_UNPROVEN'); return b; }
          catch { fail('OWNERSHIP_UNPROVEN'); }
        },
        write:async (value) => {
          try {
            const bytes=Buffer.from(value); if (bytes.length>max) fail('OWNERSHIP_UNPROVEN');
            await check();
            // readFile advances the handle cursor: every write uses an explicit offset.
            for (let offset=0;offset<bytes.length;) {
              const {bytesWritten}=await h.write(bytes,offset,bytes.length-offset,offset);
              if (!bytesWritten) fail('OWNERSHIP_UNPROVEN'); offset+=bytesWritten;
            }
            await h.truncate(bytes.length); await check();
          } catch { fail('OWNERSHIP_UNPROVEN'); }
        },
        close:() => h.close(),
      };
    } catch { if (h) await h.close(); fail('OWNERSHIP_UNPROVEN'); }
  };
  return {path,read,openState,observeTool:(line)=>process.stderr.write(line),observeInventory:(line)=>process.stderr.write(line),hash:(b)=>crypto.createHash('sha256').update(b).digest('hex'),blob:(b)=>crypto.createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex'),
    runtime:{cwd,sourceRoot:path.join(cwd,'qualified-source'),platform:process.platform,arch:process.arch,version:process.version,execPath:process.execPath,uid:process.getuid()},
    qualifier:require('./qualify-api-music-nonloopback.cjs'),now:()=>Date.now(),signalSource:process,setTimeout,clearTimeout,spawn:cp.spawn,
    write:(...v)=>fsp.writeFile(...v),append:(...v)=>fsp.appendFile(...v),mkdir:(...v)=>fsp.mkdir(...v),mkdtemp:(...v)=>fsp.mkdtemp(...v),chmod:(...v)=>fsp.chmod(...v),
    realpath:(v)=>fsp.realpath(v),readdir:(v)=>fsp.readdir(v),rm:(v)=>fsp.rm(v,{recursive:true,force:true,maxRetries:0}),
    stat:async (v)=>{const s=await fsp.lstat(v);return {kind:s.isSymbolicLink()?'symlink':s.isFile()?'file':s.isDirectory()?'directory':'other',mode:s.mode,uid:s.uid,size:s.size};},
    git:async (root,args)=>cp.execFileSync('git',args,{cwd:root,env:{PATH:e.PATH,HOME:e.RUNNER_TEMP,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'},encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000,maxBuffer:4*1024*1024}).replace(/\n$/,''),
    api:(route)=>new Promise((resolve,reject)=>{
      if (!/^\/repos\/deruta74\/pear-desktop\/actions\/runs\/[1-9][0-9]{0,19}(\/attempts\/[1-9][0-9]{0,19}\/jobs\?per_page=100)?$/.test(route)||typeof e.PEAR_API_TOKEN!=='string'||!e.PEAR_API_TOKEN) { reject(Error('ADMISSION_UNPROVEN')); return; }
      let size=0,done=false,response; const data=[];
      const finish=(err,value)=>{if(done)return;done=true;clearTimeout(timer);if(err){response?.destroy();req.destroy();reject(Error('ADMISSION_UNPROVEN'));}else resolve(value);};
      const req=https.request({hostname:'api.github.com',path:route,method:'GET',headers:{Authorization:'Bearer '+e.PEAR_API_TOKEN,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'pear-posix-qualification'}},(res)=>{
        response=res;res.on('error',()=>finish(true));
        if(done){res.destroy();return;}
        if(res.statusCode!==200){finish(true);return;}
        res.on('data',(b)=>{if(done)return;size+=b.length;if(size>1024*1024)finish(true);else data.push(b);});
        res.on('end',()=>{try{finish(false,json(Buffer.concat(data)));}catch{finish(true);}});
      });
      const timer=setTimeout(()=>finish(true),10000);req.on('error',()=>finish(true));req.end();
    })};
}
async function main() {
  guard(process.argv[2],{platform:process.platform,arch:process.arch});
  if(process.argv.length!==3) fail('HOST_UNPROVEN');
  await handle(process.argv[2],realIO(process.env),process.env);
}
module.exports={handle,measureTree,runOwned,safeRunner,safeInnerFailure,safeChildFailure,childFacts,formatResult,publicFacts,formatToolObservation,formatInventoryObservation};
if(typeof require!=='undefined' && require.main===module) main().catch(()=>{process.stderr.write('CARRIER_UNPROVEN\n');process.exitCode=1;});
