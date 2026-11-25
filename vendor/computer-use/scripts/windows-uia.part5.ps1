function Initialize-ChromiumPages {
  param([object]$Window, [object]$Traversal)
  if ($null -eq $Window) { return $null }
  $renderers = @([WindowsComputerUseNative]::ChromiumRenderers([IntPtr]([int64]$Window.nativeWindowHandle), 8))
  if ($renderers.Count -eq 0) { return $null }
  foreach ($key in @($script:ChromiumPages.Keys)) {
    if (-not [WindowsComputerUseNative]::IsWindow([IntPtr]([int64]$key))) { $script:ChromiumPages.Remove($key) }
  }
  $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  $status = [ordered]@{ renderers = $renderers.Count; ready = 0; waitedMs = 0; state = 'ready' }
  $pending = New-Object System.Collections.Generic.List[object]
  $responsive = New-Object System.Collections.Generic.List[object]
  foreach ($renderer in $renderers) {
    $owner = [uint32]0
    [void][WindowsComputerUseNative]::GetWindowThreadProcessId($renderer, [ref]$owner)
    $key = [string]$renderer.ToInt64()
    $page = $script:ChromiumPages[$key]
    if ($null -eq $page -or $page.processId -ne $owner) {
      $page = @{ processId = $owner; firstSeen = $now; ready = $false }
      $script:ChromiumPages[$key] = $page
    }
    # WebView2 and CEF renderers can belong to a process other than the window's.
    if (-not [WindowsComputerUseNative]::IsResponsive($renderer)) {
      $status["unresponsive"] = 1 + [int]$status["unresponsive"]
      continue
    }
    $responsive.Add($renderer)
    # A provider that refuses the read (an elevated app behind UIPI, a closing
    # page) gains nothing from waiting; the next observation probes it again.
    try { $ready = Test-ChromiumPage $renderer } catch { continue }
    if ($ready) { $page.ready = $true; $status.ready++; continue }
    # A page tree that disappeared (Chromium turned accessibility off again)
    # starts a new warm-up period.
    if ($page.ready) { $page.ready = $false; $page.firstSeen = $now }
    $pending.Add(@{ renderer = $renderer; page = $page })
  }
  # Measured on Electron 44: the page tree arrives 50-450 ms after the read.
  $start = $Traversal.watch.ElapsedMilliseconds
  $limit = [Math]::Min(1500, [int]($Traversal.budgetMs / 2))
  while ($true) {
    $waiting = @($pending | Where-Object { -not $_.page.ready -and ($now - $_.page.firstSeen) -lt 30000 })
    if ($waiting.Count -eq 0 -or ($Traversal.watch.ElapsedMilliseconds - $start) -ge $limit) { break }
    Start-Sleep -Milliseconds 50
    foreach ($item in $waiting) {
      if (Invoke-Safe { Test-ChromiumPage $item.renderer } $false) { $item.page.ready = $true; $status.ready++ }
    }
  }
  $status.waitedMs = [int]($Traversal.watch.ElapsedMilliseconds - $start)
  if ($status.ready -lt $renderers.Count) {
    $starting = @($pending | Where-Object { -not $_.page.ready -and ($now - $_.page.firstSeen) -lt 30000 }).Count
    $status.state = if ($status.ready -gt 0) { 'partial' } elseif ($starting -gt 0) { 'starting' } else { 'unavailable' }
  }
  # Report the content separately from the attachment above, and only for
  # renderers whose provider answered: a page that is still building has no
  # content reading yet, which is different from a page measured as empty.
  # ready, state and waitedMs keep their meaning, so existing callers of this
  # window-scoped status see no change.
  #
  # The walk gets a budget of its own -- at most 250 ms and at most a tenth of
  # treeTimeoutMs -- so the tree the caller asked for keeps most of the budget,
  # and the loop stops at the first renderer that carries text.
  $contentLimit = [Math]::Min(250, [int]($Traversal.budgetMs / 10))
  $measured = 0
  $foundText = $false
  foreach ($renderer in $responsive) {
    $facts = Invoke-Safe { Get-ChromiumPageContent $renderer $contentLimit } $null
    if ($null -eq $facts) { continue }
    if ($facts.hasText) { $foundText = $true; break }
    if (-not $facts.truncated) { $measured++ }
  }
  # contentState reports what was measured, never a guess: a walk cut short by
  # its time limit or the node cap, a refused provider and a page tree that has
  # not arrived all report unknown instead of claiming the page is empty.
  $status["contentState"] = if ($foundText) { 'content' } elseif ($measured -eq $renderers.Count) { 'empty' } else { 'unknown' }
  return $status
}

