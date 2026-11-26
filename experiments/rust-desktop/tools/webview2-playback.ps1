$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$ProgressPreference = 'SilentlyContinue'

if ($env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:GITHUB_REPOSITORY -cne 'deruta74/pear-desktop' -or
    $env:GITHUB_REF -cne 'refs/heads/experiment/rust-windows-qa' -or !$env:RUNNER_TEMP) {
    Write-Output 'PEAR_WINDOWS_PLAYBACK status=fail reason=unexpected-runner'
    exit 1
}

$root = Join-Path $env:RUNNER_TEMP "pear-webview2-playback-$([guid]::NewGuid().ToString('N'))"
$profile = Join-Path $root 'WebView2'
$qaLog = Join-Path $env:RUNNER_TEMP 'pear-windows-qa/qa.log'
$preview = $null
$listenerOwner = $null
$stage = 'setup'
$exitCode = 1

function Get-PlaybackWebViewProcess([int] $processId) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    if ($candidate.Name -ieq 'msedgewebview2.exe' -and $candidate.CommandLine -and
        $candidate.CommandLine.Contains($profile, [StringComparison]::OrdinalIgnoreCase)) {
        return $candidate
    }
}

try {
    $null = New-Item -ItemType Directory -Path $root
    $stage = 'dependency-install'
    & npm.cmd install --prefix $root --cache (Join-Path $root 'npm-cache') --registry 'https://registry.npmjs.org/' `
        --ignore-scripts --no-audit --no-fund --no-package-lock --no-progress --loglevel=silent `
        --fetch-retries=0 --fetch-timeout=20000 --save-exact playwright-core@1.61.1 *> $null
    if ($LASTEXITCODE -ne 0) { throw 'dependency-install' }
    $script = Join-Path $root 'webview2-playback.cjs'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'webview2-playback.cjs') -Destination $script
    '{"entries":["M7lc1UVf-VE"],"current":"M7lc1UVf-VE","titles":{}}' |
        Set-Content -LiteralPath (Join-Path $root 'queue.json') -Encoding utf8

    $stage = 'port-allocation'
    $socket = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $socket.Start()
        $port = $socket.LocalEndpoint.Port
    } finally {
        $socket.Stop()
    }

    $stage = 'preview-launch'
    $options = [Diagnostics.ProcessStartInfo]::new()
    $options.FileName = Join-Path $env:RUNNER_TEMP 'pear-rust-target/x86_64-pc-windows-msvc/debug/pear-desktop-preview.exe'
    $options.ArgumentList.Add('--queue-smoke')
    $options.WorkingDirectory = $root
    $options.UseShellExecute = $false
    $options.RedirectStandardOutput = $true
    $options.RedirectStandardError = $true
    $options.Environment['PEAR_PREVIEW_QUEUE_DIR'] = $root
    $options.Environment['PEAR_PREVIEW_SMOKE_CDP_PORT'] = $port.ToString([Globalization.CultureInfo]::InvariantCulture)
    $null = $options.Environment.Remove('WEBVIEW2_USER_DATA_FOLDER')
    $null = $options.Environment.Remove('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS')
    $null = $options.Environment.Remove('WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER')
    $null = $options.Environment.Remove('WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER')
    $null = $options.Environment.Remove('PEAR_YOUTUBE_API_KEY_FILE')
    $preview = [Diagnostics.Process]::Start($options)
    $stdout = $preview.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
    $stderr = $preview.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)

    $stage = 'endpoint-unavailable'
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt 15) {
        if ($preview.HasExited) { throw 'preview-exited' }
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
        if ($listeners.Count -eq 0) {
            Start-Sleep -Milliseconds 200
            continue
        }
        $stage = 'endpoint-ownership'
        $owners = @($listeners.OwningProcess | Sort-Object -Unique)
        if ($owners.Count -ne 1 -or !(Get-PlaybackWebViewProcess $owners[0])) { throw 'endpoint-ownership' }
        $listenerOwner = $owners[0]
        $stage = 'endpoint-binding'
        if ($listeners.LocalAddress | Where-Object { $_ -cnotin '127.0.0.1', '::1' }) { throw 'endpoint-binding' }
        break
    }
    if ($null -eq $listenerOwner) { throw 'endpoint-unavailable' }

    $stage = 'probe-process'
    $lines = @(& node.exe $script $port 2>$null)
    $probeExit = $LASTEXITCODE
    if ($lines.Count -ne 1 -or $lines[0] -cnotmatch '^PEAR_WINDOWS_PLAYBACK status=(pass|fail|inconclusive) reason=[a-z][a-z0-9-]{0,47}$') {
        throw 'probe-output'
    }
    $report = $lines[0]
    if ($probeExit -eq 0 -and $Matches[1] -ceq 'pass') { $exitCode = 0 }
    if ($probeExit -eq 2 -and $Matches[1] -ceq 'inconclusive') { $exitCode = 2 }
    if ($exitCode -eq 1 -and $Matches[1] -cne 'fail') { throw 'probe-exit' }
} catch {
    $report = "PEAR_WINDOWS_PLAYBACK status=fail reason=$stage"
} finally {
    try {
        if ($null -ne $preview) {
            if (!$preview.HasExited -and (!$preview.CloseMainWindow() -or !$preview.WaitForExit(3000))) {
                $preview.Kill($true)
                if (!$preview.WaitForExit(4000)) { throw 'preview-cleanup' }
            }
            $preview.Dispose()
        }
        if ($null -ne $listenerOwner -and (Get-PlaybackWebViewProcess $listenerOwner)) {
            Stop-Process -Id $listenerOwner -Force -ErrorAction Stop
        }
        for ($attempt = 0; $attempt -lt 3 -and (Test-Path -LiteralPath $root); $attempt++) {
            Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $root) { Start-Sleep -Milliseconds 300 }
        }
        if (Test-Path -LiteralPath $root) { throw 'profile-cleanup' }
    } catch {
        $report = 'PEAR_WINDOWS_PLAYBACK status=fail reason=cleanup'
        $exitCode = 1
    }
}

$report | Tee-Object -FilePath $qaLog -Append
if ($exitCode -eq 2) {
    Write-Output '::warning::Windows WebView2 playback probe was inconclusive.'
    exit 0
}
exit $exitCode
