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
