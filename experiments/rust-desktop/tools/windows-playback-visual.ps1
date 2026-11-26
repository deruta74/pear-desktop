$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

if ($env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:RUNNER_ARCH -cne 'X64' -or $env:GITHUB_EVENT_NAME -cne 'push' -or
    $env:GITHUB_REPOSITORY -cne 'deruta74/pear-desktop' -or
    $env:GITHUB_REF -cne 'refs/heads/diagnostic/rust-windows-playback-visual' -or !$env:RUNNER_TEMP) {
    throw 'Unexpected Windows visual diagnostic environment.'
}

$base = '7262f871470cde2f981c61af769782e66cc82b27'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$root = Join-Path $env:RUNNER_TEMP "pear-visual-$([guid]::NewGuid().ToString('N'))"
$source = Join-Path $root 'source'
$fixtureProfile = Join-Path $root 'profile'
$webViewProfile = Join-Path $fixtureProfile 'WebView2'
# Chromium can append EBWebView inside the configured WebView2 folder.
$profileArgument = [regex]::Escape($webViewProfile) + '(?:\\EBWebView)?'
$profileForms = "\x22--user-data-dir=$profileArgument\x22|--user-data-dir=\x22$profileArgument\x22"
if ($webViewProfile -notmatch '\s') { $profileForms += "|--user-data-dir=$profileArgument" }
$profilePattern = "(?:^|\s)(?:$profileForms)(?:\s|$)"
$stdout = Join-Path $root 'stdout'
$stagedPng = Join-Path $root 'client.png'
$artifact = Join-Path $env:RUNNER_TEMP 'pear-windows-playback-visual.png'
$preview = $null
$registeredSource = $false
$stage = 'setup'
$published = $false
$report = [ordered]@{
    fixture = 'official-youtube-demo'
    windowVerified = $false
    profileVerified = $false
    queueReady = $false
    wrapperFinished = $false
    transportReady = $false
    settle = 'unavailable'
    clientWidth = 0
    clientHeight = 0
    capture = 'unavailable'
}

function Test-FixtureWebView([int] $parentId) {
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentId AND Name = 'msedgewebview2.exe'"
    foreach ($child in $children) {
        if ($child.CommandLine -match $profilePattern) { return $true }
    }
    return $false
}

function Update-Readiness {
    $markers = @(Get-Content -LiteralPath $stdout -TotalCount 128)
    $report.queueReady = $markers -ccontains 'PEAR_QUEUE_READY'
    $report.wrapperFinished = $markers -ccontains 'PEAR_WINDOWS_VISUAL_WRAPPER_FINISHED'
    $report.transportReady = $markers -ccontains 'PEAR_QUEUE_TRANSPORT_READY'
}