function Test-GeckoPageTree {
  param([IntPtr]$Hwnd)
  $el = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
  if ($null -eq $el) { return $false }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $docCond = New-Object System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Document)
  $doc = $el.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $docCond)
  if ($null -ne $doc -and $null -ne $walker.GetFirstChild($doc)) { return $true }
  $child = $walker.GetFirstChild($el)
  $steps = 0
  while ($null -ne $child -and $steps -lt 64) {
    $steps++
    $ct = Invoke-Safe { $child.Current.ControlType } $null
    if ($ct -eq [System.Windows.Automation.ControlType]::Document) { return ($null -ne $walker.GetFirstChild($child)) }
    if ($ct -eq [System.Windows.Automation.ControlType]::Pane -or $ct -eq [System.Windows.Automation.ControlType]::Group) {
      $d2 = $walker.GetFirstChild($child)
      if ($null -ne $d2) {
        $d3 = $walker.GetFirstChild($d2)
        if ($null -ne $d3 -and $null -ne $walker.GetFirstChild($d3)) { return $true }
      }
    }
    $child = $walker.GetNextSibling($child)
  }
  return $false
}

$script:GeckoPages = @{}
function Initialize-GeckoPages {
  param([object]$Window, [object]$Traversal)
  if ($null -eq $Window -or $Window.className -ne 'MozillaWindowClass') { return $null }
  $hwnd = [IntPtr]([int64]$Window.nativeWindowHandle)
  if ($hwnd -eq [IntPtr]::Zero -or -not [WindowsComputerUseNative]::IsWindow($hwnd)) { return $null }
  if (-not [WindowsComputerUseNative]::IsResponsive($hwnd)) { return $null }
  if ($null -eq $script:GeckoPages) { $script:GeckoPages = @{} }
  $owner = [uint32]0
  [void][WindowsComputerUseNative]::GetWindowThreadProcessId($hwnd, [ref]$owner)
  $key = [string]$hwnd.ToInt64()
  $entry = $script:GeckoPages[$key]
  if ($null -eq $entry -or $entry.processId -ne $owner) {
    $entry = @{ processId = $owner; ready = $false }
    $script:GeckoPages[$key] = $entry
  }
  if ($entry.ready -and (Invoke-Safe { Test-GeckoPageTree $hwnd } $false)) {
    return @{ state = 'ready'; waitedMs = 0 }
  }
  $entry.ready = $false
  [UIntPtr]$wakeRes = [UIntPtr]::Zero
  try { [void][WindowsComputerUseNative]::SendMessageTimeout($hwnd, 0x003D, [UIntPtr]::Zero, [IntPtr](-4), 3, 500, [ref]$wakeRes) } catch { }
  if (Invoke-Safe { Test-GeckoPageTree $hwnd } $false) {
    $entry.ready = $true
    return @{ state = 'ready'; waitedMs = 0 }
  }
  $start = $Traversal.watch.ElapsedMilliseconds
  $limit = [Math]::Min(2500, [int]($Traversal.budgetMs / 2))
  while (($Traversal.watch.ElapsedMilliseconds - $start) -lt $limit) {
    Start-Sleep -Milliseconds 80
    if (Invoke-Safe { Test-GeckoPageTree $hwnd } $false) {
      $entry.ready = $true
      return @{ state = 'ready'; waitedMs = [int]($Traversal.watch.ElapsedMilliseconds - $start) }
    }
  }
  return @{ state = 'starting'; waitedMs = [int]($Traversal.watch.ElapsedMilliseconds - $start) }
}

