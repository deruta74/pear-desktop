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

function Get-PlaybackWindowState([IntPtr] $window) {
    if ($window -eq [IntPtr]::Zero) { return 'missing' }
    if (![PearPlaybackWindow]::IsWindowVisible($window)) { return 'hidden' }
    if ([PearPlaybackWindow]::IsIconic($window)) { return 'minimized' }
    if ([PearPlaybackWindow]::IsCloaked($window)) { return 'cloaked' }
    if ([PearPlaybackWindow]::MonitorFromWindow($window, 0) -eq [IntPtr]::Zero) { return 'offscreen' }
    return 'onscreen'
}

try {
    $stage = 'window-api'
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class PearPlaybackWindow {
    private delegate bool WindowCallback(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder title, int length);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attribute, out int value, int size);

    public static IntPtr Find(uint processId) {
        IntPtr window = IntPtr.Zero;
        EnumWindows((hwnd, data) => {
            GetWindowThreadProcessId(hwnd, out uint owner);
            if (owner != processId) return true;
            var title = new StringBuilder(64);
            GetWindowText(hwnd, title, title.Capacity);
            if (!String.Equals(title.ToString(), "Pear Desktop Rust Preview", StringComparison.Ordinal)) return true;
            window = hwnd;
            return false;
        }, IntPtr.Zero);
        return window;
    }

    public static bool IsCloaked(IntPtr hwnd) {
        const uint cloaked = 14;
        return DwmGetWindowAttribute(hwnd, cloaked, out int value, sizeof(int)) == 0 && value != 0;
    }
}
'@
    $stage = 'setup'
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

    $stage = 'window-state'
    $window = [IntPtr]::Zero
    $clock.Restart()
    while ($clock.Elapsed.TotalSeconds -lt 3 -and $window -eq [IntPtr]::Zero) {
        $window = [PearPlaybackWindow]::Find($preview.Id)
        if ($window -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 200 }
    }
    $windowBefore = Get-PlaybackWindowState $window
    if ($windowBefore -cin 'hidden', 'minimized', 'offscreen') {
        $null = [PearPlaybackWindow]::ShowWindowAsync($window, 9) # SW_RESTORE
        Start-Sleep -Milliseconds 250
        if ((Get-PlaybackWindowState $window) -ceq 'offscreen') {
            # Primary monitor coordinates, preserving size and z-order.
            $null = [PearPlaybackWindow]::SetWindowPos($window, [IntPtr]::Zero, 100, 100, 0, 0, 0x55)
            Start-Sleep -Milliseconds 250
        }
    }
    $windowAfter = Get-PlaybackWindowState $window
    "PEAR_WINDOWS_PLAYBACK_WINDOW before=$windowBefore after=$windowAfter" | Tee-Object -FilePath $qaLog -Append

    $stage = 'probe-process'
    $lines = @(& node.exe $script $port $windowAfter 2>$null)
    $probeExit = $LASTEXITCODE
    if ($lines.Count -lt 1 -or $lines.Count -gt 2) { throw 'probe-output' }
    if ($lines.Count -eq 2) {
        if ($lines[0] -cnotmatch '^PEAR_WINDOWS_PLAYBACK_DOM visible=(true|false) viewport=(true|false) player=(true|false) center=(true|false) toolbar=(true|false)$') {
            throw 'probe-output'
        }
        $lines[0] | Tee-Object -FilePath $qaLog -Append
    }
    $report = $lines[-1]
    if ($report -cnotmatch '^PEAR_WINDOWS_PLAYBACK status=(pass|fail|inconclusive) reason=[a-z][a-z0-9-]{0,47}$') {
        throw 'probe-output'
    }
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
