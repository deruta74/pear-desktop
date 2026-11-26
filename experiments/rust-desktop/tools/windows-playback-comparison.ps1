param(
    [Parameter(Mandatory = $true)]
    [string] $PreviewExe
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ($env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:GITHUB_REPOSITORY -cne 'deruta74/pear-desktop' -or
    $env:GITHUB_REF -cne 'refs/heads/diagnostic/rust-windows-playback-comparison' -or !$env:RUNNER_TEMP) {
    throw 'Unexpected Windows playback comparison environment.'
}

$root = Join-Path $env:RUNNER_TEMP "pear-playback-$([guid]::NewGuid().ToString('N'))"
$profile = Join-Path $root 'pear'
$webviewProfile = Join-Path $profile 'WebView2'
$preview = $null
$listenerOwner = 0
$stage = 'setup'
$prefix = 'PEAR_WINDOWS_PLAYBACK_COMPARISON '

function Get-OwnedWebView([int] $processId) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    return ($candidate.Name -ieq 'msedgewebview2.exe' -and $candidate.CommandLine -and
        $candidate.CommandLine.Contains($webviewProfile, [StringComparison]::OrdinalIgnoreCase))
}

function Get-OwnedIPv4Listener([int] $port) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($listeners.LocalAddress | Where-Object { $_ -cnotin '127.0.0.1', '::1' }) { throw 'non-loopback' }
    $ipv4 = @($listeners | Where-Object { $_.LocalAddress -ceq '127.0.0.1' })
    if (!$ipv4.Count) { return 0 }
    $owners = @($listeners.OwningProcess | Sort-Object -Unique)
    if ($ipv4.Count -ne 1 -or $owners.Count -ne 1 -or !(Get-OwnedWebView $ipv4[0].OwningProcess)) {
        throw 'unexpected-listener'
    }
    return $ipv4[0].OwningProcess
}

try {
    $null = New-Item -ItemType Directory -Path $root, $profile
    $stage = 'playwright-install'
    & npm.cmd install --prefix $root --cache (Join-Path $root 'npm-cache') --registry 'https://registry.npmjs.org/' `
        --ignore-scripts --no-audit --no-fund --no-package-lock --no-progress --fetch-retries=0 `
        --fetch-timeout=20000 playwright-core@1.61.1 *> $null
    if ($LASTEXITCODE -ne 0) { throw 'install' }
    $probe = Join-Path $root 'probe.cjs'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-playback-comparison.cjs') -Destination $probe

    $stage = 'local-debugger'
    $socket = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $socket.Start()
        $port = $socket.LocalEndpoint.Port
    } finally {
        $socket.Stop()
    }

    $stage = 'preview-launch'
    '{"entries":["M7lc1UVf-VE"],"current":"M7lc1UVf-VE","titles":{}}' |
        Set-Content -LiteralPath (Join-Path $profile 'queue.json') -Encoding utf8
    $environment = @{
        PEAR_PREVIEW_QUEUE_DIR = $profile
        PEAR_YOUTUBE_API_KEY_FILE = $null
        PEAR_YOUTUBE_OAUTH_CLIENT_FILE = $null
        WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = $null
        WEBVIEW2_USER_DATA_FOLDER = $null
        WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER = $null
        WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER = $null
        # The runtime appends these to the app's normal WebView2 arguments.
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$port"
    }
    $stdout = Join-Path $profile 'stdout'
    $preview = Start-Process -FilePath $PreviewExe -ArgumentList '--iframe-player-smoke' -WorkingDirectory $profile `
        -Environment $environment -RedirectStandardOutput $stdout `
        -RedirectStandardError (Join-Path $profile 'stderr') -PassThru

    $stage = 'listener-ownership'
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt 20 -and !$preview.HasExited) {
        $listenerOwner = Get-OwnedIPv4Listener $port
        if ($listenerOwner) { break }
        Start-Sleep -Milliseconds 200
    }
    $listener = if (!$listenerOwner) { 'missing' }
        elseif ($preview.HasExited -or (Get-OwnedIPv4Listener $port) -ne $listenerOwner) { 'closed' }
        else { 'verified' }

    $stage = 'comparison'
    # Connect as soon as the listener is verified, without waiting for the app's ready event.
    $reports = @(& node.exe $probe $(if ($listener -ceq 'verified') { $port } else { 0 }) (Join-Path $root 'edge') 2>$null)
    if ($LASTEXITCODE -ne 0 -or $reports.Count -ne 1 -or $reports[0].Length -gt 1500 -or
        $reports[0] -cnotmatch '^PEAR_WINDOWS_PLAYBACK_COMPARISON [\w\-":{},]+$') {
        throw 'probe-output'
    }
    $report = $reports[0].Substring($prefix.Length) | ConvertFrom-Json -AsHashtable
    $markers = @(Get-Content -LiteralPath $stdout -TotalCount 128 -ErrorAction SilentlyContinue)
    $report.pear.native = [ordered]@{
        listener = $listener
        running = !$preview.HasExited
        queueReady = $markers -ccontains 'PEAR_QUEUE_READY'
        transportReady = $markers -ccontains 'PEAR_QUEUE_TRANSPORT_READY'
    }
    $prefix + ($report | ConvertTo-Json -Compress -Depth 5)
} catch {
    "PEAR_WINDOWS_PLAYBACK_COMPARISON $stage-failed"
    exit 1
} finally {
    try {
        if ($null -ne $preview) {
            if (!$preview.HasExited -and (!$preview.CloseMainWindow() -or !$preview.WaitForExit(3000))) {
                if (!$preview.HasExited) { $preview.Kill($true) }
            }
            if (!$preview.WaitForExit(5000)) { throw 'preview-exit' }
            $preview.Dispose()
        }
        if ($listenerOwner -and (Get-OwnedWebView $listenerOwner)) {
            Stop-Process -Id $listenerOwner -Force
        }
        for ($attempt = 0; $attempt -lt 3 -and (Test-Path -LiteralPath $root); $attempt++) {
            Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $root) { Start-Sleep -Milliseconds 300 }
        }
        if (Test-Path -LiteralPath $root) { throw 'profile-cleanup' }
    } catch {
        throw 'Windows playback comparison cleanup failed.'
    }
}