function Get-TreeResult {
  param([string]$Scope, [int]$MaxDepth, [int]$MaxNodes, [object]$InputObject = $null)
  $script:ElementGeneration++
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $viewMode = Get-ViewMode $InputObject "control"
  $includeOffscreen = [bool](Get-Prop $InputObject "includeOffscreen" $false)
  $detailLevel = Get-DetailLevel $InputObject "compact"
  $budgetMs = [int](Get-Prop $InputObject "treeTimeoutMs" 5000)
  if ($budgetMs -lt 100 -or $budgetMs -gt 30000) { throw "treeTimeoutMs must be between 100 and 30000." }
  $window = Get-ObservationWindow $InputObject $Scope
  $script:ObservationOwner = $window
  $script:NativeOwners = @{}
  if ($Scope -eq 'desktop') {
    foreach ($native in (Get-NativeWindowList -IncludeInvisible $true -MaxWindows 4096)) { $script:NativeOwners[[string]$native.nativeWindowHandle] = $native }
  }
  $responsive = Get-WindowResponsive $window
  $cache = New-ElementCacheRequest $detailLevel
  $isGecko = ($null -ne $window -and $window.className -eq 'MozillaWindowClass')
  $walker = New-Object System.Windows.Automation.TreeWalker -ArgumentList (Get-ViewCondition $viewMode $includeOffscreen -SkipOffscreenFilter:$isGecko)
  $traversal = @{watch=$stopwatch; budgetMs=$budgetMs; cache=$cache; walker=$walker; reason=$null; error=$null; browserLayout=($Scope -ne 'desktop'); pruneGeckoOffscreen=($isGecko -and -not $includeOffscreen); countedDepth=0; structuralDepth=0}
  $tree = $null
  $count = 0
  $pages = $null
  if ($null -ne $responsive -and -not $responsive) {
    $traversal.reason = "targetUnresponsive"
  } else {
    $root = Get-ScopeRoot $Scope $InputObject
    Update-WindowCache $root
    Update-WindowIdentity $InputObject $root
    if ($Scope -ne 'desktop') {
      $pages = Initialize-ChromiumPages $window $traversal
      if ($null -eq $pages -and $isGecko) { [void](Initialize-GeckoPages $window $traversal) }
    }
    try {
      if (Test-TreeBudget $traversal) {
        $root = $root.GetUpdatedCache($cache)
        $prefix = if ($Scope -eq "desktop") { "root" } else { "active" }
        $tree = Convert-Tree -Element $root -Path $prefix -Depth 0 -MaxDepth $MaxDepth -Count ([ref]$count) -MaxNodes $MaxNodes -ViewMode $viewMode -IncludeOffscreen $includeOffscreen -DetailLevel $detailLevel -Traversal $traversal -Owner $window
      }
    } catch {
      $traversal.reason = "providerError"
      $traversal.error = $_.Exception.Message
    }
  }
  if ($null -ne $traversal.reason -and $traversal.reason -ne "targetUnresponsive") { $responsive = Get-WindowResponsive $window }
  $stopwatch.Stop()
  $script:ObservationOwner = $null
  $result = [ordered]@{
    ok = $true; scope = $Scope; viewMode = $viewMode; includeOffscreen = $includeOffscreen
    detailLevel = $detailLevel; nodeCount = $count; truncated = ($null -ne $traversal.reason)
    countedDepth = $traversal.countedDepth; structuralDepth = $traversal.structuralDepth
    durationMs = [int]$stopwatch.ElapsedMilliseconds; tree = $tree
    treeTimeoutMs = $budgetMs; targetResponsive = $responsive
  }
  if ($null -ne $window -and $null -ne $script:WindowCache -and $script:WindowCache.ContainsKey([string]$window.nativeWindowHandle)) {
    $result['windowObservation']=$script:WindowCache[[string]$window.nativeWindowHandle]
  }
  if ($null -ne $pages) { $result["webContent"] = $pages }
  if ($null -ne $traversal.reason) {
    $result["truncationReason"] = $traversal.reason
    if ($traversal.reason -ne "maxNodes") {
      $result["warning"] = "UIA traversal stopped ($($traversal.reason)). Avoid repeated tree calls; check the target window and use screenshot/ocr when appropriate. A single synchronous provider call can exceed treeTimeoutMs."
    }
    if ($null -ne $traversal.error) { $result["providerError"] = $traversal.error }
  }
  return $result
}

# ============================================================================
# Action dispatch (shared by one-shot and persistent modes)
# ============================================================================