try {
    if (Test-Path -LiteralPath $artifact) { throw 'stale-image' }
    $null = New-Item -ItemType Directory -Path $root, $fixtureProfile
    $stage = 'fixture-source'
    & git -C $repo worktree add --detach $source $base *> $null
    if ($LASTEXITCODE -ne 0) { throw 'source-worktree' }
    $registeredSource = $true
    & git -C $source apply (Join-Path $PSScriptRoot 'windows-playback-visual-marker.patch') *> $null
    if ($LASTEXITCODE -ne 0) { throw 'marker-patch' }

    $stage = 'fixture-build'
    $target = 'x86_64-pc-windows-msvc'
    $targetDir = Join-Path $root 'target'
    $manifest = Join-Path $source 'experiments/rust-desktop/Cargo.toml'
    $buildArguments = @('+stable', 'build', '--locked', '--manifest-path', $manifest, '--target', $target,
        '--target-dir', $targetDir, '--features', 'benchmark', '-p', 'pear-desktop-preview')
    & cargo @buildArguments *> $null
    if ($LASTEXITCODE -ne 0) { throw 'fixture-build' }

    $stage = 'launch'
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-playback-visual-window.cs')
    Add-Type -AssemblyName System.Drawing.Common
    $exe = Join-Path $targetDir "$target/debug/pear-desktop-preview.exe"
    $environment = @{
        PEAR_PREVIEW_QUEUE_DIR = $fixtureProfile
        PEAR_YOUTUBE_API_KEY_FILE = $null
        PEAR_YOUTUBE_OAUTH_CLIENT_FILE = $null
        PEAR_PREVIEW_EXPERIMENTAL_PANEL_SWIPE = $null
        WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = $null
        WEBVIEW2_USER_DATA_FOLDER = $null
        WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER = $null
        WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER = $null
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $null
        WEBVIEW2_RELEASE_CHANNEL_PREFERENCE = $null
    }
    '{"entries":["M7lc1UVf-VE"],"current":"M7lc1UVf-VE","titles":{}}' |
        Set-Content -LiteralPath (Join-Path $fixtureProfile 'queue.json') -Encoding utf8
    $launchArguments = @{
        FilePath = $exe
        ArgumentList = '--iframe-player-smoke'
        WorkingDirectory = $fixtureProfile
        Environment = $environment
        RedirectStandardOutput = $stdout
        RedirectStandardError = Join-Path $root 'stderr'
        PassThru = $true
    }
    $preview = Start-Process @launchArguments

    $stage = 'settle'
    $captureAfter = [TimeSpan]::FromSeconds(25)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $transportSeen = $false
    while ($clock.Elapsed -lt $captureAfter -and !$preview.HasExited) {
        Update-Readiness
        if (!$transportSeen -and $report.transportReady) {
            $transportSeen = $true
            $captureAfter = [TimeSpan]::FromSeconds([Math]::Min(25, $clock.Elapsed.TotalSeconds + 3))
        }
        Start-Sleep -Milliseconds 200
    }
    Update-Readiness
    $report.settle = if ($preview.HasExited) { 'process-exited' }
        elseif ($transportSeen) { 'after-transport' } else { 'bounded-wait' }

    $stage = 'proof'
    if ($preview.HasExited -or $preview.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) {
        throw 'process-unavailable'
    }
    $preview.Refresh()
    $window = $preview.MainWindowHandle
    $bounds = [PearFixtureWindow]::GetVerifiedClient($window, $preview.Id)
    $report.windowVerified = $bounds.Right -gt 0
    $report.profileVerified = Test-FixtureWebView $preview.Id
    if (!$report.windowVerified -or !$report.profileVerified -or !$report.wrapperFinished -or !$report.queueReady) {
        throw 'insufficient-fixture-evidence'
    }
    $report.clientWidth = $bounds.Right
    $report.clientHeight = $bounds.Bottom

    $stage = 'capture'
    $bitmap = [Drawing.Bitmap]::new(
        $bounds.Right, $bounds.Bottom, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    try {
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([Drawing.Color]::Fuchsia)
            $memoryDc = $graphics.GetHdc()
            try {
                $stage = 'print-window'
                if (![PearFixtureWindow]::CaptureClient($window, $preview.Id, $memoryDc, $bounds)) {
                    throw 'print-window'
                }
            } finally {
                $graphics.ReleaseHdc($memoryDc)
            }
        } finally {
            $graphics.Dispose()
        }

        $stage = 'validate-pixels'
        $palette = [Collections.Generic.HashSet[int]]::new()
        $sentinel = [Drawing.Color]::Fuchsia.ToArgb()
        for ($column = 1; $column -lt 16; $column++) {
            for ($row = 1; $row -lt 12; $row++) {
                $sample = $bitmap.GetPixel([int]($bounds.Right * $column / 16), [int]($bounds.Bottom * $row / 12)).ToArgb()
                if ($sample -eq $sentinel) { throw 'unpainted-client' }
                $null = $palette.Add($sample)
            }
        }
        if ($palette.Count -lt 2) { throw 'uniform-client' }
        $bitmap.Save($stagedPng, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $bitmap.Dispose()
    }

    $stage = 'confirm'
    if ($preview.HasExited -or !(Test-FixtureWebView $preview.Id)) {
        $report.profileVerified = $false
        throw 'profile-lost'
    }
    Move-Item -LiteralPath $stagedPng -Destination $artifact
    $published = $true
    $report.capture = 'client-only'
} catch {
    $report.capture = "$stage-failed"
    throw 'Windows visual diagnostic did not produce a verified client screenshot.'
} finally {
    try {
        if ($null -ne $preview) {
            if (!$preview.HasExited -and (!$preview.CloseMainWindow() -or !$preview.WaitForExit(3000))) {
                if (!$preview.HasExited) { $preview.Kill($true) }
            }
            if (!$preview.WaitForExit(5000)) { throw 'preview-exit' }
            $preview.Dispose()
        }
        if ($registeredSource) {
            & git -C $repo worktree remove --force $source *> $null
            if ($LASTEXITCODE -ne 0) { throw 'worktree-cleanup' }
        }
        for ($attempt = 0; $attempt -lt 3 -and (Test-Path -LiteralPath $root); $attempt++) {
            Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $root) { Start-Sleep -Milliseconds 300 }
        }
        if (Test-Path -LiteralPath $root) { throw 'profile-cleanup' }
    } catch {
        $report.capture = 'cleanup-failed'
        if ($published) { Remove-Item -LiteralPath $artifact -Force }
        throw 'Windows visual diagnostic cleanup failed.'
    } finally {
        'PEAR_WINDOWS_PLAYBACK_VISUAL ' + ($report | ConvertTo-Json -Compress)
    }
}
