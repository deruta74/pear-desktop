param([Parameter(Mandatory)][string]$OutputRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$OutputRoot=[IO.Path]::GetFullPath($OutputRoot)
if ($OutputRoot -ieq $PSScriptRoot -or $OutputRoot.StartsWith($PSScriptRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Output must be outside inputs.' }
$utf8=[Text.UTF8Encoding]::new($false)
[void][IO.Directory]::CreateDirectory($OutputRoot)
$combined=Join-Path $OutputRoot 'field-replay.jsonl'
$stageResults=@{}
foreach ($phase in @('baseline','candidate')) {
  $phaseInputRoot=Join-Path $OutputRoot ($phase+'-inputs'); $output=Join-Path $OutputRoot ($phase+'-evidence')
  [void][IO.Directory]::CreateDirectory($phaseInputRoot)
  foreach ($name in @('replay.ps1','actual-samples.jsonl','negative-controls.jsonl','SOURCE.json')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $phaseInputRoot $name) }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot ($phase+'-functions.ps1')) -Destination (Join-Path $phaseInputRoot 'exact-functions.ps1')
  & (Join-Path $phaseInputRoot 'replay.ps1') -OutputRoot $output
  if ($LASTEXITCODE -ne 0) { throw 'Fixed replay stage failed to complete.' }
  $stageResults[$phase]=Get-Content -LiteralPath (Join-Path $output 'summary.json') -Raw | ConvertFrom-Json
  foreach ($line in [IO.File]::ReadAllLines((Join-Path $output 'field-replay.jsonl'),$utf8)) {
    $row=$line | ConvertFrom-Json
    [IO.File]::AppendAllText($combined,((@{phase=$phase; row=$row} | ConvertTo-Json -Depth 12 -Compress)+"`n"),$utf8)
  }
}
$baselineRows=@(Get-Content -LiteralPath (Join-Path $OutputRoot 'baseline-evidence/field-replay.jsonl') | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object kind -CEQ 'actual')
$baselineRed=[bool]($stageResults.baseline.measurementCompleted -eq $true -and $stageResults.baseline.knownRejectedRows -eq 28 -and $stageResults.baseline.coreErrors -eq 0 -and $stageResults.baseline.negativeControlsUnexpectedlyAccepted -eq 0 -and @($baselineRows | Where-Object rejectionStage -CNE 'fullpath-inequality').Count -eq 0)
. (Join-Path $PSScriptRoot 'candidate-functions.ps1')
$lexicalFailures=0; $lexicalRows=0
foreach ($line in [IO.File]::ReadAllLines((Join-Path $PSScriptRoot 'lexical-controls.jsonl'),$utf8)) {
  $sample=$line | ConvertFrom-Json; $errorType=$null; $owned=$null
  try { $owned=OwnedDirectory (Prop $sample.record 'directory') } catch { $errorType=$_.Exception.GetType().Name }
  $accepted=$null -ne $owned
  $qualified=[bool]($accepted -eq $sample.expectedAccepted -and $null -eq $errorType)
  if (-not $qualified) { $lexicalFailures++ }; $lexicalRows++
  [IO.File]::AppendAllText($combined,((@{phase='candidate-lexical-controls'; sampleId=$sample.sampleId; accepted=$accepted; expectedAccepted=$sample.expectedAccepted; qualified=$qualified; errorType=$errorType} | ConvertTo-Json -Compress)+"`n"),$utf8)
}
$gate=[bool]($baselineRed -and $stageResults.candidate.fieldReplayGatePassed -eq $true -and $lexicalRows -eq 13 -and $lexicalFailures -eq 0)
$summary=@{measurementCompleted=$true; baselineKnownRejectionReproduced=$baselineRed; candidateFieldGate=$stageResults.candidate.fieldReplayGatePassed;
  candidateLexicalControlRows=$lexicalRows; candidateLexicalControlFailures=$lexicalFailures; isolatedPathAdmissionGatePassed=$gate;
  baseline=$stageResults.baseline; candidate=$stageResults.candidate;
  candidateFunctionsSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'candidate-functions.ps1') -Algorithm SHA256).Hash.ToLowerInvariant();
  measurementStatus=$(if ($gate) {'ISOLATED_PATH_ADMISSION_QUALIFIED_ONLY'} else {'RED_PATH_ADMISSION_GATE_FAILED'});
  canonicalPathQualified=$false; lockOwnerQualified=$false; productionFeaturePassed=$false; futureFullSuiteAuthorized=$false;
  sourceAfterTrackedHashes='UNKNOWN'; EBUSYOwner='UNKNOWN'}
[IO.File]::WriteAllText((Join-Path $OutputRoot 'summary.json'),($summary | ConvertTo-Json -Depth 12),$utf8)
Write-Host 'Isolated path-admission comparison completed; feature acceptance remains held.'
exit 0