function Resolve-LaunchTarget {
  param([string]$Target)
  $targetValue = [Environment]::ExpandEnvironmentVariables($Target.Trim())
  if ([string]::IsNullOrWhiteSpace($targetValue) -or $targetValue -match '[\x00-\x1f]') { throw 'LAUNCH_INVALID_TARGET: supply an executable, shortcut, installed app name or AppUserModelID.' }
  # Resolve files and application commands without interpreting shell syntax.
  $file = $null
  if ([IO.Path]::IsPathRooted($targetValue)) {
    if ($targetValue -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') { throw 'LAUNCH_INVALID_TARGET: supply a fully qualified absolute path, not a drive-relative or root-relative path.' }
    if (-not (Test-Path -LiteralPath $targetValue -PathType Leaf)) { throw "LAUNCH_NOT_FOUND: $targetValue" }
    $file = (Get-Item -LiteralPath $targetValue).FullName
  } elseif ($targetValue -notmatch '[/\\:]') {
    $command = Get-Command -Name $targetValue -CommandType Application -ErrorAction SilentlyContinue | Where-Object { $_.Name -ieq $targetValue -or $_.Name -ieq ($targetValue + '.exe') } | Select-Object -First 1
    if ($command) { $file = $command.Source }
    if (-not $file) {
      $exeName = if ($targetValue.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) { $targetValue } else { $targetValue + '.exe' }
      foreach ($hive in @('HKCU:', 'HKLM:')) {
        $key = Get-Item -LiteralPath ($hive + '\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\' + $exeName) -ErrorAction SilentlyContinue
        if ($key) {
          $candidate = [Environment]::ExpandEnvironmentVariables(([string]$key.GetValue('')).Trim('"'))
          if (Test-Path -LiteralPath $candidate -PathType Leaf) { $file = (Get-Item -LiteralPath $candidate).FullName; break }
        }
      }
    }
  }
  if ($file) {
    if ([IO.Path]::GetExtension($file) -notin @('.exe', '.com', '.lnk')) { throw 'LAUNCH_INVALID_TARGET: only .exe, .com and .lnk files are supported.' }
    return @{ target=$file; kind='file' }
  }
  # Exact matching prevents an ambiguous display name from launching the wrong app.
  $apps = @(Get-StartApps -ErrorAction Stop | Where-Object { $_.AppID -ieq $targetValue -or $_.Name -ieq $targetValue })
  if ($apps.Count -eq 0) { throw "LAUNCH_NOT_FOUND: '$targetValue'. Supply a full executable path or an installed AppUserModelID." }
  if ($apps.Count -ne 1) { throw "LAUNCH_AMBIGUOUS: '$targetValue' matches several installed apps; use its AppUserModelID or full executable path." }
  return @{ target=('shell:AppsFolder\' + $apps[0].AppID); kind='installed-app' }
}

function Invoke-LaunchApp {
  param([object]$InputObject)
  $rawTarget = [Environment]::ExpandEnvironmentVariables([string](Get-Prop $InputObject 'target' ''))
  if ($rawTarget -match '^[\\/]{2,}') { throw 'LAUNCH_POLICY_DENIED: network paths are not supported.' }
  $resolved = Resolve-LaunchTarget $rawTarget
  $background = $env:WCU_BACKGROUND_DESKTOP -eq '1'
  if ($background -and ($resolved.kind -ne 'file' -or [IO.Path]::GetExtension($resolved.target) -notin @('.exe','.com'))) {
    throw 'WCU_BACKGROUND_DESKTOP_LIMIT: the hidden desktop starts an application executable only. Shortcuts and installed or Store apps open on the user''s desktop (desktop:"current").'
  }
  $approved = [bool](Get-Prop $InputObject '_wcuLaunchApproved' $false)
  $arguments = [string](Get-Prop $InputObject 'arguments' '')
  $directory = [string](Get-Prop $InputObject 'workingDirectory' '')
  if ($arguments -match '[\x00\r\n]' -or $directory -match '[\x00-\x1f]') { throw 'LAUNCH_INVALID_ARGUMENTS: arguments and workingDirectory must be single-line strings.' }
  if ($directory) {
    $directory = [Environment]::ExpandEnvironmentVariables($directory)
    if ($directory -match '^[\\/]{2,}') { throw 'LAUNCH_POLICY_DENIED: network working directories are not supported.' }
    if ($directory -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))' -or -not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'LAUNCH_INVALID_DIRECTORY: supply an existing fully qualified absolute directory.' }
    $directory = (Get-Item -LiteralPath $directory).FullName
  }
  if ($resolved.kind -eq 'installed-app' -and ($arguments -or $directory)) { throw 'LAUNCH_INVALID_ARGUMENTS: AppUserModelID launches do not accept arguments or workingDirectory.' }
  # Command interpreters and script hosts run whatever their arguments say, so
  # with arguments launch_app would be a command channel the user never sees.
  # They start only without arguments; commands belong to DSH's own shell tool.
  # A shortcut is judged by the program it starts.
  if ($resolved.kind -eq 'file') {
    $program = $resolved.target
    $effectiveArguments=$arguments
    if ([IO.Path]::GetExtension($program) -ieq '.lnk') {
      $shell = $null; $link = $null
      try {
        $shell = New-Object -ComObject WScript.Shell; $link = $shell.CreateShortcut($program)
        $program = [Environment]::ExpandEnvironmentVariables([string]$link.TargetPath).Trim()
        if ([Environment]::ExpandEnvironmentVariables([string]$link.WorkingDirectory).Trim() -match '^[\\/]{2,}') { throw 'LAUNCH_POLICY_DENIED: network shortcut working directories are not supported.' }
        if ([string]$link.Arguments) { $effectiveArguments = ([string]$link.Arguments + ' ' + $arguments).Trim() }
      }
      finally { foreach ($com in @($link, $shell)) { if ($null -ne $com) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($com) } } }
      if ([string]::IsNullOrWhiteSpace($program)) {
        if (-not $approved) { throw 'WCU_APPROVAL_REQUIRED: launching shortcuts without a direct local target requires host approval.' }
      } elseif (-not [IO.Path]::IsPathRooted($program)) {
        $program = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetDirectoryName($resolved.target)) $program))
      }
    }
    if ($program -match '^[\\/]{2,}') { throw 'LAUNCH_POLICY_DENIED: network shortcut targets are not supported.' }
    if ($effectiveArguments.Trim() -and -not $approved) { throw 'WCU_APPROVAL_REQUIRED: launching with arguments requires host approval or explicit standalone configuration.' }
    $commandHosts = @('cmd', 'powershell', 'pwsh', 'wt', 'wsl', 'bash', 'sh', 'conhost', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32', 'msiexec', 'forfiles', 'schtasks', 'pcalua', 'ftp', 'python', 'pythonw', 'node', 'deno', 'bun', 'perl', 'ruby', 'php')
    $name = ([IO.Path]::GetFileNameWithoutExtension($program.TrimEnd('.', ' '))).ToLowerInvariant()
    if ($effectiveArguments.Trim() -and $name -in $commandHosts) { throw "LAUNCH_COMMAND_REFUSED: $name runs the commands in its arguments. launch_app starts command interpreters and script hosts only without arguments; run commands with DSH's own shell tool." }
  }
  $waitMs = [int](Get-Prop $InputObject 'waitMs' 1500)
  if ($waitMs -lt 0 -or $waitMs -gt 10000) { throw 'LAUNCH_INVALID_ARGUMENTS: waitMs must be 0-10000.' }
  $before = @(Get-NativeWindowList -MaxWindows 1000 | ForEach-Object { $_.ToArray() } | ForEach-Object { $_.nativeWindowHandle })
  if ($background) {
    [void](Test-Failsafe)
    # Without a folder of its own the app starts in the user's profile folder,
    # never in this plugin's: an app whose working folder is inside the plugin
    # keeps the plugin market from replacing it (mcp/update-guard.mjs).
    $working = if ($directory) { $directory } else { [Environment]::GetFolderPath('UserProfile') }
    $appPid = [WindowsComputerUseNative]::StartBackgroundProgram($resolved.target,$arguments,$working)
    if ($waitMs) { Start-Sleep -Milliseconds $waitMs }
    $observed = @(Get-NativeWindowList -MaxWindows 1000 | ForEach-Object { $_.ToArray() } | Where-Object { $before -notcontains $_.nativeWindowHandle -and $_.processId -eq $appPid })
    return [ordered]@{
      ok=$true; action='launch_app'; target=$resolved.target; launchMethod='background-desktop'; verification='dispatched'
      processId=$appPid; observedNewWindows=$observed
      note='Use list_windows to check whether the app opened a window here. Some apps reuse an existing instance.'
    }
  }
  $shellWindows = $null; $desktop = $null; $document = $null; $application = $null
  try {
    # The desktop folder view belongs to Explorer. Its ShellExecute starts the
    # application with the desktop environment/lifetime, outside the short-lived
    # tool's kill-on-close Job (#55). No elevation or breakaway flag is requested.
    $shellWindows = [Activator]::CreateInstance([Type]::GetTypeFromCLSID([Guid]'9BA05972-F6A8-11CF-A442-00A0C90A8F39'))
    $location = 0; $root = $null; $desktopHwnd = 0
    $desktop = $shellWindows.FindWindowSW([ref]$location, [ref]$root, 8, [ref]$desktopHwnd, 1)
    if ($null -eq $desktop) { throw 'The interactive Explorer desktop is unavailable.' }
    $document = $desktop.Document
    $application = $document.Application
    [void](Test-Failsafe)
    $show = if ([bool](Get-Prop $InputObject 'activate' $false)) { 1 } else { 4 }
    if ($script:WcuLowDisruption) { [WcuInputHold]::Snapshot() }
    $application.ShellExecute($resolved.target, $arguments, $directory, 'open', $show)
  } catch {
    throw ('LAUNCH_SHELL_FAILED: ' + $_.Exception.Message + ' An interactive Explorer desktop is required; the request is not retried as a tool child process.')
  } finally {
    foreach ($com in @($application, $document, $desktop, $shellWindows)) {
      if ($null -ne $com -and [Runtime.InteropServices.Marshal]::IsComObject($com)) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($com) }
    }
  }
  if ($waitMs) { Start-Sleep -Milliseconds $waitMs }
  $observed = @(Get-NativeWindowList -MaxWindows 1000 | ForEach-Object { $_.ToArray() } | Where-Object { $before -notcontains $_.nativeWindowHandle })
  $result = [ordered]@{
    ok=$true; action='launch_app'; target=$resolved.target; launchMethod='explorer-shell'; verification='dispatched'
    observedNewWindows=$observed
    note='The shell accepted the request. New windows are observations, not confirmed matches; an app may reuse an existing window or show none. Verify with list_windows/wait_for. activate=false requests no activation, but applications may activate themselves.'
  }
  # Low disruption: an app that comes forward by itself does not get the
  # user's typing; it goes to the window they were in.
  if ($script:WcuLowDisruption -and $observed.Count -and [WcuInputHold]::ArmGuard([long[]]@($observed | ForEach-Object { [int64]$_.nativeWindowHandle }), [long[]]@($observed | ForEach-Object { [int64]$_.processId }))) {
    $result['userInput'] = 'If the user types while this app is in front, the foreground goes back to their window first, until they click into it themselves.'
  }
  return $result
}

