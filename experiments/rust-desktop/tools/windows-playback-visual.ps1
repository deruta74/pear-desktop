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
$checkpoints = Join-Path $fixtureProfile 'visual-checkpoints'
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
$previewId = $null
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
$debugPort = $null
$registeredSource = $false
$stage = 'setup'
$published = $false
$checkpointFiles = [ordered]@{
    entry = 'entry'
    controlsRequest = 'controls-request'
    controlsFinished = 'controls-finished'
    loopEntered = 'loop-entered'
    queueReady = 'queue-ready'
    wrapperFinished = 'wrapper-finished'
    transportReady = 'transport-ready'
    playbackAdvanced = 'playback-advanced'
}
$stdoutMarkers = [ordered]@{
    entry = 'PEAR_WINDOWS_VISUAL_ENTRY'
    queueReady = 'PEAR_QUEUE_READY'
    wrapperFinished = 'PEAR_WINDOWS_VISUAL_WRAPPER_FINISHED'
    transportReady = 'PEAR_QUEUE_TRANSPORT_READY'
    playbackAdvanced = 'PEAR_WINDOWS_VISUAL_PLAYBACK_ADVANCED'
}
$report = [ordered]@{
    fixture = 'official-youtube-demo'
    windowVerified = $false
    profileVerified = $false
    webViewVersion = 'unavailable'
    queueReady = $false
    wrapperFinished = $false
    transportReady = $false
    playGlyphVerified = $false
    cdpListenerVerified = $false
    click = 'unavailable'
    cdpMediaPresent = $false
    cdpMediaPlaying = $false
    cdpMediaAdvanced = $false
    playback = 'inconclusive'
    settle = 'unavailable'
    readyBy25 = $null
    at25 = $null
    native = [ordered]@{}
    stdout = [ordered]@{ observed = $false; prefixLimitReached = $false }
    clientWidth = 0
    clientHeight = 0
    capture = 'unavailable'
}

function Get-FixtureWebViewProcess([int] $parentId, [int] $session) {
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentId AND Name = 'msedgewebview2.exe'"
    foreach ($child in $children) {
        if ($child.SessionId -eq $session -and $child.CommandLine -match $profilePattern) {
            [uint]$child.ProcessId
        }
    }
}

function Get-FixtureDebuggerStage([int] $port, [uint] $owner) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if (!$listeners.Count) { return 'cdp-listener-unavailable' }
    if ($listeners | Where-Object { $_.OwningProcess -ne $owner }) { return 'cdp-listener-owner' }
    if ($listeners.LocalAddress -cnotcontains '127.0.0.1' -or
        ($listeners | Where-Object { $_.LocalAddress -cnotin '127.0.0.1', '::1' })) {
        return 'cdp-listener-binding'
    }
    return 'cdp-listener-verified'
}

function Update-Readiness {
    $markers = @(if (Test-Path -LiteralPath $stdout -PathType Leaf) {
        Get-Content -LiteralPath $stdout -TotalCount 128
    })
    $report.stdout.observed = $markers.Count -gt 0
    $report.stdout.prefixLimitReached = $markers.Count -eq 128
    foreach ($name in $stdoutMarkers.Keys) {
        $report.stdout[$name] = $markers -ccontains $stdoutMarkers[$name]
    }
    foreach ($name in $checkpointFiles.Keys) {
        $report.native[$name] = Test-Path -LiteralPath (Join-Path $checkpoints $checkpointFiles[$name]) -PathType Leaf
    }
    foreach ($name in 'queueReady', 'wrapperFinished', 'transportReady') {
        $report[$name] = $report.stdout[$name] -or $report.native[$name]
    }
}

function Get-MissingFixtureReadinessStage {
    if ($report.queueReady -and $report.wrapperFinished -and $report.transportReady) { return 'ready' }
    if (!$report.native.loopEntered -and !$report.queueReady -and !$report.transportReady) {
        if (!$report.native.entry) {
            if ($report.stdout.entry) { return 'startup-checkpoints-missing' }
            return 'benchmark-entry-unobserved'
        }
        if (!$report.native.controlsRequest) { return 'pre-loop-before-controls-request' }
        return 'pre-loop-after-controls-request'
    }
    if (!$report.queueReady) {
        if (!$report.native.controlsFinished) { return 'controls-navigation-not-finished' }
        return 'controls-ipc-not-ready'
    }
    if (!$report.wrapperFinished) { return 'wrapper-navigation-not-finished' }
    return 'transport-not-ready'
}

