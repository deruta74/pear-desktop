param([Parameter(Mandatory)][string]$OutputRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$utf8=[Text.UTF8Encoding]::new($false)
$OutputRoot=[IO.Path]::GetFullPath($OutputRoot)
if ($OutputRoot -ieq $PSScriptRoot -or $OutputRoot.StartsWith($PSScriptRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Replay output must be outside replay inputs.' }
[void][IO.Directory]::CreateDirectory($OutputRoot)
$evidencePath=Join-Path $OutputRoot 'field-replay.jsonl'
$summaryPath=Join-Path $OutputRoot 'summary.json'
# Exact extraction/validation/dispatch functions. Never dot-source the collector.
. (Join-Path $PSScriptRoot 'exact-functions.ps1')
$source=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'SOURCE.json') -Raw | ConvertFrom-Json
$script:delegateCounts=@{canonical=0; snapshot=0; seed=0; emit=0}
# Observation-only delegates: no metadata resolution, filesystem inventory, CIM,
# Handle, child process, cleanup/removal, native test or command execution.
function CanonicalRoot([string]$Directory,[string]$Context,[string]$EventUtc,[bool]$RetryFailed=$false) { $script:delegateCounts.canonical++; return @{status='not-qualified'; method='stubbed-observation-only'} }
function RequestSnapshot([string]$Directory,[string]$Operation,[string]$Phase,[string]$EventUtc,[bool]$Priority=$false) { $script:delegateCounts.snapshot++ }
function Seed([long]$ProcessId,[string]$Directory,[string]$Utc) { $script:delegateCounts.seed++ }
function Emit([string]$Event,[hashtable]$Fields=@{}) { $script:delegateCounts.emit++ }
$clock=[Diagnostics.Stopwatch]::StartNew()
$counts=@{events=0; rmBegin=0; rmReject=0}
$directories=@{}; $seeds=@{}; $firstBusy=@{}; $delayed=[Collections.Generic.List[object]]::new()
$acceptedActualRoots=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$knownCreatedAccepted=0; $knownRmAccepted=0; $knownRejected=0; $controlUnexpected=0; $coreErrors=0; $rowCounterMismatches=0; $total=0
foreach ($name in @('actual-samples.jsonl','negative-controls.jsonl')) {
  foreach ($line in [IO.File]::ReadAllLines((Join-Path $PSScriptRoot $name),$utf8)) {
    if (-not $line) { continue }
    # Original ReadTails uses ConvertFrom-Json without AsHashtable or coercion.
    $sample=$line | ConvertFrom-Json
    $record=$sample.record; $total++
    $property=$record.PSObject.Properties['directory']
    $present=$null -ne $property
    $rawType=if (-not $present) {'missing'} elseif ($null -eq $property.Value) {'null'} else {$property.Value.GetType().FullName}
    $extracted=$null; $owned=$null; $eventName=$null; $errorType=$null
    $fullyQualified=$null; $fullPath=$null; $fileName=$null; $fullPathEqual=$null; $nameShape=$null; $lexicalErrorType=$null
    $beforeRm=$counts.rmBegin; $beforeDirectoryCount=$directories.Count; $beforeSnapshot=$script:delegateCounts.snapshot; $beforeCanonical=$script:delegateCounts.canonical
    try {
      $eventName=[string](Prop $record 'event')
      $extracted=Prop $record 'directory'
      # Diagnostics mirror individual lexical predicates only as scalar evidence.
      # Acceptance is exclusively the return from the unchanged OwnedDirectory.
      if ($extracted -is [string]) {
        try {
          $fullyQualified=[IO.Path]::IsPathFullyQualified($extracted)
          $fullPath=[IO.Path]::GetFullPath($extracted)
          $fileName=[IO.Path]::GetFileName($fullPath)
          $fullPathEqual=$fullPath -ieq $extracted
          $nameShape=$fileName -cmatch '^pear-scrobbler-window-[A-Za-z0-9]{6}$'
        } catch { $lexicalErrorType=$_.Exception.GetType().Name }
      }
      $owned=OwnedDirectory (Prop $record 'directory')
      Consume $record
    } catch { $errorType=$_.Exception.GetType().Name; $coreErrors++ }
    $accepted=$null -ne $owned
    $extractedType=if ($null -eq $extracted) {'null'} else {$extracted.GetType().FullName}
    $rejection=if ($errorType) {'core-exception'} elseif ($accepted) {'accepted'} elseif (-not $present) {'directory-property-missing'} elseif ($extracted -isnot [string]) {'extracted-not-string'} elseif ($fullyQualified -ne $true) {'not-fully-qualified'} elseif ($lexicalErrorType) {'lexical-exception'} elseif ($nameShape -ne $true) {'filename-shape'} elseif ($fullPathEqual -ne $true) {'fullpath-inequality'} else {'unlocalized-null'}
    $consumeRmDelta=$counts.rmBegin-$beforeRm; $consumeDirectoryDelta=$directories.Count-$beforeDirectoryCount
    $snapshotDelta=$script:delegateCounts.snapshot-$beforeSnapshot; $canonicalDelta=$script:delegateCounts.canonical-$beforeCanonical
    # Qualify the unchanged Consume dispatch, not a separate extraction precheck.
    $rowDispatchQualified=$false
    if ($sample.kind -ceq 'actual') {
      if ($accepted) {
        [void]$acceptedActualRoots.Add([string]$owned)
        if ($eventName -ceq 'fixture-created') {
          $rowDispatchQualified=[bool]($null -eq $errorType -and $canonicalDelta -eq 1 -and $snapshotDelta -eq 0 -and $consumeRmDelta -eq 0)
          if ($rowDispatchQualified) { $knownCreatedAccepted++ }
        }
        if ($eventName -ceq 'rm-begin') {
          $rowDispatchQualified=[bool]($null -eq $errorType -and $consumeRmDelta -eq 1 -and $snapshotDelta -eq 1 -and $canonicalDelta -eq 0)
          if ($rowDispatchQualified) { $knownRmAccepted++ }
        }
      } else { $knownRejected++ }
    } else {
      if ($accepted) { $controlUnexpected++ }
      # An exception never excuses a negative sample's unexpected dispatch.
      $rowDispatchQualified=[bool](-not $accepted -and $null -eq $errorType -and $snapshotDelta -eq 0 -and $canonicalDelta -eq 0 -and $consumeRmDelta -eq 0)
    }
    if (-not $rowDispatchQualified) { $rowCounterMismatches++ }
    $row=@{schema=1; sampleId=[string]$sample.sampleId; kind=[string]$sample.kind; event=$eventName;
      propertyPresent=[bool]$present; rawDirectoryType=$rawType; extractedDirectoryType=$extractedType;
      directory=$(if ($extracted -is [string]) {$extracted} else {$null}); fullyQualified=$fullyQualified;
      fullPath=$fullPath; fileName=$fileName; fullPathEqual=$fullPathEqual; filenameShapeMatched=$nameShape;
      exactOwnedDirectoryAccepted=[bool]$accepted; rejectionStage=$rejection; coreErrorType=$errorType; lexicalErrorType=$lexicalErrorType;
      consumeRmBeginDelta=$consumeRmDelta; consumeDirectoryDelta=$consumeDirectoryDelta;
      snapshotObservationDelta=$snapshotDelta; canonicalObservationDelta=$canonicalDelta;
      dispatchCountersQualified=[bool]$rowDispatchQualified; dispatchCounterMismatch=(-not $rowDispatchQualified);
      rowMeasurementStatus=$(if ($rowDispatchQualified) {'ROW_COUNTERS_QUALIFIED'} else {'RED_ROW_COUNTER_MISMATCH'})}
    if ($sample.kind -ceq 'actual') { $row.provenance=$sample.provenance }
    [IO.File]::AppendAllText($evidencePath,(($row | ConvertTo-Json -Depth 8 -Compress)+"`n"),$utf8)
  }
}
$gate=[bool]($acceptedActualRoots.Count -eq 14 -and $knownCreatedAccepted -eq 14 -and $knownRmAccepted -eq 14 -and $knownRejected -eq 0 -and $controlUnexpected -eq 0 -and $coreErrors -eq 0 -and $rowCounterMismatches -eq 0 -and $script:delegateCounts.canonical -eq 14 -and $script:delegateCounts.snapshot -eq 14 -and $counts.events -eq 39 -and $counts.rmBegin -eq 14 -and $directories.Count -eq 14)
$status=if ($knownRejected -gt 0) {'RED_KNOWN_ROWS_REJECTED'} elseif ($coreErrors -gt 0 -or $controlUnexpected -gt 0 -or $rowCounterMismatches -gt 0 -or -not $gate) {'RED_SCOPE_GATE_FAILED'} else {'FIELD_REPLAY_GATE_QUALIFIED_ONLY'}
$summary=@{schema=1; measurementCompleted=$true; measurementStatus=$status; fieldReplayGatePassed=$gate;
  knownRootCount=14; acceptedKnownRootCount=$acceptedActualRoots.Count; knownFixtureCreatedAccepted=$knownCreatedAccepted;
  knownRmBeginAcceptedByConsume=$knownRmAccepted; knownRejectedRows=$knownRejected; negativeControls=11;
  negativeControlsUnexpectedlyAccepted=$controlUnexpected; coreErrors=$coreErrors; rowDispatchCounterMismatches=$rowCounterMismatches; samplesProcessed=$total;
  exactConsumeCounts=$counts; exactConsumeDirectories=$directories.Count; downstreamStubObservations=$script:delegateCounts;
  functionsSourceSha256=$source.collectorSourceSha256; canonicalPathQualified=$false; lockOwnerQualified=$false;
  originalNativeTestsRun=$false; productionFeaturePassed=$false; legacySourceAfterTrackedHashes='UNKNOWN';
  futureFullSuiteAuthorized=$false; endedUtc=[DateTime]::UtcNow.ToString('o');
  limitation='Scope-only typed JSON replay. RED is a completed diagnostic measurement; no cleanup/native/owner/source-after qualification.'}
[IO.File]::WriteAllText($summaryPath,($summary | ConvertTo-Json -Depth 8),$utf8)
Write-Host ('Field-ingestion replay completed: '+$status+'; original/native feature acceptance remains held.')
# A known rejection is evidence, not a transport failure or feature pass.
exit 0