function Get-DesktopInputMutexName {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  return "Local\DSH-WCU-Input-v1-$sid"
}

function Enter-DesktopInput {
  # The session's input is shared by everything on the user's desktop. A hidden
  # desktop receives no real input, so its actions skip this lease (-Skip).
  param([switch]$Skip)
  if ($Skip) { return $null }
  # Local names isolate Windows sessions; the SID isolates users in a session.
  # Never queue or replay an input request after a competing operation.
  $mutex = New-Object System.Threading.Mutex($false, (Get-DesktopInputMutexName))
  $owned = $false
  try {
    try { $owned = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] {
      # WaitOne acquired the abandoned mutex. Its former action has an unknown
      # result, so release ownership but require this caller to observe again.
      $owned = $true
      throw 'COMPUTER_USE_PREVIOUS_INPUT_INTERRUPTED: Another input process exited unexpectedly. Observe the desktop again before acting; do not replay its input.'
    }
    if (-not $owned) { throw 'COMPUTER_USE_BUSY: Another process is operating the desktop. This input was not sent; observe again before a later action.' }
    return $mutex
  } catch {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
    throw
  }
}

function Exit-DesktopInput {
  param([object]$Lease)
  if ($null -ne $Lease) {
    try { $Lease.ReleaseMutex() } finally { $Lease.Dispose() }
  }
}