function Get-FixtureWebViewVersion([uint] $processId) {
    try {
        $process = [Diagnostics.Process]::GetProcessById([int]$processId)
        try {
            $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($process.MainModule.FileName).ProductVersion
            if ($version -cmatch '\A[0-9]{1,6}(?:\.[0-9]{1,6}){3}\z') { return $version }
        } finally {
            $process.Dispose()
        }
    } catch {
        # The process may exit or deny metadata access before this optional read.
    }
    return 'unavailable'
}

function Get-FixtureClientImage {
    $bitmap = [Drawing.Bitmap]::new(
        $bounds.Right, $bounds.Bottom, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    try {
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([Drawing.Color]::Fuchsia)
            $memoryDc = $graphics.GetHdc()
            try {
                if (![PearFixtureWindow]::CaptureClient($window, $preview.Id, $memoryDc, $bounds)) {
                    throw 'print-window'
                }
            } finally {
                $graphics.ReleaseHdc($memoryDc)
            }
        } finally {
            $graphics.Dispose()
        }

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
        return $bitmap
    } catch {
        $bitmap.Dispose()
        throw
    }
}

function Test-PlayGlyph([Drawing.Bitmap] $bitmap) {
    $x = [PearFixtureWindow]::PlayX
    $y = [PearFixtureWindow]::PlayY
    foreach ($pixel in @($bitmap.GetPixel($x, $y), $bitmap.GetPixel($x - 4, $y - 4),
            $bitmap.GetPixel($x - 4, $y + 4))) {
        if ($pixel.R -lt 230 -or $pixel.G -lt 230 -or $pixel.B -lt 230) { return $false }
    }
    foreach ($pixel in @($bitmap.GetPixel($x - 16, $y), $bitmap.GetPixel($x + 19, $y),
            $bitmap.GetPixel($x, $y - 19), $bitmap.GetPixel($x, $y + 19))) {
        if ($pixel.R -lt 220 -or $pixel.G -gt 60 -or $pixel.B -gt 100) { return $false }
    }
    return $true
}

