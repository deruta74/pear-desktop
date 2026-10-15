param([Parameter(Mandatory)][string]$ReportRoot, [Parameter(Mandatory)][string]$HandlePath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ReportRoot = [IO.Path]::GetFullPath($ReportRoot)
$eventPath = Join-Path $ReportRoot 'collector.jsonl'
$healthPath = Join-Path $ReportRoot 'collector-health.json'
$stopPath = Join-Path $ReportRoot 'collector.stop'
$utf8 = [Text.UTF8Encoding]::new($false)
$clock = [Diagnostics.Stopwatch]::StartNew()
$tails = @{}; $directories = @{}; $seeds = @{}; $graph = @{}
$canonicalRoots = @{}; $canonicalAttempts = @{}
$queue = [Collections.Generic.List[object]]::new()
$delayed = [Collections.Generic.List[object]]::new()
$firstBusy = @{}; $healthErrors = [Collections.Generic.List[string]]::new()
$counts = @{ polls=0; events=0; rmBegin=0; rmReject=0; handleCompleted=0; handleTimedOut=0; inventories=0 }
$active = $null; $lastScanMs = -10000.0; $lastPollMs = -10000.0; $stopping = $false
function Emit([string]$Event, [hashtable]$Fields = @{}) {
  $row = @{ schema=1; event=$Event; utc=[DateTime]::UtcNow.ToString('o'); monoMs=$clock.Elapsed.TotalMilliseconds; collectorPid=$PID }
  foreach ($key in $Fields.Keys) { $row[$key] = $Fields[$key] }
  [IO.File]::AppendAllText($eventPath, (($row | ConvertTo-Json -Depth 12 -Compress) + "`n"), $utf8)
}
function Fault([string]$Code) { $healthErrors.Add($Code); Emit 'diagnostic-error' @{code=$Code} }
function Prop($Value, [string]$Name) {
  $p = $Value.PSObject.Properties[$Name]
  if ($null -ne $p) {
    # Directory scope consumes only the original JSON string, never array unwrapping.
    if ($Name -ceq 'directory' -and $p.Value -isnot [string]) { return $null }
    return $p.Value
  }
  return $null
}

function OwnedDirectory($Value) {
  if ($Value -isnot [string] -or -not [IO.Path]::IsPathFullyQualified($Value)) { return $null }
  # Ordinary drive paths only; keep the literal short alias for downstream cache/OS qualification.
  if ($Value -cnotmatch '\A[A-Za-z]:\\(?:[^\\/:*?"<>|\x00-\x1F]+\\)*[^\\/:*?"<>|\x00-\x1F]+\z') { return $null }
  if ($Value -match '[ .](?:\\|\z)') { return $null }
  if ([IO.Path]::GetFileName($Value) -cnotmatch '\Apear-scrobbler-window-[A-Za-z0-9]{6}\z') { return $null }
  return $Value
}

function Seed([long]$ProcessId, [string]$Directory, [string]$Utc) {
  if ($ProcessId -le 0 -or -not $Directory) { return }
  if (-not $seeds.ContainsKey($ProcessId)) { $seeds[$ProcessId] = [Collections.Generic.List[object]]::new() }
  $seeds[$ProcessId].Add(@{ directory=$Directory; observedUtc=[DateTime]::Parse($Utc).ToUniversalTime() })
}

# This helper runs only the collector-owned Handle query. Its deadline never
# terminates Electron, a test worker, or a handle-owning process.
$initializationStartMs=$clock.Elapsed.TotalMilliseconds
Emit 'collector-initialization' @{stage='add-type'; status='started'; stageElapsedMs=0.0}
try {
Add-Type -ErrorAction Stop -WarningAction SilentlyContinue -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
namespace PearDiagnostic {
 public sealed class CanonicalPathResult {
  public string Original, Resolved, StartUtc, EndUtc, ErrorType;
  public int ErrorCode;
  public double ElapsedMs;
 }
 public static class CanonicalPath {
  [DllImport("kernel32.dll", EntryPoint="GetLongPathNameW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  private static extern uint GetLongPathName(string original, StringBuilder expanded, uint capacity);
  public static CanonicalPathResult Resolve(string original) {
   var r=new CanonicalPathResult { Original=original, StartUtc=DateTime.UtcNow.ToString("o") };
   var watch=Stopwatch.StartNew();
   try {
    // A read-only metadata query; no directory FileStream or persistent handle.
    var expanded=new StringBuilder(32768);
    var length=GetLongPathName(original,expanded,(uint)expanded.Capacity);
    if (length==0) r.ErrorCode=Marshal.GetLastWin32Error();
    else if (length >= expanded.Capacity) r.ErrorCode=122;
    else r.Resolved=expanded.ToString();
   } catch (Exception e) { r.ErrorType=e.GetType().Name; }
   r.ElapsedMs=watch.Elapsed.TotalMilliseconds; r.EndUtc=DateTime.UtcNow.ToString("o"); return r;
  }
 }
 public sealed class HandleResult {
  public string StartUtc, EndUtc, Stdout, Stderr, ErrorType;
  public int? ExitCode, ProcessId;
  public bool TimedOut, TerminationConfirmed;
 }
 public static class HandleProbe {
  public static async Task<HandleResult> Start(string executable, string directory) {
   var r = new HandleResult { StartUtc=DateTime.UtcNow.ToString("o"), Stdout="", Stderr="" };
   using (var p = new Process()) {
    try {
     p.StartInfo = new ProcessStartInfo(executable) { UseShellExecute=false, RedirectStandardOutput=true, RedirectStandardError=true, CreateNoWindow=true };
     foreach (var arg in new [] { "-nobanner", "-a", "-accepteula", directory }) p.StartInfo.ArgumentList.Add(arg);
     p.Start(); r.ProcessId=p.Id;
     var stdout=p.StandardOutput.ReadToEndAsync(); var stderr=p.StandardError.ReadToEndAsync();
     var exit=p.WaitForExitAsync();
     if (await Task.WhenAny(exit, Task.Delay(2000)) != exit) { r.TimedOut=true; try { p.Kill(); } catch (Exception e) { r.ErrorType=e.GetType().Name; } }
     r.TerminationConfirmed=await Task.WhenAny(exit, Task.Delay(1000)) == exit;
     if (r.TerminationConfirmed) { await exit; r.ExitCode=p.ExitCode; r.Stdout=await stdout; r.Stderr=await stderr; }
    } catch (Exception e) { r.ErrorType=e.GetType().Name; }
   }
   r.EndUtc=DateTime.UtcNow.ToString("o"); return r;
  }
 }
}
'@
  Emit 'collector-initialization' @{stage='add-type'; status='succeeded'; stageElapsedMs=($clock.Elapsed.TotalMilliseconds-$initializationStartMs)}
} catch {
  # Safe scalars only: never serialize compiler source, command lines or environment.
  $initializationErrorType=$_.Exception.GetType().Name
  Emit 'collector-initialization' @{stage='add-type'; status='failed'; stageElapsedMs=($clock.Elapsed.TotalMilliseconds-$initializationStartMs); errorType=$initializationErrorType}
  $initializationFailure=@{schema=1; healthy=$false; failureStage='add-type'; errorType=$initializationErrorType;
    collectorPid=$PID; endedUtc=[DateTime]::UtcNow.ToString('o'); monoMs=$clock.Elapsed.TotalMilliseconds;
    initializationElapsedMs=($clock.Elapsed.TotalMilliseconds-$initializationStartMs); originalCoverage=$false; counts=$counts}
  [IO.File]::WriteAllText($healthPath,($initializationFailure | ConvertTo-Json -Depth 8),$utf8)
  exit 2
}

function CanonicalRoot([string]$Directory,[string]$Context,[string]$EventUtc,[bool]$RetryFailed=$false) {
  if ($canonicalRoots.ContainsKey($Directory)) {
    $previous=$canonicalRoots[$Directory]
    if ($previous.status -eq 'resolved' -or -not $RetryFailed) { return $previous }
  }
  $result=[PearDiagnostic.CanonicalPath]::Resolve($Directory)
  $resolved=$null; $status='unavailable'; $validationError=$null
  if ($result.Resolved) {
    $candidate=OwnedDirectory $result.Resolved
    if ($candidate -and [IO.Path]::GetFileName($candidate) -ceq [IO.Path]::GetFileName($Directory)) {
      $resolved=$candidate; $status='resolved'
    } else { $validationError='resolved-root-scope-mismatch' }
  }
  $aliases=@($Directory)
  if ($resolved -and $resolved -ine $Directory) { $aliases += $resolved }
  $record=@{ originalDirectory=$Directory; resolvedDirectory=$resolved; aliases=$aliases; status=$status;
    originalContainsShortAlias=($Directory -match '(?:^|[\\/])[^\\/]*~[0-9]+(?:[\\/]|$)');
    method='GetLongPathNameW-read-only-metadata'; context=$Context; eventUtc=$EventUtc;
    startedUtc=$result.StartUtc; endedUtc=$result.EndUtc; elapsedMs=$result.ElapsedMs;
    errorCode=$result.ErrorCode; errorType=$result.ErrorType; validationError=$validationError;
    resolvedAtCreationOrLaunchReceipt=($Context -in @('fixture-created','fixture-launcher-spawn')) }
  if (-not $canonicalAttempts.ContainsKey($Directory)) { $canonicalAttempts[$Directory]=[Collections.Generic.List[object]]::new() }
  $canonicalAttempts[$Directory].Add($record); $canonicalRoots[$Directory]=$record
  Emit 'root-canonicalization' $record
  return $record
}

function Inventory([string]$Directory, [string]$Operation, [string]$Phase) {
  $started = [DateTime]::UtcNow.ToString('o'); $watch=[Diagnostics.Stopwatch]::StartNew()
  $names=[Collections.Generic.List[object]]::new(); $pending=[Collections.Generic.Queue[string]]::new()
  $truncated=$false; $errorType=$null; $missing=$false; $pending.Enqueue($Directory)
  try {
    if (-not [IO.Directory]::Exists($Directory)) { $missing=$true }
    else {
      while ($pending.Count -gt 0 -and $names.Count -lt 200 -and $watch.ElapsedMilliseconds -lt 100) {
        $folder=$pending.Dequeue(); $enumerator=[IO.Directory]::EnumerateFileSystemEntries($folder).GetEnumerator()
        try {
          while ($names.Count -lt 200 -and $watch.ElapsedMilliseconds -lt 100 -and $enumerator.MoveNext()) {
            $item=$enumerator.Current; $attr=[IO.File]::GetAttributes($item)
            $reparse=($attr -band [IO.FileAttributes]::ReparsePoint) -ne 0
            $isDirectory=($attr -band [IO.FileAttributes]::Directory) -ne 0
            $names.Add(@{name=[IO.Path]::GetRelativePath($Directory,$item); directory=$isDirectory; reparsePoint=$reparse})
            if ($isDirectory -and -not $reparse) { $pending.Enqueue($item) }
          }
          if ($names.Count -ge 200 -or $watch.ElapsedMilliseconds -ge 100) { $truncated=$true }
        } finally { $enumerator.Dispose() }
      }
      if ($pending.Count -gt 0) { $truncated=$true }
    }
  } catch { $errorType=$_.Exception.GetType().Name }
  $counts.inventories++
  Emit 'inventory' @{directory=$Directory; operation=$Operation; phase=$Phase; startedUtc=$started; endedUtc=[DateTime]::UtcNow.ToString('o'); elapsedMs=$watch.Elapsed.TotalMilliseconds; missing=$missing; truncated=$truncated; errorType=$errorType; entries=$names.ToArray(); limitation='Bounded enumeration may perturb directory locks; reparse points are not followed.'}
}
function PollProcesses {
  $started=[DateTime]::UtcNow.ToString('o'); $watch=[Diagnostics.Stopwatch]::StartNew(); $live=@{}
  $excludedQueries=[Collections.Generic.List[object]]::new()
  try {
    # CommandLine is examined in memory ONLY, and is never serialized.
    $rows=@(Get-CimInstance Win32_Process -OperationTimeoutSec 2)
    foreach ($row in $rows) {
      if ($null -eq $row.CreationDate) { continue }
      $created=([DateTime]$row.CreationDate).ToUniversalTime(); $id=[long]$row.ProcessId
      if ($id -eq $PID -or [long]$row.ParentProcessId -eq $PID) {
        # A Handle query has the fixture path in argv; it is the observer itself,
        # never a surviving Electron process or an unexplained lock owner.
        $excludedQueries.Add(@{pid=$id; createdUtc=$created.ToString('o'); executable=[string]$row.Name; reason='collector-or-direct-owned-query'})
        continue
      }
      $live[$id]=@{ pid=$id; parentPid=[long]$row.ParentProcessId; createdUtc=$created.ToString('o'); created=$created; identity="$id|$($created.ToString('o'))"; row=$row; dirs=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase) }
      $record=$live[$id]
      if ($graph.ContainsKey($record.identity)) { foreach ($d in $graph[$record.identity].directories) { [void]$record.dirs.Add($d) } }
      if ($seeds.ContainsKey($id)) { foreach ($seed in $seeds[$id]) { if ($created -le $seed.observedUtc.AddMilliseconds(100)) { [void]$record.dirs.Add($seed.directory) } } }
      $command=[string]$row.CommandLine
      foreach ($d in $directories.Keys) {
        $aliases=@($d)
        if ($canonicalRoots.ContainsKey($d)) { $aliases=$canonicalRoots[$d].aliases }
        foreach ($alias in $aliases) {
          if ($command -match ('(?i)(?:^|[\s"=])' + [regex]::Escape($alias) + '(?=$|[\s"\\/])')) { [void]$record.dirs.Add($d) }
        }
      }
    }
    # Parent chains can be arbitrarily ordered by CIM; converge without assuming order.
    for ($round=0; $round -lt $live.Count; $round++) {
      $changed=$false
      foreach ($record in $live.Values) {
        if ($record.pid -eq $PID -or -not $live.ContainsKey($record.parentPid)) { continue }
        $parent=$live[$record.parentPid]
        if ($parent.created -gt $record.created) { continue }
        foreach ($d in $parent.dirs) { if ($record.dirs.Add($d)) { $changed=$true } }
      }
      if (-not $changed) { break }
    }
    $safe=[Collections.Generic.List[object]]::new()
    foreach ($record in $live.Values) {
      if ($record.pid -eq $PID -or $record.dirs.Count -eq 0) { continue }
      $command=[string]$record.row.CommandLine; $role=$null
      if ($command -match '(?:^|\s)--type=([A-Za-z0-9_-]{1,40})(?:\s|$)') { $role=$Matches[1] }
      $executable=[string]$record.row.Name
      $safeRow=@{identity=$record.identity; pid=$record.pid; parentPid=$record.parentPid; createdUtc=$record.createdUtc; executable=$executable; chromiumType=$role; crashpad=($executable -match 'crashpad' -or $command -match '(?:^|\s)--type=crashpad-handler(?:\s|$)'); directories=@($record.dirs); lastSeenUtc=[DateTime]::UtcNow.ToString('o')}
      if (-not $graph.ContainsKey($record.identity)) { Emit 'owned-process-first-seen' $safeRow }
      $graph[$record.identity]=$safeRow; $safe.Add($safeRow)
    }
    $counts.polls++
    Emit 'process-sample' @{startedUtc=$started; endedUtc=[DateTime]::UtcNow.ToString('o'); elapsedMs=$watch.Elapsed.TotalMilliseconds; pollTargetMs=250; records=$safe.ToArray(); excludedCollectorQueries=$excludedQueries.ToArray(); limitation='Polling gaps and inaccessible command lines can miss transient or detached processes; PID identities include creation time.'}
  } catch { Fault ('process-query-' + $_.Exception.GetType().Name) }
}
function RequestSnapshot([string]$Directory, [string]$Operation, [string]$Phase, [string]$EventUtc, [bool]$Priority=$false) {
  Inventory $Directory $Operation $Phase
  PollProcesses
  $canonical=CanonicalRoot $Directory $Phase $EventUtc
  if ($canonical.status -ne 'resolved') {
    Emit 'handle-unavailable' @{directory=$Directory; operation=$Operation; phase=$Phase; eventUtc=$EventUtc; canonical=$canonical; reason='Exact expanded root unavailable; no no-holder interpretation permitted.'}
    Fault 'exact-root-canonicalization-unavailable'
    return
  }
  $cachedBeforeEvent=([DateTime]::Parse($canonical.endedUtc).ToUniversalTime() -le [DateTime]::Parse($EventUtc).ToUniversalTime())
  if (-not $canonical.resolvedAtCreationOrLaunchReceipt -or ($Phase -eq 'rm-begin' -and -not $cachedBeforeEvent)) {
    Fault 'exact-root-canonicalization-first-observed-too-late'
  }
  $request=@{directory=$Directory; handleDirectory=$canonical.resolvedDirectory; operation=$Operation; phase=$Phase; eventUtc=$EventUtc; receiptUtc=[DateTime]::UtcNow.ToString('o'); canonical=$canonical; canonicalCacheUsed=$true; canonicalEndedBeforeSourceEventUtc=$cachedBeforeEvent; timingLimitation='Source UTC has millisecond precision; conservative before-event comparison may flag same-millisecond overlap.'}
  if ($queue.Count -ge 200) { Fault 'handle-queue-overflow'; return }
  if ($Priority) { $queue.Insert(0,$request) } else { $queue.Add($request) }
  Emit 'snapshot-requested' $request
}
function Consume($Event) {
  $counts.events++; $name=[string](Prop $Event 'event'); $utc=[string](Prop $Event 'utc')
  $directory=OwnedDirectory (Prop $Event 'directory')
  if ($directory) { $directories[$directory]=$true }
  if ($directory -and $name -in @('fixture-created','fixture-launcher-spawn')) {
    [void](CanonicalRoot $directory $name $utc $true)
  }
  if ($name -eq 'fixture-launcher-spawn' -and $directory) { Seed ([long](Prop $Event 'childPid')) $directory $utc }
  if ($name -eq 'native-pid-query-records') {
    $launcher=[long](Prop $Event 'launcherPid')
    if ($seeds.ContainsKey($launcher)) { foreach ($seed in $seeds[$launcher]) { foreach ($record in @(Prop $Event 'records')) { Seed ([long](Prop $record 'pid')) $seed.directory $utc } } }
  }
  if ($name -eq 'rm-begin' -and $directory) {
    $counts.rmBegin++; RequestSnapshot $directory ([string](Prop $Event 'operation')) 'rm-begin' $utc
  }
  if ($name -eq 'rm-reject' -and $directory) {
    $counts.rmReject++; $operation=[string](Prop $Event 'operation')
    RequestSnapshot $directory $operation 'rm-reject' $utc $true
    $errorValue=Prop $Event 'error'
    if ((Prop $errorValue 'code') -eq 'EBUSY' -and -not $firstBusy.ContainsKey($directory)) {
      $firstBusy[$directory]=$true
      $delayed.Add(@{directory=$directory; operation=$operation; dueMs=$clock.Elapsed.TotalMilliseconds+1000; eventUtc=$utc})
      Emit 'first-ebusy-preserved' @{directory=$directory; operation=$operation; originalEvent=$Event; postFailureDueMs=$clock.Elapsed.TotalMilliseconds+1000}
    }
  }
}
function ReadTails {
  foreach ($file in @(Get-ChildItem -LiteralPath $ReportRoot -Filter 'worker-*.jsonl' -File)) {
    if (-not $tails.ContainsKey($file.FullName)) { $tails[$file.FullName]=@{offset=[long]0; tail=''; decoder=[Text.Encoding]::UTF8.GetDecoder()} }
    $state=$tails[$file.FullName]; $stream=$null
    try {
      $stream=[IO.FileStream]::new($file.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
      if ($stream.Length -lt $state.offset) { Fault 'worker-log-truncated'; $state.offset=[long]0; $state.tail=''; $state.decoder=[Text.Encoding]::UTF8.GetDecoder() }
      [void]$stream.Seek($state.offset,[IO.SeekOrigin]::Begin)
      $bytes=[byte[]]::new(65536)
      while (($read=$stream.Read($bytes,0,$bytes.Length)) -gt 0) {
        $state.offset += $read; $chars=[char[]]::new([Text.Encoding]::UTF8.GetMaxCharCount($read))
        $length=$state.decoder.GetChars($bytes,0,$read,$chars,0,$false)
        $state.tail += [string]::new($chars,0,$length)
        while (($newline=$state.tail.IndexOf("`n")) -ge 0) {
          $line=$state.tail.Substring(0,$newline).TrimEnd("`r"); $state.tail=$state.tail.Substring($newline+1)
          if ($line) { try { Consume ($line | ConvertFrom-Json) } catch { Fault ('worker-event-' + $_.Exception.GetType().Name) } }
        }
        if ($state.tail.Length -gt 262144) { Fault 'worker-tail-overflow'; $state.tail=''; break }
      }
    } catch { Fault ('worker-read-' + $_.Exception.GetType().Name) }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
  }
}
try {
  Emit 'collector-ready' @{handlePath=$HandlePath; contract='exact-root read-only handles; no fixture cleanup or process termination'; queryDeadlineMs=2000; queryTerminationGraceMs=1000}
  [IO.File]::WriteAllText((Join-Path $ReportRoot 'collector.ready'),[DateTime]::UtcNow.ToString('o'),$utf8)
  while ($true) {
    ReadTails
    for ($i=$delayed.Count-1; $i -ge 0; $i--) {
      if ($clock.Elapsed.TotalMilliseconds -ge $delayed[$i].dueMs) {
        $item=$delayed[$i]; $delayed.RemoveAt($i)
        RequestSnapshot $item.directory $item.operation 'first-ebusy-plus-1s' $item.eventUtc $true
      }
    }
    if ($clock.Elapsed.TotalMilliseconds-$lastPollMs -ge 250) { $lastPollMs=$clock.Elapsed.TotalMilliseconds; PollProcesses }
    if ($null -ne $active -and $active.task.IsCompleted) {
      try {
        $result=$active.task.GetAwaiter().GetResult(); $counts.handleCompleted++
        if ($result.TimedOut) { $counts.handleTimedOut++ }
        $prefix=Join-Path $ReportRoot ('handle-' + $active.id)
        [IO.File]::WriteAllText(($prefix+'.stdout.log'),$result.Stdout,$utf8)
        [IO.File]::WriteAllText(($prefix+'.stderr.log'),$result.Stderr,$utf8)
        Emit 'handle-result' @{request=$active.request; queryPid=$result.ProcessId; startedUtc=$result.StartUtc; endedUtc=$result.EndUtc; exitCode=$result.ExitCode; timedOut=$result.TimedOut; queryTerminationConfirmed=$result.TerminationConfirmed; errorType=$result.ErrorType; stdoutFile=[IO.Path]::GetFileName($prefix+'.stdout.log'); stderrFile=[IO.Path]::GetFileName($prefix+'.stderr.log'); limitation='No match is not proof of no holder; inaccessible/short-lived processes and delayed samples remain possible.'}
        if (-not $result.TerminationConfirmed -or $result.ErrorType) { Fault 'handle-query-health' }
      } catch { Fault ('handle-result-' + $_.Exception.GetType().Name) }
      $active=$null
    }
    if ($null -eq $active -and $queue.Count -gt 0 -and $clock.Elapsed.TotalMilliseconds-$lastScanMs -ge 500) {
      $request=$queue[0]; $queue.RemoveAt(0); $lastScanMs=$clock.Elapsed.TotalMilliseconds
      $id=[Guid]::NewGuid().ToString('N'); Emit 'handle-start' @{id=$id; request=$request; startedUtc=[DateTime]::UtcNow.ToString('o')}
      $active=@{id=$id; request=$request; task=[PearDiagnostic.HandleProbe]::Start($HandlePath,$request.handleDirectory)}
    }
    if (Test-Path -LiteralPath $stopPath) { $stopping=$true }
    if ($stopping -and $queue.Count -eq 0 -and $delayed.Count -eq 0 -and $null -eq $active) { ReadTails; if ($queue.Count -eq 0 -and $delayed.Count -eq 0) { break } }
    Start-Sleep -Milliseconds 25
  }
  foreach ($state in $tails.Values) { if ($state.tail.Length -gt 0) { Fault 'incomplete-final-worker-line' } }
} catch { try { Fault ('collector-unhandled-' + $_.Exception.GetType().Name) } catch {} }
finally {
  $summary=@{schema=1; healthy=($healthErrors.Count -eq 0 -and $counts.polls -gt 0 -and $counts.events -gt 0 -and $counts.rmBegin -gt 0 -and $counts.handleCompleted -gt 0); endedUtc=[DateTime]::UtcNow.ToString('o'); counts=$counts; errors=$healthErrors.ToArray(); remainingHandleRequests=$queue.Count; remainingDelayedRequests=$delayed.Count; processIdentitiesObserved=$graph.Count; fixturesObserved=$directories.Count; canonicalRoots=@($canonicalRoots.Values); canonicalAttempts=@($canonicalAttempts.Values | ForEach-Object {$_.ToArray()})}
  [IO.File]::WriteAllText($healthPath,($summary | ConvertTo-Json -Depth 8),$utf8)
}
if (-not $summary.healthy) { exit 2 }
exit 0
