param([Parameter(Mandatory)][string]$SourceRoot,[Parameter(Mandatory)][string]$ReportRoot,[Parameter(Mandatory)][string]$DiagnosticRoot,[switch]$PreflightOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$PSNativeCommandUseErrorActionPreference=$false
$SourceRoot=[IO.Path]::GetFullPath($SourceRoot); $ReportRoot=[IO.Path]::GetFullPath($ReportRoot); $DiagnosticRoot=[IO.Path]::GetFullPath($DiagnosticRoot)
$utf8=[Text.UTF8Encoding]::new($false)
[void][IO.Directory]::CreateDirectory($ReportRoot)
function JsonFile([string]$Name,$Value) { [IO.File]::WriteAllText((Join-Path $ReportRoot $Name),($Value | ConvertTo-Json -Depth 16),$utf8) }
$script:sourceGitExecutable=$null
function InvokeSourceGit([string[]]$GitArgs,[switch]$Raw) {
  if ([string]::IsNullOrWhiteSpace($script:sourceGitExecutable)) {
    $application=Get-Command -Name 'git.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $script:sourceGitExecutable=$application.Source
    if (-not [IO.Path]::IsPathFullyQualified($script:sourceGitExecutable)) { throw 'External Git application path is not absolute.' }
  }
  # Preserve NUL-delimited filenames without native line splitting or shell quoting.
  $info=[Diagnostics.ProcessStartInfo]::new(); $info.FileName=$script:sourceGitExecutable
  $info.UseShellExecute=$false; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
  $info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false,$true)
  foreach ($arg in @('-C',$SourceRoot)+$GitArgs) { $info.ArgumentList.Add($arg) }
  $child=[Diagnostics.Process]::new(); $child.StartInfo=$info
  try {
    [void]$child.Start()
    $stdout=$child.StandardOutput.ReadToEndAsync(); $stderr=$child.StandardError.ReadToEndAsync()
    [void]$child.WaitForExit(); $value=$stdout.GetAwaiter().GetResult(); [void]$stderr.GetAwaiter().GetResult()
    if ($child.ExitCode -ne 0) { throw 'Source Git query failed.' }
    if ($Raw) { return $value }
    return $value.Trim()
  } finally { $child.Dispose() }
}
function GitPaths([string]$Raw) {
  if ($Raw.Length -eq 0) { return }
  if ($Raw[$Raw.Length-1] -ne [char]0) { throw 'Invalid source Git path protocol.' }
  $parts=$Raw.Split([char]0)
  for ($i=0; $i -lt $parts.Length-1; $i++) {
    if ($parts[$i].Length -eq 0) { throw 'Invalid source Git path protocol.' }
    $parts[$i]
  }
}
function ClassifySourceStatus([string]$Raw,[string[]]$Tracked) {
  $result=@{valid=$true; checkoutClean=($Raw.Length -eq 0); entries=0; trackedEntries=0; untrackedEntries=0;
    knownPlaywrightLastRun=0; unclassifiedEntries=0; statusCodes=@{}}
  $known=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($path in $Tracked) { [void]$known.Add($path) }
  try {
    $parts=@(GitPaths $Raw)
    for ($i=0; $i -lt $parts.Count; $i++) {
      $record=$parts[$i]
      if ($record.Length -lt 4 -or $record[2] -ne ' ') { throw 'Invalid status record.' }
      $code=$record.Substring(0,2); $path=$record.Substring(3)
      if ($code -cnotmatch '\A[ MTADRCU?!]{2}\z' -or $code -in @('  ','!!') -or
          (($code.Contains('?') -or $code.Contains('!')) -and $code -cne '??')) { throw 'Invalid status code.' }
      if ($code.Contains('R') -or $code.Contains('C')) {
        $i++; if ($i -ge $parts.Count) { throw 'Missing status paired path.' }
      }
      $result.entries++
      if (-not $result.statusCodes.ContainsKey($code)) { $result.statusCodes[$code]=0 }; $result.statusCodes[$code]++
      if ($code -ceq '??') {
        $result.untrackedEntries++
        if ($path -ceq 'test-results/.last-run.json') { $result.knownPlaywrightLastRun++ }
        else { $result.unclassifiedEntries++ }
      } elseif ($known.Contains($path)) { $result.trackedEntries++ }
      else { $result.unclassifiedEntries++ }
    }
  } catch { $result.valid=$false; $result.checkoutClean=$false }
  return $result
}
function SourceManifest {
  $errors=[Collections.Generic.List[string]]::new(); $head=$null; $tree=$null; $tracked=@(); $listed=$false
  # Only the pinned manifest grants permission to serialize a source path name.
  $trusted=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  try {
    $expected=Get-Content -LiteralPath (Join-Path $DiagnosticRoot 'SCROBBLER-WINDOWS-EBUSY-SOURCE-MANIFEST.json') -Raw | ConvertFrom-Json
    if ($expected.head -cne '1c2319c386e33c4032a4d45a7f77b6fc9ab0dd29' -or $expected.tree -cne '5e25d905e3c1643c9796a3c2a7452e0ae56cd4e2') { throw 'Trusted source manifest identity mismatch.' }
    foreach ($property in $expected.sourceSha256.PSObject.Properties) { [void]$trusted.Add($property.Name) }
  } catch { $errors.Add('trusted-source-manifest'); $trusted.Clear() }
  try { $head=InvokeSourceGit -GitArgs @('rev-parse','HEAD') } catch { $errors.Add('head-query') }
  try { $tree=InvokeSourceGit -GitArgs @('rev-parse','HEAD^{tree}') } catch { $errors.Add('tree-query') }
  try { $tracked=@(GitPaths (InvokeSourceGit -GitArgs @('ls-files','-z') -Raw)); $listed=$true } catch { $errors.Add('tracked-list') }
  $hashes=@{}; $opaqueHashes=@{}; $identities=@{}; $hashErrors=0; $hashedFiles=0; $identityErrors=0
  foreach ($relative in $tracked) {
    $contentHash=$null
    try { $contentHash=(Get-FileHash -LiteralPath (Join-Path $SourceRoot $relative) -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant(); $hashedFiles++ }
    catch { $hashErrors++ }
    # Git paths cannot contain NUL. The fixed domain plus NUL separates path IDs
    # from content hashes; the separate map prevents public-name/opaque-key overlap.
    $identity='sha256-path-v1:'+([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes("pear-desktop-source-path-v1`0"+$relative)))).ToLowerInvariant()
    if ($identities.ContainsKey($identity)) { $identityErrors++ }
    else { $identities[$identity]=$relative }
    if ($trusted.Contains($relative)) { $hashes[$relative]=$contentHash }
    else { $opaqueHashes[$identity]=$contentHash }
  }
  if ($hashErrors -gt 0) { $errors.Add('tracked-file-hash') }
  if ($identityErrors -gt 0) { $errors.Add('tracked-path-identity-collision-or-duplicate') }
  $status=@{valid=$false; checkoutClean=$false}
  try {
    $rawStatus=InvokeSourceGit -GitArgs @('status','--porcelain=v1','-z','--untracked-files=all') -Raw
    $status=ClassifySourceStatus -Raw $rawStatus -Tracked @($trusted)
    if (-not $status.valid) { $errors.Add('status-protocol') }
  } catch { $errors.Add('status-query') }
  return @{head=$head; tree=$tree; sha256=$hashes; opaqueSha256=$opaqueHashes; opaquePathSchema='sha256-path-v1'; trackedFiles=$tracked.Count; hashedFiles=$hashedFiles;
    identityValid=($head -ceq '1c2319c386e33c4032a4d45a7f77b6fc9ab0dd29' -and $tree -ceq '5e25d905e3c1643c9796a3c2a7452e0ae56cd4e2');
    trackedHashingComplete=($listed -and $hashErrors -eq 0 -and $identityErrors -eq 0 -and ($hashes.Count+$opaqueHashes.Count) -eq $tracked.Count);
    checkoutClean=[bool]$status.checkoutClean; statusClassification=$status; hashErrorCount=$hashErrors; verificationErrors=$errors.ToArray()}
}
function VerifyExpected($Actual) {
  if (-not $Actual.identityValid -or -not $Actual.trackedHashingComplete -or $Actual.verificationErrors.Count -ne 0) { throw 'Source verification incomplete or identity mismatch.' }
  if (-not $Actual.checkoutClean) { throw 'Source checkout is not clean.' }
  $expected=Get-Content -LiteralPath (Join-Path $DiagnosticRoot 'SCROBBLER-WINDOWS-EBUSY-SOURCE-MANIFEST.json') -Raw | ConvertFrom-Json
  if ($expected.head -cne $Actual.head -or $expected.tree -cne $Actual.tree) { throw 'Expected manifest identity mismatch.' }
  foreach ($p in $expected.sourceSha256.PSObject.Properties) {
    if (-not $Actual.sha256.ContainsKey($p.Name) -or $Actual.sha256[$p.Name] -cne $p.Value) { throw 'Expected source SHA256 mismatch.' }
  }
}
function DriverFailure($Record,[string]$Stage) {
  $stack=[string]$Record.ScriptStackTrace
  if ($stack.Length -gt 2000) { $stack=$stack.Substring(0,2000) }
  return @{errorType=$Record.Exception.GetType().Name; message=$Record.Exception.Message; stage=$Stage;
    utc=[DateTime]::UtcNow.ToString('o'); scriptStackTrace=$stack;
    invocation=@{scriptFile=[IO.Path]::GetFileName([string]$Record.InvocationInfo.ScriptName); line=$Record.InvocationInfo.ScriptLineNumber}}
}