try {
    if (Test-Path -LiteralPath $artifact) { throw 'stale-image' }
    $null = New-Item -ItemType Directory -Path $root, $fixtureProfile, $checkpoints
    $stage = 'fixture-source'
    & git -C $repo cat-file -e "${base}^{commit}" *> $null
    if ($LASTEXITCODE -ne 0) {
        & git -C $repo fetch --no-tags --depth=1 origin $base *> $null
        if ($LASTEXITCODE -ne 0) { throw 'fixture-fetch' }
    }
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
        '--target-dir', $targetDir, '--features', 'windows-iframe-playback-qa', '-p', 'pear-desktop-preview')
    & cargo @buildArguments *> $null
    if ($LASTEXITCODE -ne 0) { throw 'fixture-build' }

    $stage = 'playwright-install'
    & npm.cmd install --prefix $root --cache (Join-Path $root 'npm-cache') `
        --registry 'https://registry.npmjs.org/' --ignore-scripts --no-audit --no-fund `
        --no-package-lock --no-progress --fetch-retries=0 --fetch-timeout=20000 playwright-core@1.61.1 *> $null
    if ($LASTEXITCODE -ne 0) { throw 'playwright-install' }
    $probeScript = Join-Path $root 'probe.cjs'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-playback-visual-cdp.cjs') -Destination $probeScript

    $stage = 'cdp-port'
    $socket = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $socket.Start()
        $debugPort = $socket.LocalEndpoint.Port
    } finally {
        $socket.Stop()
    }

    $stage = 'launch'
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-playback-visual-window.cs')
    Add-Type -AssemblyName System.Drawing.Common
    $exe = Join-Path $targetDir "$target/debug/pear-desktop-preview.exe"
    $environment = @{
        PEAR_PREVIEW_QUEUE_DIR = $fixtureProfile
        PEAR_WINDOWS_VISUAL_DIAGNOSTIC = '1'
        PEAR_PREVIEW_SMOKE_CDP_PORT = $debugPort.ToString([Globalization.CultureInfo]::InvariantCulture)
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
    $previewId = $preview.Id

    $stage = 'settle'
    $captureAfter = 55
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $readySeen = $false
    do {
        Update-Readiness
        $readinessStage = Get-MissingFixtureReadinessStage
        $elapsedSeconds = $clock.Elapsed.TotalSeconds
        if (!$readySeen -and $readinessStage -ceq 'ready') {
            $readySeen = $true
            $report.readyBy25 = $elapsedSeconds -lt 25
            $captureAfter = [Math]::Min(55, $elapsedSeconds + 3)
        }
        if ($elapsedSeconds -ge 25 -and $null -eq $report.at25) {
            if (!$readySeen) { $report.readyBy25 = $false }
            $report.at25 = [ordered]@{
                stage = $readinessStage
                queueReady = $report.queueReady
                wrapperFinished = $report.wrapperFinished
                transportReady = $report.transportReady
            }
        }
        if ($preview.HasExited -or $elapsedSeconds -ge $captureAfter) { break }
        Start-Sleep -Milliseconds 200
    } while ($true)
    $report.settle = if ($preview.HasExited) { 'process-exited' }
        elseif (!$readySeen) { 'deadline' }
        elseif ($report.readyBy25) { 'ready-by-25s' } else { 'ready-after-25s' }

    if ($preview.HasExited) {
        $stage = "preview-exited-$readinessStage"
        throw 'preview-exited'
    }
    $stage = 'preview-session'
    if ($preview.SessionId -ne $session) { throw 'unexpected-session' }
    $preview.Refresh()
    $window = $preview.MainWindowHandle
    $bounds = [PearFixtureWindow]::GetVerifiedClient($window, $preview.Id)
    $report.windowVerified = $bounds.Right -gt 0
    $report.clientWidth = $bounds.Right
    $report.clientHeight = $bounds.Bottom
    $browserProcesses = @(Get-FixtureWebViewProcess $preview.Id $session)
    $report.profileVerified = $browserProcesses.Count -eq 1
    if ($report.profileVerified) { $report.webViewVersion = Get-FixtureWebViewVersion $browserProcesses[0] }
    $stage = 'window-ownership'
    if (!$report.windowVerified) { throw 'unverified-window' }
    $stage = 'isolated-profile'
    if (!$report.profileVerified) { throw 'unverified-profile' }
    if ($readinessStage -cne 'ready') {
        $stage = $readinessStage
        throw 'insufficient-fixture-evidence'
    }

    $stage = 'play-glyph'
    if ($bounds.Right -ne [PearFixtureWindow]::KnownClientWidth -or
        $bounds.Bottom -ne [PearFixtureWindow]::KnownClientHeight) { throw 'unexpected-client-size' }
    $bitmap = Get-FixtureClientImage
    try {
        $report.playGlyphVerified = Test-PlayGlyph $bitmap
    } finally {
        $bitmap.Dispose()
    }
    if (!$report.playGlyphVerified) { throw 'play-glyph-not-found' }

    $stage = 'cdp-profile'
    $browser = $browserProcesses[0]
    $browserProcesses = @(Get-FixtureWebViewProcess $preview.Id $session)
    $report.profileVerified = $browserProcesses.Count -eq 1 -and $browserProcesses[0] -eq $browser
    if ($preview.HasExited -or !$report.profileVerified) { throw 'fixture-click-profile-lost' }
    $stage = 'cdp-window'
    $verifiedBounds = [PearFixtureWindow]::GetVerifiedClient($window, $preview.Id)
    if ($verifiedBounds.Right -ne $bounds.Right -or $verifiedBounds.Bottom -ne $bounds.Bottom) {
        throw 'fixture-window-changed'
    }
    $stage = Get-FixtureDebuggerStage $debugPort $browser
    if ($stage -cne 'cdp-listener-verified') { throw 'unverified-debug-listener' }
    $report.cdpListenerVerified = $true

    $stage = 'cdp-probe-output'
    $lines = @(& node.exe --no-use-env-proxy $probeScript $debugPort 2>$null)
    $probeExit = $LASTEXITCODE
    if ($lines.Count -ne 1) { throw 'unexpected-probe-output' }
    $probe = $lines[0] | ConvertFrom-Json -AsHashtable
    $probeStages = @('endpoint-metadata', 'cdp-connect', 'fixture-panes', 'exact-official-frame',
        'wrapper-not-visible', 'iframe-geometry-mismatch', 'iframe-target-mismatch',
        'iframe-center-click', 'clock-signal', 'clicked',
        'invalid-port', 'probe-bootstrap', 'cdp-deadline')
    if ($probe -isnot [System.Collections.IDictionary] -or $probe.Count -ne 4 -or
        $probe.stage -isnot [string] -or $probe.stage -cnotin $probeStages -or $probe.mediaPresent -isnot [bool] -or
        $probe.mediaPlaying -isnot [bool] -or $probe.mediaAdvanced -isnot [bool]) {
        throw 'unexpected-probe-output'
    }
    $report.click = $probe.stage
    $report.cdpMediaPresent = $probe.mediaPresent
    $report.cdpMediaPlaying = $probe.mediaPlaying
    $report.cdpMediaAdvanced = $probe.mediaAdvanced
    $stage = $probe.stage
    if ($probeExit -ne 0 -or $probe.stage -cne 'clicked' -or
        !(Test-Path -LiteralPath (Join-Path $fixtureProfile 'visual-play-clicked') -PathType Leaf)) {
        throw 'fixture-click-unverified'
    }

    $stage = 'playback-clock'
    $clock.Restart()
    while ($clock.Elapsed.TotalSeconds -lt 25 -and !$preview.HasExited) {
        Update-Readiness
        if ($report.stdout.playbackAdvanced -or $report.native.playbackAdvanced) {
            $report.playback = 'advanced'
            break
        }
        Start-Sleep -Milliseconds 200
    }
    if ($report.playback -ne 'advanced') { throw 'playback-clock-not-verified' }

    $stage = 'capture'
    $bitmap = Get-FixtureClientImage
    try {
        $bitmap.Save($stagedPng, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $bitmap.Dispose()
    }

    $stage = 'confirm'
    $browserProcesses = @(Get-FixtureWebViewProcess $preview.Id $session)
    $report.profileVerified = $browserProcesses.Count -eq 1 -and $browserProcesses[0] -eq $browser
    $report.cdpListenerVerified = (Get-FixtureDebuggerStage $debugPort $browser) -ceq 'cdp-listener-verified'
    if ($preview.HasExited -or !$report.profileVerified -or !$report.cdpListenerVerified) {
        throw 'profile-lost'
    }
    Move-Item -LiteralPath $stagedPng -Destination $artifact
    $published = $true
    $report.capture = 'client-only'
} catch {
    $report.capture = "$stage-failed"
    throw 'Windows playback visual diagnostic did not complete.'
} finally {
    try {
        if ($null -ne $preview) {
            if (!$preview.HasExited -and (!$preview.CloseMainWindow() -or !$preview.WaitForExit(3000))) {
                if (!$preview.HasExited) { $preview.Kill($true) }
            }
            if (!$preview.WaitForExit(5000)) { throw 'preview-exit' }
            $preview.Dispose()
        }
        if ($null -ne $debugPort -and $null -ne $previewId) {
            $owners = @(Get-FixtureWebViewProcess $previewId $session)
            $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $debugPort -ErrorAction SilentlyContinue)
            foreach ($owner in ($listeners.OwningProcess | Sort-Object -Unique)) {
                if ($owner -in $owners) {
                    Stop-Process -Id $owner -ErrorAction SilentlyContinue
                    Wait-Process -Id $owner -Timeout 3 -ErrorAction SilentlyContinue
                }
            }
            $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $debugPort -ErrorAction SilentlyContinue)
            if ($listeners | Where-Object { $_.OwningProcess -in $owners }) { throw 'listener-cleanup' }
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
