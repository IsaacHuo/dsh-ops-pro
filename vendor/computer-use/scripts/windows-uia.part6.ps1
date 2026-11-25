function Invoke-Action {
  param([string]$Action, [object]$inputObject = $null)

  $script:WcuImageData = [bool](Get-Prop $inputObject '_wcuImageData' ($env:WCU_IMAGE_MODE -ne 'file'))
  $script:WcuCornerFailsafe = [bool](Get-Prop $inputObject '_wcuCornerFailsafe' $true)
  # Set by the server: a background attempt (no indicator, no Esc stop) and the
  # operation series (host turn) this call belongs to.
  $script:WcuQuiet = [bool](Get-Prop $inputObject '_wcuQuiet' $false)
  $script:WcuSeries = Get-Prop $inputObject '_wcuSeries' $null
  $background = $env:WCU_BACKGROUND_DESKTOP -eq '1'
  # Low disruption on the user's desktop: real input holds the user's own
  # input and replays it afterwards, and a window DSH leaves in front is
  # guarded (WcuInputHold).
  $script:WcuLowDisruption = [bool](Get-Prop $inputObject '_wcuLowDisruption' $false) -and -not $background
  $script:WcuHolding = $false
  if ($background) {
    $nativeTarget = Get-Prop $inputObject 'nativeWindowHandle' $null
    if ($null -ne $nativeTarget -and [WindowsComputerUseNative]::TopLevelWindows() -notcontains [IntPtr]([long]$nativeTarget)) {
      throw 'WCU_BACKGROUND_DESKTOP_WINDOW_UNAVAILABLE: the target window is not on this background desktop.'
    }
    if ($Action -in @('move','drag','focus','activate_window') -or (Get-Prop $inputObject 'activate' $false) -or
        ($Action -eq 'element_info' -and $null -ne (Get-Prop $inputObject 'x' $null))) {
      throw 'WCU_BACKGROUND_DESKTOP_LIMIT: this action requires the input desktop.'
    }
  }
  $inputLease = $null
  try {
  if ($Action -in @('launch_app','click','double_click','move','drag','scroll','type_text','keypress','focus','invoke','set_value','activate_window','close_window','move_window') -or (Get-Prop $inputObject 'activate' $false)) {
    $inputLease = Enter-DesktopInput -Skip:$background
    $script:TakeoverProcessId = [int](Get-Prop $inputObject '_wcuTakeoverPid' 0)
    if ($env:WCU_CANCEL_EVENT) { [WindowsComputerUseNative]::SetStopListener($script:TakeoverProcessId) }
    [void](Test-Failsafe)
  }

  switch ($Action) {
    "launch_app" { return (Invoke-LaunchApp $inputObject) }
    "input_state" {
      $state = [WcuInputHold]::UserState()
      return [ordered]@{ ok = $true; action = 'input_state'; held = $state.Held; fullscreen = $state.Fullscreen; notification = $state.Notification; foreground = $state.Foreground }
    }
    "health" {
      $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
      # Health checks backend availability independently of any application's
      # UIA provider. Reading the foreground provider here can wedge a health
      # request even though native enumeration/capture remain available.
      Write-BackendStage 'health-native-window-start'
      $active = Get-ObservationWindow ([pscustomobject]@{}) -Foreground
      Update-WindowCache $active
      Write-BackendStage 'health-native-window-complete'
      return ([ordered]@{
        ok = $true
        platform = "Windows"
        powershell = $PSVersionTable.PSVersion.ToString()
        mode = if ($Persistent) { "persistent" } else { "oneshot" }
        uiAutomation = $true
        treeObservation = @{cached=$true; defaultTreeTimeoutMs=5000; providerCallInterruptible=$false; chromiumHint="Use a scoped control tree; if traversal truncates or times out, check responsiveness before retrying and prefer screenshot/ocr."}
        screenshot = $true
        sendInput = (-not $background)
        desktopTarget = if ($background) { 'background' } else { 'current' }
        postmessage = $true
        ocr = "lazy"
        homing = $true
        failsafe = ($script:WcuCornerFailsafe -and [string]$env:WCU_FAILSAFE -ne '0')
        activeWindow = $active
        uiAutomationProviderChecked = $false
        targetResponsive = Get-WindowResponsive $active
        inputDesktopAvailable = Invoke-Safe { if ([WindowsComputerUseNative].GetMethod('IsInputDesktopAvailable') -ne $null) { [WindowsComputerUseNative]::IsInputDesktopAvailable() } else { $true } } $false
        virtualScreen = [ordered]@{ x = $screen.Left; y = $screen.Top; width = $screen.Width; height = $screen.Height }
      })
    }
    "snapshot" {
      $scope = Get-Prop $inputObject "scope" "active_window"
      $includeScreenshot = [bool](Get-Prop $inputObject "includeScreenshot" $true)
      $captureWindow = [bool](Get-Prop $inputObject "captureWindow" (Has-WindowTarget $inputObject))
      $maxWidth = [int](Get-Prop $inputObject "maxWidth" 1600)
      $maxDepth = [int](Get-Prop $inputObject "maxDepth" 5)
      $maxNodes = [int](Get-Prop $inputObject "maxNodes" 250)
      $treeResult = Get-TreeResult -Scope $scope -MaxDepth $maxDepth -MaxNodes $maxNodes -InputObject $inputObject
      if ($includeScreenshot) {
        $winEl = $null
        # The window DSH works in may be behind the user's window: then the
        # screen shows the user's window, so capture DSH's window itself.
        $behind = $scope -ne 'desktop' -and -not (Has-WindowTarget $inputObject) -and (Get-WorkWindow) -ne [WindowsComputerUseNative]::GetForegroundWindow().ToInt64()
        if (($captureWindow -or $behind -or $background) -and $treeResult.targetResponsive -ne $false) {
          $winEl = Get-ObservationWindow $inputObject $scope
        }
        $treeResult.screenshot = Capture-Screenshot -WindowElement $winEl -MaxWidth $maxWidth
        if ($treeResult.screenshot.occludedPossible) {
          $treeResult["warning"] = (([string]$treeResult.warning + " The window capture may include an occluding window; inspect screenshot.occludedPossible.").Trim())
        }
        if ($treeResult.screenshot.minimized) {
          $treeResult["warning"] = (([string]$treeResult.warning + " The window is minimized: the capture shows only its title strip. Call activate_window to restore it.").Trim())
        }
      }
      return $treeResult
    }
    "tree" {
      $scope = Get-Prop $inputObject "scope" "active_window"
      $maxDepth = [int](Get-Prop $inputObject "maxDepth" 6)
      $maxNodes = [int](Get-Prop $inputObject "maxNodes" 500)
      return (Get-TreeResult -Scope $scope -MaxDepth $maxDepth -MaxNodes $maxNodes -InputObject $inputObject)
    }
    "list_windows" {
      $includeInvisible = [bool](Get-Prop $inputObject "includeInvisible" $false)
      $maxWindows = [int](Get-Prop $inputObject "maxWindows" 50)
      # Minimized windows are listed: they are still there and can be targeted
      # (activate_window restores them). batch keeps to shown ones.
      $includeMinimized = [bool](Get-Prop $inputObject "includeMinimized" $true)
      $windows = Get-NativeWindowList -IncludeInvisible $includeInvisible -MaxWindows $maxWindows -RecordObservation -IncludeMinimized $includeMinimized
      # A minimized window's box is the -32000,-32000 parking spot: leave it out
      # rather than let it read as a position.
      $listed = @($windows.ToArray() | ForEach-Object { if ($_.Contains('minimized')) { [ordered]@{ id = $_.id; name = $_.name; className = $_.className; processId = $_.processId; nativeWindowHandle = $_.nativeWindowHandle; isOffscreen = $true; minimized = $true } } else { $_ } })
      $listing = [ordered]@{ ok = $true; windows = $listed }
      if ($script:WindowListTruncated) { $listing['truncated'] = $true; $listing['truncationReason'] = "maxWindows ($maxWindows) reached; pass a larger maxWindows (up to 200) to list the rest." }
      return $listing
    }
    "find" {
      $query = Get-Prop $inputObject "query" ""
      $scope = Get-Prop $inputObject "scope" "active_window"
      $controlType = Get-Prop $inputObject "controlType" ""
      $maxDepth = [int](Get-Prop $inputObject "maxDepth" 8)
      $maxNodes = [int](Get-Prop $inputObject "maxNodes" 1200)
      $maxResults = [int](Get-Prop $inputObject "maxResults" 25)
      $findInput = [pscustomobject]@{
        viewMode = Get-ViewMode $inputObject "control"
        includeOffscreen = [bool](Get-Prop $inputObject "includeOffscreen" $false)
        detailLevel = "full"
        treeTimeoutMs = Get-Prop $inputObject "treeTimeoutMs" 5000
        windowTitle = Get-Prop $inputObject "windowTitle" $null
        processId = Get-Prop $inputObject "processId" $null
        nativeWindowHandle = Get-Prop $inputObject "nativeWindowHandle" $null
        activate = [bool](Get-Prop $inputObject "activate" $false)
      }
      $treeResult = Get-TreeResult -Scope $scope -MaxDepth $maxDepth -MaxNodes $maxNodes -InputObject $findInput
      $results = New-Object System.Collections.Generic.List[object]
      Search-Tree -Node $treeResult.tree -Query $query -ControlType $controlType -MaxResults $maxResults -Results $results
      $out = [ordered]@{ ok = $true; query = $query; results = @($results.ToArray()); scannedNodes = $treeResult.nodeCount; truncated = $treeResult.truncated }
      foreach ($key in @('durationMs','treeTimeoutMs','targetResponsive','truncationReason','warning','providerError','webContent')) {
        if ($treeResult.Contains($key)) { $out[$key] = $treeResult[$key] }
      }
      if ($results.Count -eq 0 -and $treeResult.nodeCount -lt 10) {
        $out["hint"] = "UIA tree is sparse (fewer than 10 nodes): this app may not expose an accessibility tree (game / self-drawn Tk / Qt / canvas / RDP). Use the ocr tool to locate text by pixels."
      }
      return $out
    }
    "element_info" {
      $detailLevel = Get-DetailLevel $inputObject "compact"
      $elementId = Get-Prop $inputObject "elementId" $null
      if ($null -ne $elementId) {
        $el = Resolve-Element $elementId $inputObject
        return ([ordered]@{ ok = $true; element = (Convert-ElementInfo -Element $el -Id $elementId -Depth 0 -DetailLevel $detailLevel) })
      } else {
        $x = [int](Get-Prop $inputObject "x" 0)
        $y = [int](Get-Prop $inputObject "y" 0)
        Activate-TargetIfRequested $inputObject
        $point = New-Object System.Windows.Point($x, $y)
        $nativePoint = New-Object WindowsComputerUseNative+POINT
        $nativePoint.x = $x; $nativePoint.y = $y
        $pointHwnd = [WindowsComputerUseNative]::GetAncestor([WindowsComputerUseNative]::WindowFromPoint($nativePoint), 2).ToInt64()
        $ownerWindow = $null
        foreach ($native in (Get-NativeWindowList -IncludeInvisible $true -MaxWindows 4096)) {
          if ([int64]$native.nativeWindowHandle -eq $pointHwnd) { $ownerWindow = $native; break }
        }
        if (Has-WindowTarget $inputObject) {
          $requested = Get-ObservationWindow $inputObject
          if ($pointHwnd -ne [int64]$requested.nativeWindowHandle) { throw 'Point is outside or occluded by another target window.' }
        }
        # A cold Chromium page answers hit tests with its layout pane.
        $pages = Initialize-ChromiumPages $ownerWindow @{ watch = [Diagnostics.Stopwatch]::StartNew(); budgetMs = 2000 }
        $el = [System.Windows.Automation.AutomationElement]::FromPoint($point)
        $script:ObservationOwner = $ownerWindow
        try {
          $result = [ordered]@{ ok = $true; point = [ordered]@{ x = $x; y = $y }; element = (Convert-ElementInfo -Element $el -Id $null -Depth 0 -DetailLevel $detailLevel) }
          if ($null -ne $pages) { $result["webContent"] = $pages }
          return $result
        } finally { $script:ObservationOwner = $null }
      }
    }
    "click" {
      [void](Test-Failsafe)
      $point = Get-PointFromArgs $inputObject
      $button = Get-Prop $inputObject "button" "left"
      $dispatch = [string](Get-Prop $inputObject "dispatch" "auto")
      $result = [ordered]@{ ok = $true; action = "click"; x = $point.x; y = $point.y; button = $button; elementId = $point.elementId }

      # Homing: if this window was observed before and moved, compensate.
      if ((Has-WindowTarget $inputObject) -and ($null -eq $point.elementId)) {
        $target = Get-ObservationWindow $inputObject
        Assert-WindowIdentity $inputObject $target
        $homed = Home-Point -X $point.x -Y $point.y -Target $target -ObservationToken ([string](Get-Prop $inputObject 'observationToken' ''))
        $point.x = $homed.x
        $point.y = $homed.y
        if ($null -ne $homed.homed) { $result["homed"] = $homed.homed }
      }

      # Dispatch layering (cua-style): a left click on an element tries the
      # element itself first (BM_CLICK or a UIA pattern, in the background);
      # raw coordinates and other buttons need the system input queue
      # (foreground SendInput) unless the caller explicitly asks for
      # background PostMessage. A pattern stands for a left click only.
      $useBackground = ($dispatch -eq "background") -or (($dispatch -eq "auto") -and ($null -ne $point.elementId) -and $button -eq 'left' -and -not [bool](Get-Prop $inputObject 'activate' $false))
      if ($useBackground) {
        if ($null -ne $point.elementId -and $button -eq 'left') {
          $patternMethod = Invoke-ElementPattern $point.element
          if ($null -ne $patternMethod) {
            $result["method"] = "background:$patternMethod"
            Add-BackgroundReport $result
            Set-WorkWindow (Get-ElementWindow $point.element)
            return $result
          }
        }
        # Auto is a background-first policy, not permission to silently post
        # an unhandled mouse message. Upgrade before sending any real input.
        if ($dispatch -ne 'background') {
          Assert-InputAllowed 'This element has no background click pattern'
        } else {
        $hwnd = 0
        if ($null -ne $point.element) { $hwnd = Invoke-Safe { [int64]$point.element.Current.NativeWindowHandle } 0 }
        if (-not ($hwnd -and $hwnd -ne 0)) { $hwnd = if ($null -ne $point.element) { Get-ElementWindow $point.element } else { Resolve-TargetHwnd $inputObject } }
        if (-not ($hwnd -and $hwnd -ne 0)) {
          throw "background_unavailable: no window handle to post to. Retry with dispatch:'foreground'."
        }
        if (-not (Post-BackgroundClick -Hwnd $hwnd -X $point.x -Y $point.y -Button $button -Count 1)) {
          throw "background_unavailable: PostMessage was refused. Retry with dispatch:'foreground'."
        }
        $result["method"] = "postmessage"
        $result["verified"] = $false
        $result["note"] = "Background click queued, delivery unverified. Chromium/Electron/UWP content may ignore PostMessage; if nothing happened, retry with dispatch:'foreground'."
        return $result
        }
      }

      Assert-InputAllowed 'This click'
      # Real input: a target comes forward for the click and the point must
      # show it; without a target the click goes to the window at the point,
      # which it brings forward itself. Pointer and foreground are given back.
      $targeted = (Has-WindowTarget $inputObject) -or ($null -ne $point.element)
      $hwnd = if (Has-WindowTarget $inputObject) { [int64](Get-ObservationWindow $inputObject).nativeWindowHandle } elseif ($null -ne $point.element) { Get-ElementWindow $point.element } else { Get-RootWindowAt $point.x $point.y }
      $state = Start-Input -InputObject $inputObject -Hwnd $hwnd -NoActivate:(-not $targeted)
      try {
        Confirm-ElementPoint $point
        if ($targeted) { Assert-PointOnTarget $point.x $point.y $hwnd $state }
        $result.x = $point.x; $result.y = $point.y
        $state.moved = @{ x = $point.x; y = $point.y }
        $state.drain = $true
        Click-At -X $point.x -Y $point.y -Button $button -Count 1
        $result["method"] = "sendinput"
      } finally { Complete-Input $state $result }
      return $result
    }
    "double_click" {
      [void](Test-Failsafe)
      $point = Get-PointFromArgs $inputObject
      $button = Get-Prop $inputObject "button" "left"
      [void](Get-ButtonFlags $button)
      $dispatch = [string](Get-Prop $inputObject "dispatch" "auto")
      $result = [ordered]@{ ok = $true; action = "double_click"; x = $point.x; y = $point.y; button = $button; elementId = $point.elementId }
      if ((Has-WindowTarget $inputObject) -and ($null -eq $point.elementId)) {
        $target = Get-ObservationWindow $inputObject
        Assert-WindowIdentity $inputObject $target
        $homed = Home-Point -X $point.x -Y $point.y -Target $target -ObservationToken ([string](Get-Prop $inputObject 'observationToken' ''))
        $point.x = $homed.x
        $point.y = $homed.y
        if ($null -ne $homed.homed) { $result["homed"] = $homed.homed }
      }
      if ($dispatch -eq "background") {
        $hwnd = 0
        if ($null -ne $point.element) { $hwnd = Invoke-Safe { [int64]$point.element.Current.NativeWindowHandle } 0 }
        if (-not ($hwnd -and $hwnd -ne 0)) { $hwnd = Resolve-TargetHwnd $inputObject }
        if (-not ($hwnd -and $hwnd -ne 0)) {
          throw "background_unavailable: no window handle to post to. Retry with dispatch:'foreground'."
        }
        if (-not (Post-BackgroundClick -Hwnd $hwnd -X $point.x -Y $point.y -Button $button -Count 2)) {
          throw "background_unavailable: PostMessage was refused. Retry with dispatch:'foreground'."
        }
        $result["method"] = "postmessage"
        $result["verified"] = $false
        $result["note"] = "Background double-click queued, delivery unverified (WM_LBUTTONDBLCLK). Retry with dispatch:'foreground' if nothing happened."
        return $result
      }
      $targeted = (Has-WindowTarget $inputObject) -or ($null -ne $point.element)
      $hwnd = if (Has-WindowTarget $inputObject) { [int64](Get-ObservationWindow $inputObject).nativeWindowHandle } elseif ($null -ne $point.element) { Get-ElementWindow $point.element } else { Get-RootWindowAt $point.x $point.y }
      $state = Start-Input -InputObject $inputObject -Hwnd $hwnd -NoActivate:(-not $targeted)
      try {
        Confirm-ElementPoint $point
        if ($targeted) { Assert-PointOnTarget $point.x $point.y $hwnd $state }
        $result.x = $point.x; $result.y = $point.y
        $state.moved = @{ x = $point.x; y = $point.y }
        $state.drain = $true
        Click-At -X $point.x -Y $point.y -Button $button -Count 2
        $result["method"] = "sendinput"
      } finally { Complete-Input $state $result }
      return $result
    }
    "move" {
      [void](Test-Failsafe)
      $point = Get-PointFromArgs $inputObject
      $result = [ordered]@{ ok = $true; action = "move"; x = $point.x; y = $point.y; elementId = $point.elementId }
      Activate-TargetIfRequested $inputObject
      if ((Has-WindowTarget $inputObject) -and ($null -eq $point.elementId)) {
        $target = Get-ObservationWindow $inputObject
        Assert-WindowIdentity $inputObject $target
        $homed = Home-Point -X $point.x -Y $point.y -Target $target -ObservationToken ([string](Get-Prop $inputObject 'observationToken' ''))
        $point.x = $homed.x
        $point.y = $homed.y
        if ($null -ne $homed.homed) { $result["homed"] = $homed.homed }
      }
      Move-ToPoint -X $point.x -Y $point.y
      return $result
    }
    "drag" {
      [void](Test-Failsafe)
      $path = @(Get-Prop $inputObject "path" @())
      if ($path.Count -lt 2) { throw "path must contain at least two points." }
      $button = Get-Prop $inputObject "button" "left"
      $flags = Get-ButtonFlags $button
      # Homing: shift the whole path if the target window moved since the
      # coordinates were observed.
      if (Has-WindowTarget $inputObject) {
        $target = Get-ObservationWindow $inputObject
        Assert-WindowIdentity $inputObject $target
        $homed = Home-Point -X ([int]$path[0].x) -Y ([int]$path[0].y) -Target $target -ObservationToken ([string](Get-Prop $inputObject 'observationToken' ''))
        if ($null -ne $homed.homed) {
          $dx = $homed.homed.dx
          $dy = $homed.homed.dy
          $shifted = @()
          foreach ($pt in $path) { $shifted += [pscustomobject]@{ x = [int]$pt.x + $dx; y = [int]$pt.y + $dy } }
          $path = $shifted
        }
      }
      $first = $path[0]
      $last = $path[$path.Count - 1]
      $targeted = Has-WindowTarget $inputObject
      $hwnd = if ($targeted) { [int64](Get-ObservationWindow $inputObject).nativeWindowHandle } else { Get-RootWindowAt ([int]$first.x) ([int]$first.y) }
      $result = [ordered]@{ ok = $true; action = "drag"; points = $path.Count; button = $button; homed = if ($null -ne $homed) { $homed.homed } else { $null } }
      $state = Start-Input -InputObject $inputObject -Hwnd $hwnd -NoActivate:(-not $targeted)
      try {
        if ($targeted) { Assert-PointOnTarget ([int]$first.x) ([int]$first.y) $hwnd $state }
        Move-ToPoint -X ([int]$first.x) -Y ([int]$first.y)
        Start-Sleep -Milliseconds 50
        $state.drain = $true
        try {
          if ([WindowsComputerUseNative]::SendMouseEvent(0, 0, [uint32]$flags[0], 0) -ne 1) { throw 'COMPUTER_USE_INPUT_UNAVAILABLE: Windows rejected mouse input.' }
          # Under Low disruption the user's input waits for the stroke, so a
          # long one moves faster: about a second at most.
          $pause = if ($script:WcuLowDisruption -and $path.Count -gt 40) { [Math]::Max(8, [int](1000 / $path.Count)) } else { 25 }
          foreach ($pt in $path) {
            [void](Test-Failsafe)
            Move-ToPoint -X ([int]$pt.x) -Y ([int]$pt.y)
            Start-Sleep -Milliseconds $pause
          }
          $state.moved = @{ x = [int]$last.x; y = [int]$last.y }
        } finally {
          if ([WindowsComputerUseNative]::SendMouseEvent(0, 0, [uint32]$flags[1], 0) -ne 1) { throw 'COMPUTER_USE_INPUT_UNAVAILABLE: Windows rejected mouse release.' }
        }
      } finally { Complete-Input $state $result }
      return $result
    }
    "scroll" {
      [void](Test-Failsafe)
      $point = Get-PointFromArgs $inputObject
      $deltaY = [int](Get-Prop $inputObject "deltaY" 480)
      $deltaX = [int](Get-Prop $inputObject "deltaX" 0)
      if ((Has-WindowTarget $inputObject) -and ($null -eq $point.elementId)) {
        $target = Get-ObservationWindow $inputObject
        Assert-WindowIdentity $inputObject $target
        $homed = Home-Point -X $point.x -Y $point.y -Target $target -ObservationToken ([string](Get-Prop $inputObject 'observationToken' ''))
        $point.x = $homed.x
        $point.y = $homed.y
      }
      $result = [ordered]@{ ok = $true; action = "scroll"; x = $point.x; y = $point.y; deltaX = $deltaX; deltaY = $deltaY; elementId = $point.elementId; homed = if ($null -ne $homed) { $homed.homed } else { $null } }
      # An element scrolls in the background first (Invoke-ElementScroll); the
      # wheel at its center, with real input, is the fallback.
      if (($deltaY -ne 0 -or $deltaX -ne 0) -and $null -ne $point.element -and -not [bool](Get-Prop $inputObject 'activate' $false)) {
        $scrolled = Invoke-ElementScroll $point.element $deltaX $deltaY
        if ($null -ne $scrolled) {
          foreach ($key in $scrolled.Keys) { $result[$key] = $scrolled[$key] }
          Add-BackgroundReport $result
          Set-WorkWindow (Get-ElementWindow $point.element)
          return $result
        }
        Assert-InputAllowed 'Scrolling this element'
      }
      if ($deltaY -ne 0 -or $deltaX -ne 0) {
        $targeted = (Has-WindowTarget $inputObject) -or ($null -ne $point.element)
        $hwnd = if (Has-WindowTarget $inputObject) { [int64](Get-ObservationWindow $inputObject).nativeWindowHandle } elseif ($null -ne $point.element) { Get-ElementWindow $point.element } else { Get-RootWindowAt $point.x $point.y }
        $state = Start-Input -InputObject $inputObject -Hwnd $hwnd -NoActivate:(-not $targeted)
        try {
          if ($targeted) { Assert-PointOnTarget $point.x $point.y $hwnd $state }
          $state.moved = @{ x = $point.x; y = $point.y }
          Move-ToPoint -X $point.x -Y $point.y
          Start-Sleep -Milliseconds 30
          [void](Test-Failsafe)
          if ($deltaY -ne 0) {
            if ([WindowsComputerUseNative]::SendMouseEvent(0, 0, [uint32][WindowsComputerUseNative]::MOUSEEVENTF_WHEEL, (-1 * $deltaY)) -ne 1) { throw 'COMPUTER_USE_INPUT_UNAVAILABLE: Windows rejected scroll input.' }
          }
          if ($deltaX -ne 0) {
            if ([WindowsComputerUseNative]::SendMouseEvent(0, 0, [uint32][WindowsComputerUseNative]::MOUSEEVENTF_HWHEEL, $deltaX) -ne 1) { throw 'COMPUTER_USE_INPUT_UNAVAILABLE: Windows rejected scroll input.' }
          }
          # The wheel goes to the window under the pointer; give it a moment.
          Start-Sleep -Milliseconds 60
        } finally { Complete-Input $state $result }
      }
      return $result
    }
    "type_text" {
      [void](Test-Failsafe)
      $method = [string](Get-Prop $inputObject "method" "auto")
      $text = [string](Get-Prop $inputObject "text" "")
      if ($text.Length -eq 0) { throw "text is required." }

      # auto (default): a Win32 edit with the focus in the window the text goes
      # to takes it in the background (Set-FocusedEditText); any other control
      # gets a clipboard paste, with that window borrowed for it.
      if ($method -eq 'auto') {
        # activate:true asks for the window in front, which real input gives.
        if ((Get-Prop $inputObject 'focusMode' 'preserve') -ne 'main' -and -not [bool](Get-Prop $inputObject 'activate' $false)) {
          if (Has-WindowTarget $inputObject) { Assert-WindowIdentity $inputObject (Get-ObservationWindow $inputObject) }
          $window = Resolve-InputWindow $inputObject
          $via = $script:InputWindowVia
          $typed = Set-FocusedEditText $window $text
          if ($null -ne $typed) {
            $script:InputWindow = @{ series = $script:WcuSeries; hwnd = [int64]$window; at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }
            # Typed when the field grew by the text, or (in place of a selection)
            # now holds it.
            $value = Get-ValueText (Invoke-Safe { [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$typed.hwnd) } $null)
            $verified = $typed.grew -eq $text.Length -or ($null -ne $value -and $value.Contains($text))
            $result = [ordered]@{ ok = $true; action = "type_text"; length = $text.Length; method = "background:EM_REPLACESEL"; verified = $verified; deliveredTo = (Get-KeyDestination $window $via) }
            if ($null -ne $value) { $result["verifyValue"] = if ($value.Length -gt 200) { $value.Substring(0, 200) + "..." } else { $value } }
            if (-not $verified) { $result["note"] = "The field's length changed by $($typed.grew), not by the length of the text: it may limit its length or drop some characters. Check the field." }
            return $result
          }
        }
        Assert-InputAllowed 'Typing into this control'
        $method = 'clipboard'
      }

      # Background path: post WM_CHAR to the control with the keyboard focus
      # in the target window — no clipboard, no foreground, no system input
      # queue.
      if ($method -eq "background") {
        if (-not (Has-WindowTarget $inputObject)) {
          throw "method:'background' requires a window target (windowTitle / processId / nativeWindowHandle)."
        }
        $hwnd = Resolve-TargetHwnd $inputObject
        if (-not ($hwnd -and $hwnd -ne 0)) { throw "No window handle found for the target." }
        $focus = Get-BackgroundKeyTarget $hwnd
        $before = Get-EditTextLength $focus
        $ok = Post-BackgroundText -Hwnd $focus -Text $text
        if (-not $ok) { throw "background_unavailable: some WM_CHAR messages were refused. Retry with method:'clipboard'." }
        $typed = Test-BackgroundTyped $focus $before $text
        $result = [ordered]@{ ok = $true; action = "type_text"; length = $text.Length; method = "postmessage-wmchar"; verified = ($typed -eq $true) }
        if ($null -eq $typed) { $result["note"] = "Background text queued to the focused control, delivery unverified; controls that reject WM_CHAR (some custom UIs) need method:'clipboard'." }
        elseif (-not $typed) { $result["note"] = "The focused field did not take the text within a second: it may reject WM_CHAR or limit its length. Check the field, or use method:'clipboard'." }
        return $result
      }