# The same real source-verification functions are called in both modes.
# Preflight exits here; it never reaches collector/tool/test setup or its finally.
if ($PreflightOnly) {
  $preflightStage='preflight-report-scope'
  try {
    if ($ReportRoot -ieq $SourceRoot -or $ReportRoot.StartsWith($SourceRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Report root must be outside source.' }
    if ($DiagnosticRoot -ieq $SourceRoot -or $DiagnosticRoot.StartsWith($SourceRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Diagnostic root must be outside source.' }
    $preflightStage='preflight-source-manifest'
    $preflight=SourceManifest
    $preflightStage='preflight-expected-source-sha256'
    VerifyExpected $preflight
    JsonFile 'preflight-source-manifest.json' $preflight
    JsonFile 'preflight-result.json' @{healthy=$true; mode='PreflightOnly'; head=$preflight.head; tree=$preflight.tree;
      sourceClean=[bool]$preflight.checkoutClean; trackedFiles=$preflight.trackedFiles;
      expectedSourceSubsetFiles=9; gitExecutable=$script:sourceGitExecutable; sourceManifestFile='preflight-source-manifest.json';
      collectorStarted=$false; handleStarted=$false; dependenciesStarted=$false; nativeTestsStarted=$false; utc=[DateTime]::UtcNow.ToString('o')}
    Write-Host 'Exact source-driver preflight passed; no collector, Handle, dependencies or tests ran in this mode.'
    exit 0
  } catch {
    JsonFile 'preflight-result.json' @{healthy=$false; mode='PreflightOnly'; failure=(DriverFailure $_ $preflightStage);
      collectorStarted=$false; handleStarted=$false; dependenciesStarted=$false; nativeTestsStarted=$false}
    exit 1
  }
}
function NativeRun([string]$Name,[string]$Command) {
  $started=[DateTime]::UtcNow.ToString('o'); $info=[Diagnostics.ProcessStartInfo]::new()
  $info.FileName=$env:ComSpec; $info.WorkingDirectory=$SourceRoot; $info.UseShellExecute=$false
  $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true; $info.CreateNoWindow=$true
  # cmd /s /c consumes command text; CRT ArgumentList quote escaping corrupts its inner quotes.
  $info.Arguments = '/d /s /c "' + $Command + '"'
  $child=[Diagnostics.Process]::new(); $child.StartInfo=$info
  $outStream=[IO.FileStream]::new((Join-Path $ReportRoot ($Name+'.stdout.log')),[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  $errStream=[IO.FileStream]::new((Join-Path $ReportRoot ($Name+'.stderr.log')),[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try {
    [void]$child.Start()
    $stdout=$child.StandardOutput.BaseStream.CopyToAsync($outStream); $stderr=$child.StandardError.BaseStream.CopyToAsync($errStream)
    [void]$child.WaitForExit(); [void]$stdout.GetAwaiter().GetResult(); [void]$stderr.GetAwaiter().GetResult()
    $code=[int]$child.ExitCode
  } finally { [void]$outStream.Dispose(); [void]$errStream.Dispose(); [void]$child.Dispose() }
  [IO.File]::WriteAllText((Join-Path $ReportRoot ($Name+'.exit.txt')),([string]$code+"`n"),$utf8)
  [void](JsonFile ($Name+'.command.json') @{command=$Command; cwd=$SourceRoot; startedUtc=$started; endedUtc=[DateTime]::UtcNow.ToString('o'); exitCode=[int]$code; stdoutFile=$Name+'.stdout.log'; stderrFile=$Name+'.stderr.log'; retries=0; limitation='Raw stdout/stderr bytes retained separately; cross-stream ordering is not reconstructed.'})
  Write-Host "$Name exit=$code; raw stdout/stderr retained outside source."
  Get-Content -LiteralPath (Join-Path $ReportRoot ($Name+'.stdout.log')) -Tail 20 | Write-Host
  Get-Content -LiteralPath (Join-Path $ReportRoot ($Name+'.stderr.log')) -Tail 10 | Write-Host
  return [int]$code
}
function DiscoverySpecs($Suites) {
  foreach ($suite in $Suites) {
    if ($null -ne $suite.PSObject.Properties['specs']) { foreach ($spec in $suite.specs) { $spec } }
    if ($null -ne $suite.PSObject.Properties['suites']) { DiscoverySpecs $suite.suites }
  }
}
function VerifyFocusedDiscovery($Discovery,[string]$OutputDirectory) {
  $specs=@(DiscoverySpecs $Discovery.suites)
  if (@($Discovery.errors).Count -ne 0 -or $specs.Count -ne 1) { throw 'Focused discovery did not select exactly one error-free spec.' }
  $spec=$specs[0]; $tests=@($spec.tests)
  if ($spec.file -cne 'tests/scrobbler-auth-window-native.test.ts' -or $spec.line -ne 757 -or $spec.column -ne 1 -or
      $spec.title -cne 'a guestless SSO child load failure while still owned retires authentication' -or
      $spec.id -cne '9c30ef01ac55434c7d49-f865dd17fb43f24b848a' -or @($spec.tags).Count -ne 0 -or $tests.Count -ne 1) { throw 'Focused discovery identity mismatch.' }
  if ($tests[0].projectName -cne '' -or @($tests[0].results).Count -ne 0) { throw 'Focused discovery contains an unexpected project or execution result.' }
  $projects=@($Discovery.config.projects)
  if ($projects.Count -ne 1 -or -not [IO.Path]::IsPathFullyQualified([string]$projects[0].outputDir) -or
      -not [string]::Equals([IO.Path]::GetFullPath([string]$projects[0].outputDir),$OutputDirectory,[StringComparison]::OrdinalIgnoreCase)) { throw 'Focused discovery output is not the owned report directory.' }
  return @{healthy=$true; selectedSpecs=1; selectedTests=1; executedResults=0; file=$spec.file; line=$spec.line; column=$spec.column; id=$spec.id; title=$spec.title; outputDirectory=$OutputDirectory}
}
# Preflight artifacts may exist. An earlier measurement must never be reused or deleted.
foreach ($name in @('source-before.json','collector.ready','collector.stop','playwright-output','focused-discovery.stdout.log','host-carrier-0.json','host-carrier-7.json')) {
  if (Test-Path -LiteralPath (Join-Path $ReportRoot $name)) { throw 'Diagnostic measurement report directory is not fresh.' }
}
if (@(Get-ChildItem -LiteralPath $ReportRoot -Filter 'worker-*.jsonl' -File).Count -ne 0) { throw 'Diagnostic worker evidence already exists.' }
$collector=$null; $collectorStdout=$null; $collectorStderr=$null; $copyOut=$null; $copyErr=$null
$oldNodeOptions=$env:NODE_OPTIONS; $oldReportRoot=$env:PEAR_EBUSY_REPORT_ROOT
$fullCode=$null; $focusedCode=$null; $sourceValid=$false; $diagnosticHealthy=$false
$trackedSourceUnchanged=$false; $checkoutClean=$false; $sourceVerificationComplete=$false
$carrierQualified=$false; $discoveryQualified=$false
$collectorStarted=$false; $fullInvoked=$false; $focusedInvoked=$false; $primaryFailureStage=$null
$admissionClock=[Diagnostics.Stopwatch]::StartNew()
$collectorStartup=@{schema=1; parentPid=$PID; clockOriginUtc=[DateTime]::UtcNow.ToString('o'); admissionLimitMs=30000;
  launchAttempted=$false; launchSucceeded=$false; childPid=$null; launchAttemptUtc=$null; launchAttemptMonoMs=$null;
  launchSuccessUtc=$null; launchSuccessMonoMs=$null; waitStartUtc=$null; waitStartMonoMs=$null;
  deadlineUtc=$null; deadlineMonoMs=$null; readyDetectedUtc=$null; readyDetectedMonoMs=$null;
  waitElapsedMs=$null; outcome='not-attempted'; endedUtc=$null; endedMonoMs=$null; errorType=$null; failureStage=$null}
$driverStage='source-scope'
try {
  if ($ReportRoot -ieq $SourceRoot -or $ReportRoot.StartsWith($SourceRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Report root must be outside source.' }
  if ($DiagnosticRoot -ieq $SourceRoot -or $DiagnosticRoot.StartsWith($SourceRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Diagnostic root must be outside source.' }
  $driverStage='source-before'
  $before=SourceManifest; VerifyExpected $before; JsonFile 'source-before.json' $before
  $driverStage='diagnostic-file-copy'
  foreach ($name in @('SCROBBLER-WINDOWS-EBUSY-preload.cjs','SCROBBLER-WINDOWS-EBUSY-collector.ps1','SCROBBLER-WINDOWS-EBUSY-carrier.cjs')) { Copy-Item -LiteralPath (Join-Path $DiagnosticRoot $name) -Destination (Join-Path $ReportRoot $name) }
  $diagnosticHashes=@{}
  foreach ($file in @(Get-ChildItem -LiteralPath $DiagnosticRoot -File)) { $diagnosticHashes[$file.Name]=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
  JsonFile 'diagnostic-files.json' $diagnosticHashes
  $driverStage='resolved-environment'
  $package=Get-Content -LiteralPath (Join-Path $SourceRoot 'package.json') -Raw | ConvertFrom-Json
  $nodeVersion=(& node --version); if ($LASTEXITCODE -ne 0) { throw 'Node version query failed.' }
  $pnpmVersion=(& pnpm --version); if ($LASTEXITCODE -ne 0) { throw 'pnpm version query failed.' }
  JsonFile 'resolved-environment.json' @{utc=[DateTime]::UtcNow.ToString('o'); os=[Environment]::OSVersion.VersionString; cpuCount=[Environment]::ProcessorCount; node=$nodeVersion; pnpm=$pnpmVersion; electron=$package.devDependencies.electron; playwright=$package.devDependencies.'@playwright/test'; runnerImageOS=$env:ImageOS; runnerImageVersion=$env:ImageVersion; sourceHead=$before.head; sourceTree=$before.tree}

  $driverStage='carrier-environment'
  $preload=Join-Path $ReportRoot 'SCROBBLER-WINDOWS-EBUSY-preload.cjs'
  $preloadForward=$preload.Replace('\','/')
  $carrierForward=(Join-Path $ReportRoot 'SCROBBLER-WINDOWS-EBUSY-carrier.cjs').Replace('\','/')
  $playwrightOutput=Join-Path $ReportRoot 'playwright-output'
  if ($playwrightOutput -match '["%!\r\n]') { throw 'Report output path is not safe for the controlled cmd carrier.' }
  $focusedArguments='tests/scrobbler-auth-window-native.test.ts --grep "a guestless SSO child load failure while still owned retires authentication$" --workers=1 --retries=0 --output "'+$playwrightOutput+'"'
  $env:PEAR_EBUSY_REPORT_ROOT=$ReportRoot
  $env:NODE_OPTIONS=(([string]$oldNodeOptions+' --require="'+$preloadForward+'"').Trim())
  # SAME NativeRun/cmd.exe/env/preload used below by the original tests.
  $carrierSuffix=' --node-major 24 --preload "'+$preloadForward+'" --literal "owned argument with spaces" --literal-backslash "owned\argument" --grep "a guestless SSO child load failure while still owned retires authentication$" --output "'+$playwrightOutput+'"'
  $driverStage='carrier-exit-zero'
  $carrierZero=NativeRun 'carrier-exit-0' ('node "'+$carrierForward+'" --expected-exit 0'+$carrierSuffix)
  if ($carrierZero -isnot [int] -or $carrierZero -ne 0) { throw 'Host Node carrier zero-exit result is not the expected scalar Int32.' }
  $driverStage='carrier-exit-seven'
  $carrierSeven=NativeRun 'carrier-exit-7' ('node "'+$carrierForward+'" --expected-exit 7'+$carrierSuffix)
  if ($carrierSeven -isnot [int] -or $carrierSeven -ne 7) { throw 'Host Node carrier controlled-exit result is not the expected scalar Int32.' }
  $carrierTraceZero=Get-Content -LiteralPath (Join-Path $ReportRoot 'host-carrier-0.json') -Raw | ConvertFrom-Json
  $carrierTraceSeven=Get-Content -LiteralPath (Join-Path $ReportRoot 'host-carrier-7.json') -Raw | ConvertFrom-Json
  if ($carrierTraceZero.healthy -ne $true -or $carrierTraceSeven.healthy -ne $true -or $carrierTraceZero.expectedExit -ne 0 -or $carrierTraceSeven.expectedExit -ne 7 -or $carrierTraceZero.outputArgumentMatched -ne $true -or $carrierTraceSeven.outputArgumentMatched -ne $true) { throw 'Host Node carrier trace validation failed.' }
  $carrierQualified=$true
  JsonFile 'carrier-health.json' @{healthy=[bool]$carrierQualified; scalarExitZero=[int]$carrierZero; scalarExitSeven=[int]$carrierSeven; nodeMajorRequired=24; exactPreloadLoaded=$true; controlledArgumentsMatched=$true; previousNodeOptionsPreserved=$true; fullOrFocusedTestsRunByCarrier=$false; nativeFixtureOrElectronStartedByCarrier=$false}

  $driverStage='focused-discovery'
  $discoveryCode=NativeRun 'focused-discovery' ('pnpm exec playwright test '+$focusedArguments+' --list --reporter=json')
  if ($discoveryCode -isnot [int] -or $discoveryCode -ne 0) { throw 'Focused discovery command did not return scalar exit zero.' }
  $discovery=Get-Content -LiteralPath (Join-Path $ReportRoot 'focused-discovery.stdout.log') -Raw | ConvertFrom-Json
  $discoveryHealth=VerifyFocusedDiscovery $discovery $playwrightOutput
  JsonFile 'focused-discovery-health.json' $discoveryHealth
  $discoveryQualified=[bool]$discoveryHealth.healthy

  $driverStage='handle-provision'
  $toolRoot=Join-Path $ReportRoot 'tool'; [void][IO.Directory]::CreateDirectory($toolRoot)
  $zip=Join-Path $toolRoot 'Handle.zip'; $url='https://download.sysinternals.com/files/Handle.zip'
  Invoke-WebRequest -Uri $url -OutFile $zip
  Expand-Archive -LiteralPath $zip -DestinationPath $toolRoot
  $handle=Join-Path $toolRoot 'handle64.exe'; $signature=Get-AuthenticodeSignature -LiteralPath $handle
  if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') { throw 'Microsoft Handle signature validation failed.' }
  JsonFile 'handle-provenance.json' @{downloadUrl=$url; downloadUtc=[DateTime]::UtcNow.ToString('o'); zipSha256=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant(); executableSha256=(Get-FileHash -LiteralPath $handle -Algorithm SHA256).Hash.ToLowerInvariant(); fileVersion=(Get-Item -LiteralPath $handle).VersionInfo.FileVersion; signatureStatus=[string]$signature.Status; signerSubject=$signature.SignerCertificate.Subject; signerThumbprint=$signature.SignerCertificate.Thumbprint; arguments=@('-nobanner','-a','-accepteula','<exact fixture root>'); readOnly=$true}
  $driverStage='collector-start'
  $pwsh=(Get-Command pwsh).Source
  $info=[Diagnostics.ProcessStartInfo]::new(); $info.FileName=$pwsh; $info.UseShellExecute=$false; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
  foreach ($arg in @('-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path $ReportRoot 'SCROBBLER-WINDOWS-EBUSY-collector.ps1'),'-ReportRoot',$ReportRoot,'-HandlePath',$handle)) { $info.ArgumentList.Add($arg) }
  $collector=[Diagnostics.Process]::new(); $collector.StartInfo=$info
  $collectorStdout=[IO.FileStream]::new((Join-Path $ReportRoot 'collector.stdout.log'),[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  $collectorStderr=[IO.FileStream]::new((Join-Path $ReportRoot 'collector.stderr.log'),[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  $collectorStartup.launchAttempted=$true; $collectorStartup.outcome='launching'
  $collectorStartup.launchAttemptUtc=[DateTime]::UtcNow.ToString('o'); $collectorStartup.launchAttemptMonoMs=$admissionClock.Elapsed.TotalMilliseconds
  $collectorStarted=[bool]$collector.Start()
  if (-not $collectorStarted) { throw 'Collector launch returned false.' }
  $collectorStartup.launchSucceeded=$true; $collectorStartup.childPid=$collector.Id
  $collectorStartup.launchSuccessUtc=[DateTime]::UtcNow.ToString('o'); $collectorStartup.launchSuccessMonoMs=$admissionClock.Elapsed.TotalMilliseconds
  $copyOut=$collector.StandardOutput.BaseStream.CopyToAsync($collectorStdout); $copyErr=$collector.StandardError.BaseStream.CopyToAsync($collectorStderr)
  $driverStage='collector-ready-wait'
  # Startup admission ONLY: parent monotonic 30 seconds; no retry or late-ready success.
  $waitStartUtc=[DateTime]::UtcNow
  $collectorStartup.waitStartUtc=$waitStartUtc.ToString('o'); $collectorStartup.waitStartMonoMs=$admissionClock.Elapsed.TotalMilliseconds
  $collectorStartup.deadlineUtc=$waitStartUtc.AddMilliseconds($collectorStartup.admissionLimitMs).ToString('o')
  $collectorStartup.deadlineMonoMs=$collectorStartup.waitStartMonoMs+$collectorStartup.admissionLimitMs
  $collectorStartup.outcome='waiting'
  while ($true) {
    if ($collector.HasExited) { $collectorStartup.outcome='collector-exited'; throw 'Collector exited before startup admission.' }
    if (Test-Path -LiteralPath (Join-Path $ReportRoot 'collector.ready')) {
      $collectorStartup.readyDetectedUtc=[DateTime]::UtcNow.ToString('o'); $collectorStartup.readyDetectedMonoMs=$admissionClock.Elapsed.TotalMilliseconds
      $collectorStartup.waitElapsedMs=$collectorStartup.readyDetectedMonoMs-$collectorStartup.waitStartMonoMs
      if ($collectorStartup.readyDetectedMonoMs -ge $collectorStartup.deadlineMonoMs) { $collectorStartup.outcome='late-ready-rejected'; throw 'Collector readiness observed after startup admission bound.' }
      if ($collector.HasExited) { $collectorStartup.outcome='collector-exited'; throw 'Collector exited at readiness detection.' }
      $collectorStartup.outcome='ready-admitted'; break
    }
    $collectorStartup.waitElapsedMs=$admissionClock.Elapsed.TotalMilliseconds-$collectorStartup.waitStartMonoMs
    if ($admissionClock.Elapsed.TotalMilliseconds -ge $collectorStartup.deadlineMonoMs) { $collectorStartup.outcome='admission-timeout'; throw 'Collector failed to become ready within startup admission bound.' }
    Start-Sleep -Milliseconds 100
  }
  $collectorStartup.endedUtc=[DateTime]::UtcNow.ToString('o'); $collectorStartup.endedMonoMs=$admissionClock.Elapsed.TotalMilliseconds
  JsonFile 'collector-startup.json' $collectorStartup
  # Exactly one focused body after actual carrier, discovery and collector readiness.
  $driverStage='focused'
  $focusedInvoked=$true
  $focusedResult=NativeRun 'focused' ('pnpm exec playwright test '+$focusedArguments+' --reporter=line')
  if ($focusedResult -isnot [int]) { throw 'Focused NativeRun result is not a scalar Int32.' }
  $focusedCode=[int]$focusedResult
} catch {
  $primaryFailureStage=$driverStage
  if ($collectorStartup.outcome -in @('launching','waiting')) { $collectorStartup.outcome='startup-error' }
  if ($collectorStartup.outcome -ne 'ready-admitted') {
    $collectorStartup.failureStage=$driverStage; $collectorStartup.errorType=$_.Exception.GetType().Name
    $collectorStartup.endedUtc=[DateTime]::UtcNow.ToString('o'); $collectorStartup.endedMonoMs=$admissionClock.Elapsed.TotalMilliseconds
    if ($null -ne $collectorStartup.waitStartMonoMs) { $collectorStartup.waitElapsedMs=$collectorStartup.endedMonoMs-$collectorStartup.waitStartMonoMs }
    JsonFile 'collector-startup.json' $collectorStartup
  }
  JsonFile 'driver-error.json' (DriverFailure $_ $driverStage)
}
finally {
  $env:NODE_OPTIONS=$oldNodeOptions; $env:PEAR_EBUSY_REPORT_ROOT=$oldReportRoot
  [IO.File]::WriteAllText((Join-Path $ReportRoot 'collector.stop'),'stop',$utf8)
  if ($null -ne $collector) {
    # Bounded teardown of the collector only; never kill Electron/test/lock owners.
    if ($collectorStarted -and -not $collector.WaitForExit(15000)) { JsonFile 'collector-stop-timeout.json' @{timeoutMs=15000; collectorPid=$collector.Id}; $collector.Kill(); [void]$collector.WaitForExit(2000) }
    if ($collectorStarted -and $collector.HasExited) { [IO.File]::WriteAllText((Join-Path $ReportRoot 'collector.exit.txt'),([string]$collector.ExitCode+"`n"),$utf8) }
    if ($null -ne $copyOut -and $copyOut.IsCompleted) { try { [void]$copyOut.GetAwaiter().GetResult() } catch {} }
    if ($null -ne $copyErr -and $copyErr.IsCompleted) { try { [void]$copyErr.GetAwaiter().GetResult() } catch {} }
    if ($null -ne $collectorStdout) { $collectorStdout.Dispose() }; if ($null -ne $collectorStderr) { $collectorStderr.Dispose() }; $collector.Dispose()
  }
  try {
    $after=SourceManifest; JsonFile 'source-after.json' $after
    $checkoutClean=[bool]$after.checkoutClean
    $sourceVerificationComplete=[bool]($after.identityValid -and $after.trackedHashingComplete -and $after.verificationErrors.Count -eq 0)
    $trackedSourceUnchanged=($null -ne (Get-Variable before -ErrorAction SilentlyContinue) -and $before.trackedHashingComplete -and $after.trackedHashingComplete -and $before.trackedFiles -eq $after.trackedFiles)
    if ($trackedSourceUnchanged) {
      foreach ($map in @('sha256','opaqueSha256')) {
        if ($before[$map].Count -ne $after[$map].Count) { $trackedSourceUnchanged=$false; break }
        foreach ($name in $before[$map].Keys) { if (-not $after[$map].ContainsKey($name) -or $before[$map][$name] -cne $after[$map][$name]) { $trackedSourceUnchanged=$false; break } }
        if (-not $trackedSourceUnchanged) { break }
      }
    }
    VerifyExpected $after
    $sourceValid=[bool]($trackedSourceUnchanged -and $checkoutClean -and $sourceVerificationComplete)
  } catch { JsonFile 'source-verification-error.json' (DriverFailure $_ 'source-after') }
  try {
    if (-not $focusedInvoked) {
      JsonFile 'diagnostic-health.json' @{healthy=$false; carrierQualified=[bool]$carrierQualified; originalSuite1745With2WorkersObserved=$false;
        originalCoverage=$false; fullSuiteInvoked=[bool]$fullInvoked; focusedInvoked=[bool]$focusedInvoked;
        fullSuiteExit=$fullCode; focusedExit=$focusedCode; primaryFailureStage=$primaryFailureStage;
        discoveryQualified=[bool]$discoveryQualified; reason='Driver failed before focused invocation; no native body coverage claimed.'}
    } else {
    $health=Get-Content -LiteralPath (Join-Path $ReportRoot 'collector-health.json') -Raw | ConvertFrom-Json
    $loggerErrors=@(Get-ChildItem -LiteralPath $ReportRoot -Filter '*.diagnostic-error' -File)
    $workerLogs=@(Get-ChildItem -LiteralPath $ReportRoot -Filter 'worker-*.jsonl' -File)
    $allWorkersReady=$workerLogs.Count -gt 0
    foreach ($file in $workerLogs) { $first=Get-Content -LiteralPath $file.FullName -TotalCount 1 | ConvertFrom-Json; if ($first.event -ne 'preload-ready') { $allWorkersReady=$false } }
    $diagnosticHealthy=[bool]($health.healthy -eq $true -and $health.fixturesObserved -gt 0 -and $loggerErrors.Count -eq 0 -and $allWorkersReady -and $carrierQualified -and $discoveryQualified -and $collectorStartup.outcome -eq 'ready-admitted' -and -not (Test-Path -LiteralPath (Join-Path $ReportRoot 'collector-stop-timeout.json')))
    JsonFile 'diagnostic-health.json' @{healthy=$diagnosticHealthy; mode='focused-only'; fullSuiteInvoked=[bool]$fullInvoked; focusedInvoked=[bool]$focusedInvoked; primaryFailureStage=$primaryFailureStage; originalSuite1745With2WorkersObserved=$false; discoveryQualified=[bool]$discoveryQualified; workerLogs=$workerLogs.Count; everyWorkerLogReady=$allWorkersReady; loggerErrorFiles=$loggerErrors.Count; collector=$health}
    }
  } catch { JsonFile 'diagnostic-health-error.json' (DriverFailure $_ 'diagnostic-health-after') }
  JsonFile 'outcome.json' @{mode='focused-only'; fullSuiteExit=$fullCode; focusedExit=$focusedCode; fullSuiteInvoked=[bool]$fullInvoked; focusedInvoked=[bool]$focusedInvoked; noOriginalInvocation=(-not ($fullInvoked -or $focusedInvoked)); primaryFailureStage=$primaryFailureStage; collectorStartupOutcome=$collectorStartup.outcome; collectorStartupAdmissionLimitMs=$collectorStartup.admissionLimitMs; sourceUnchanged=[bool]$sourceValid; trackedSourceUnchanged=[bool]$trackedSourceUnchanged; checkoutClean=[bool]$checkoutClean; sourceVerificationComplete=[bool]$sourceVerificationComplete; diagnosticHealthy=[bool]$diagnosticHealthy; carrierQualified=[bool]$carrierQualified; discoveryQualified=[bool]$discoveryQualified; originalBudgetsChanged=$false; fullSuiteFirst=$false; acceptance='Focused diagnostic evidence only; does not replace failed original PR58 Windows acceptance.'}
}
if (-not $focusedInvoked -or $focusedCode -ne 0 -or -not $sourceValid -or -not $diagnosticHealthy -or -not $discoveryQualified -or (Test-Path -LiteralPath (Join-Path $ReportRoot 'driver-error.json'))) { exit 1 }
exit 0
