$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$ProgressPreference = 'SilentlyContinue'

if ($env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:GITHUB_REPOSITORY -cne 'deruta74/pear-desktop' -or
    $env:GITHUB_REF -cne 'refs/heads/experiment/rust-windows-qa' -or
    $env:GITHUB_SHA -cnotmatch '^[0-9a-f]{40}$' -or !$env:RUNNER_TEMP) {
    throw 'Unexpected Windows playback QA environment.'
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$root = Join-Path $env:RUNNER_TEMP "pear-iframe-playback-$([guid]::NewGuid().ToString('N'))"
$source = Join-Path $root 'source'
$profile = Join-Path $root 'profile'
$webviewProfile = Join-Path $profile 'WebView2'
$log = Join-Path $env:RUNNER_TEMP 'pear-windows-qa/qa.log'
$preview = $null
$listenerOwner = $null
$registeredWorktree = $false
$queueReady = $false
$transportReady = $false
$stage = 'diagnostic-setup'
$exitCode = 1

function Get-OwnedWebView([int] $processId) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    return $candidate.Name -ieq 'msedgewebview2.exe' -and $candidate.CommandLine -and
        $candidate.CommandLine.Contains($webviewProfile, [StringComparison]::OrdinalIgnoreCase)
}

try {
    $null = New-Item -ItemType Directory -Path $root, $profile
    $stage = 'diagnostic-source'
    & git -C $repo worktree add --detach $source $env:GITHUB_SHA *> $null
    if ($LASTEXITCODE -ne 0) { throw 'worktree' }
    $registeredWorktree = $true
    & git -C $source apply (Join-Path $PSScriptRoot 'windows-iframe-playback-qa.patch') *> $null
    if ($LASTEXITCODE -ne 0) { throw 'overlay' }
    $stage = 'diagnostic-build'
    $target = 'x86_64-pc-windows-msvc'
    $env:CARGO_TARGET_DIR = Join-Path $root 'cargo-target'
    $manifest = Join-Path $source 'experiments/rust-desktop/Cargo.toml'
    & rustup run "stable-$target" cargo build --locked --manifest-path $manifest --target $target `
        --features windows-iframe-playback-qa -p pear-desktop-preview *> $null
    if ($LASTEXITCODE -ne 0) { throw 'build' }

    $stage = 'playwright-install'
    & npm.cmd install --prefix $root --cache (Join-Path $root 'npm-cache') `
        --registry 'https://registry.npmjs.org/' --ignore-scripts --no-audit --no-fund `
        --no-package-lock --no-progress --fetch-retries=0 --fetch-timeout=20000 playwright-core@1.61.1 *> $null
    if ($LASTEXITCODE -ne 0) { throw 'playwright' }
    $script = Join-Path $root 'probe.cjs'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-iframe-playback-qa.cjs') -Destination $script

    $stage = 'port-allocation'
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
    $rawOut = Join-Path $profile 'stdout.log'
    $environment = @{
        PEAR_PREVIEW_QUEUE_DIR = $profile
        PEAR_PREVIEW_SMOKE_CDP_PORT = $port.ToString([Globalization.CultureInfo]::InvariantCulture)
        PEAR_YOUTUBE_API_KEY_FILE = $null
        WEBVIEW2_USER_DATA_FOLDER = $null
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $null
        WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER = $null
        WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER = $null
    }
    $exe = Join-Path $env:CARGO_TARGET_DIR "$target/debug/pear-desktop-preview.exe"
    $preview = Start-Process -FilePath $exe -ArgumentList '--iframe-player-smoke' -WorkingDirectory $profile `
        -Environment $environment -RedirectStandardOutput $rawOut `
        -RedirectStandardError (Join-Path $profile 'stderr.log') -PassThru

    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt 45) {
        $stage = 'queue-transport-readiness'
        if ($preview.HasExited) { throw 'preview-exited' }
        $lines = Get-Content -LiteralPath $rawOut -TotalCount 128
        $queueReady = $lines -ccontains 'PEAR_QUEUE_READY'
        $transportReady = $lines -ccontains 'PEAR_QUEUE_TRANSPORT_READY'
        if ($null -eq $listenerOwner) {
            $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
            if ($listeners.Count -gt 0) {
                $stage = 'endpoint-ownership'
                $owners = @($listeners.OwningProcess | Sort-Object -Unique)
                if ($owners.Count -ne 1 -or !(Get-OwnedWebView $owners[0])) { throw 'owner' }
                $listenerOwner = $owners[0]
                if ($listeners.LocalAddress | Where-Object { $_ -cnotin '127.0.0.1', '::1' }) {
                    $stage = 'endpoint-binding'
                    throw 'binding'
                }
            }
        }
        if ($queueReady -and $transportReady -and $null -ne $listenerOwner) { break }
        Start-Sleep -Milliseconds 250
    }
    if ($null -eq $listenerOwner) {
        $stage = 'endpoint-unavailable'
        throw 'endpoint'
    }
    if (!$queueReady -or !$transportReady) {
        $stage = 'queue-transport-readiness'
        $exitCode = 2
        throw 'readiness'
    }

    $stage = 'native-window'
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PearIframePlaybackWindow {
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out int value, int size);
    public static bool IsCloaked(IntPtr window) =>
        DwmGetWindowAttribute(window, 14, out int value, sizeof(int)) == 0 && value != 0;
}
'@
    $preview.Refresh()
    $window = $preview.MainWindowHandle
    if ($window -eq [IntPtr]::Zero -or $preview.MainWindowTitle -cne 'Pear Desktop Rust Preview' -or
        ![PearIframePlaybackWindow]::IsWindowVisible($window) -or [PearIframePlaybackWindow]::IsIconic($window) -or
        [PearIframePlaybackWindow]::IsCloaked($window) -or
        [PearIframePlaybackWindow]::MonitorFromWindow($window, 0) -eq [IntPtr]::Zero) {
        $exitCode = 2
        throw 'window'
    }

    $stage = 'probe-output'
    $lines = @(& node.exe $script $port 2>$null)
    $probeExit = $LASTEXITCODE
    if ($lines.Count -ne 1 -or $lines[0] -cnotmatch '^PEAR_WINDOWS_IFRAME_PLAYBACK status=(pass|fail|inconclusive) reason=[a-z][a-z0-9-]{0,47}$') {
        throw 'output'
    }
    $expectedExit = @{ pass = 0; fail = 1; inconclusive = 2 }[$Matches[1]]
    if ($probeExit -ne $expectedExit) { throw 'exit-code' }
    $report = $lines[0]
    $exitCode = $probeExit
} catch {
    $status = if ($exitCode -eq 2) { 'inconclusive' } else { 'fail' }
    $report = "PEAR_WINDOWS_IFRAME_PLAYBACK status=$status reason=$stage"
} finally {
    try {
        if ($null -ne $preview) {
            if (!$preview.HasExited -and (!$preview.CloseMainWindow() -or !$preview.WaitForExit(3000))) {
                if (!$preview.HasExited) { $preview.Kill($true) }
            }
            if (!$preview.WaitForExit(5000)) { throw 'process-cleanup' }
            $preview.Dispose()
        }
        if ($null -ne $listenerOwner -and (Get-OwnedWebView $listenerOwner)) {
            Stop-Process -Id $listenerOwner -Force
        }
        if ($registeredWorktree) {
            & git -C $repo worktree remove --force $source *> $null
            if ($LASTEXITCODE -ne 0) { throw 'worktree-cleanup' }
        }
        for ($attempt = 0; $attempt -lt 3 -and (Test-Path -LiteralPath $root); $attempt++) {
            Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $root) { Start-Sleep -Milliseconds 300 }
        }
        if (Test-Path -LiteralPath $root) { throw 'profile-cleanup' }
    } catch {
        $report = 'PEAR_WINDOWS_IFRAME_PLAYBACK status=fail reason=cleanup'
        $exitCode = 1
    }
}

"PEAR_WINDOWS_IFRAME_PLAYBACK_READINESS queue=$($queueReady.ToString().ToLowerInvariant()) transport=$($transportReady.ToString().ToLowerInvariant())" |
    Tee-Object -FilePath $log -Append
$report | Tee-Object -FilePath $log -Append
if ($exitCode -eq 2) {
    Write-Output '::warning::Windows IFrame playback probe was inconclusive.'
    exit 0
}
exit $exitCode
