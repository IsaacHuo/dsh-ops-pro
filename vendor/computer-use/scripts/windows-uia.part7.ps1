      # Foreground path (clipboard or sendinput): the target must be
      # foreground + focused. sendinput synthesizes Unicode key events
      # (KEYEVENTF_UNICODE) — no clipboard touched, so it also types into
      # password fields and other controls that reject paste. The window the
      # text goes to comes forward for it and gives the foreground back after.
      $focusedControl = $null
      $target = $null
      if (Has-WindowTarget $inputObject) {
        $target = Get-ObservationWindow $inputObject
        Assert-WindowIdentity $inputObject $target
      }
      $result = [ordered]@{ ok = $true; action = "type_text"; length = $text.Length; focusedControl = $null }
      $inputHwnd = Resolve-InputWindow $inputObject
      $via = $script:InputWindowVia
      $state = Start-Input -InputObject $inputObject -Hwnd $inputHwnd
      try {
        if ($null -ne $target -and (Get-Prop $inputObject 'focusMode' 'preserve') -eq 'main') {
          $uiaTarget = Resolve-TargetWindow $inputObject
          $focusedControl = Focus-TextControl $uiaTarget
          if ($null -eq $focusedControl) { throw 'Could not focus the requested main text control; no text sent.' }
          $result["focusedControl"] = $focusedControl
        }
        $destination = Get-KeyDestination ([WindowsComputerUseNative]::GetForegroundWindow().ToInt64()) $via
        Assert-InFront $state
        $result["deliveredTo"] = $destination
        if ($method -eq "sendinput") {
          $front = [WindowsComputerUseNative]::GetForegroundWindow()
          $focus = [WindowsComputerUseNative]::FocusedWindow($front)
          $edit = Get-SendInputEdit $focus $text
          Assert-InFront $state
          if ([WindowsComputerUseNative]::GetForegroundWindow() -ne $front -or [WindowsComputerUseNative]::FocusedWindow($front) -ne $focus) {
            throw 'INPUT_FOCUS_CHANGED: focus changed before typing. No input was sent.'
          }
          [void](Test-Failsafe)
          $ok = [bool][WindowsComputerUseNative]::SendUnicodeText($text, $front, $focus)
          $typed = Wait-SendInputEdit $front $focus $edit $text.Length
          if (-not $ok -or $typed -eq 'incomplete') {
            throw 'INPUT_TEXT_INCOMPLETE: the full text was not confirmed in the target. Some text may already be present. Inspect the field before retrying.'
          }
          $result["method"] = "sendinput-unicode"
          $result["verified"] = ($typed -eq 'observed') -or ($typed -eq 'changed')
          $result["verification"] = if ($result["verified"]) { 'observed' } else { 'unconfirmed' }
          if ($typed -eq 'changed') { $result["note"] = 'The field holds the typed text, and the application added text or changed letter case (for example autocomplete). Check the field if the exact value matters.' }
          elseif ($null -eq $typed) { $result["note"] = 'Windows queued the Unicode input. The edited field could not be verified. Check the field before retrying.' }
        } else {
          $restore = [bool](Get-Prop $inputObject "restoreClipboard" $true)
          Type-Text -Text $text -RestoreClipboard $restore
          $result["restoreClipboard"] = $restore
          $result["method"] = "clipboard-paste"
          if ($script:LastPasteInfo) { foreach ($entry in $script:LastPasteInfo.GetEnumerator()) { $result[$entry.Key] = $entry.Value } }
          $result["verified"] = $false
          if ($script:LastPasteInfo -and -not $script:LastPasteInfo.clipboardRestored -and $restore) { $result["clipboardRestoreNote"] = 'Previous clipboard was not restored because the target read was not confirmed or restoration failed; requested text remains available for a late paste.' }
        }
      } finally { Complete-Input $state $result }
      # Clipboard: provide the requested main control's value when available.
      if ($method -ne "sendinput" -and $null -ne $focusedControl -and $null -ne $target) {
        $verify = Get-BestTextControl $uiaTarget
        if ($null -ne $verify) {
          $val = Get-ValueText $verify
          if ($null -ne $val) { $result["verifyValue"] = if ($val.Length -gt 200) { $val.Substring(0, 200) + "..." } else { $val } }
        }
      }
      return $result
    }
    "keypress" {
      [void](Test-Failsafe)
      $dispatch = [string](Get-Prop $inputObject "dispatch" "foreground")
      $keys = @(Get-Prop $inputObject "keys" @())
      if (Has-WindowTarget $inputObject) {
        $ktarget = Get-ObservationWindow $inputObject
        Assert-WindowIdentity $inputObject $ktarget
      }
      if ($dispatch -eq "background") {
        # Only a single printable character can be posted as WM_CHAR. Chords
        # and functional keys need the system input queue — say so honestly
        # instead of pretending (cua's background_unavailable pattern).
        if ($keys.Count -ne 1) {
          throw "background_unavailable: key chords and functional keys need the system input queue. Use dispatch:'foreground'."
        }
        $ch = [string]$keys[0]
        if ($ch.Length -ne 1) {
          throw "background_unavailable: only a single character can be posted in background. Use dispatch:'foreground' for functional keys."
        }
        if (-not (Has-WindowTarget $inputObject)) {
          throw "background dispatch requires a window target (windowTitle / processId / nativeWindowHandle)."
        }
        $hwnd = Resolve-TargetHwnd $inputObject
        if (-not ($hwnd -and $hwnd -ne 0)) { throw "No window handle found for the target." }
        $focus = Get-BackgroundKeyTarget $hwnd
        $before = Get-EditTextLength $focus
        [void](Test-Failsafe)
        $ok = [WindowsComputerUseNative]::PostMessageW([IntPtr]$focus, [WindowsComputerUseNative]::WM_CHAR, [IntPtr][int][char]$ch, [IntPtr]1)
        if (-not $ok) { throw "background_unavailable: WM_CHAR was refused. Use dispatch:'foreground'." }
        $typed = Test-BackgroundTyped $focus $before $ch
        $result = [ordered]@{ ok = $true; action = "keypress"; keys = $keys; method = "postmessage-wmchar"; verified = ($typed -eq $true) }
        if ($typed -ne $true) { $result["note"] = "Background key queued to the focused control, delivery unverified." }
        return $result
      }
      $sequence = New-Object 'System.Collections.Generic.List[object]'
      $sequence.Add([string[]]$keys)
      foreach($next in @(Get-Prop $inputObject 'thenKeys' @())){$sequence.Add([string[]]$next)}
      $chords = @($sequence | ForEach-Object { Convert-KeyChord -Keys $_ })
      $result = [ordered]@{ ok = $true; action = "keypress"; keys = $keys; sendKeys = $chords[0]; method = "sendinput" }
      if($sequence.Count -gt 1){$result['thenKeys']=@(Get-Prop $inputObject 'thenKeys' @());$result['chordsSent']=0}
      $inputHwnd = Resolve-InputWindow $inputObject
      $via = $script:InputWindowVia
      $state = Start-Input -InputObject $inputObject -Hwnd $inputHwnd
      try {
        for($i=0;$i -lt $sequence.Count;$i++){
          if($i -gt 0){Start-Sleep -Milliseconds ([int](Get-Prop $inputObject 'intervalMs' 60))}
          [void](Test-Failsafe)
          # The keys reach the focused control of the window in front: name both
          # (deliveredTo), so a result shows where they went, not only "sent".
          if($i -eq 0){$destination=Get-KeyDestination ([WindowsComputerUseNative]::GetForegroundWindow().ToInt64()) $via}
          Assert-InFront $state
          $state.drain = $true
          if (-not [WindowsComputerUseNative]::SendKeyChord([string[]]$sequence[$i])) { throw 'COMPUTER_USE_INPUT_UNAVAILABLE: Windows rejected the key chord.' }
          if($i -eq 0){$result['deliveredTo']=$destination}
          if($sequence.Count -gt 1){$result['chordsSent']=$i+1}
        }
      } finally { Complete-Input $state $result }
      return $result
    }
    "focus" {
      $elementId = [string](Get-Prop $inputObject "elementId" "")
      $el = Resolve-Element $elementId $inputObject
      [void](Test-Failsafe)
      # Keyboard focus brings the element's window forward; it is given back,
      # and typing without a target goes to this window again.
      $result = [ordered]@{ ok = $true; action = "focus"; elementId = $elementId }
      $state = Start-Input -InputObject $inputObject -Hwnd (Get-ElementWindow $el) -NoActivate
      try { $el.SetFocus() } finally { Complete-Input $state $result }
      return $result
    }
    "invoke" {
      $elementId = [string](Get-Prop $inputObject "elementId" "")
      $fallback = [bool](Get-Prop $inputObject "fallbackClick" $true)
      $kind = [string](Get-Prop $inputObject "action" "default")
      $el = Resolve-Element $elementId $inputObject
      if ($kind -ne 'default') {
        $result = [ordered]@{ ok = $true; action = "invoke"; elementId = $elementId; elementAction = $kind; method = (Invoke-ElementAction $el $kind) }
        Add-BackgroundReport $result
        Set-WorkWindow (Get-ElementWindow $el)
        return $result
      }
      $method = Invoke-ElementPattern $el
      $result = [ordered]@{ ok = $true; action = "invoke"; elementId = $elementId; method = $method }
      Add-BackgroundReport $result
      if ($null -ne $method) { Set-WorkWindow (Get-ElementWindow $el) }
      if ($null -eq $method -and $fallback) {
        $rect = Convert-Rect (Invoke-Safe { $el.Current.BoundingRectangle } $null)
        if ($null -eq $rect) { throw "Element has no invokable pattern and no bounding box for fallback click." }
        Assert-InputAllowed 'This element has no invokable pattern; its fallback click'
        $hwnd = Get-ElementWindow $el
        $state = Start-Input -InputObject $inputObject -Hwnd $hwnd
        try {
          $point = @{element=$el; x=$rect.centerX; y=$rect.centerY}
          Confirm-ElementPoint $point
          Assert-PointOnTarget $point.x $point.y $hwnd $state
          $state.moved = @{ x = $point.x; y = $point.y }
          $state.drain = $true
          Click-At -X $point.x -Y $point.y -Button "left" -Count 1
          $result["method"] = "ClickFallback"
        } finally { Complete-Input $state $result }
        return $result
      }
      if ($null -eq $method) { throw "Element has no supported invokable pattern." }
      return $result
    }
    "set_value" {
      $elementId = [string](Get-Prop $inputObject "elementId" "")
      $value = [string](Get-Prop $inputObject "value" "")
      $fallback = [bool](Get-Prop $inputObject "fallbackType" $true)
      $restore = [bool](Get-Prop $inputObject "restoreClipboard" $true)
      $el = Resolve-Element $elementId $inputObject
      $method = Set-ElementValue $el -Value $value
      $result = [ordered]@{ ok = $true; action = "set_value"; elementId = $elementId; method = $method; length = $value.Length }
      Add-BackgroundReport $result
      if ($null -ne $method) { Set-WorkWindow (Get-ElementWindow $el) }
      if ($null -eq $method -and $fallback) {
        Assert-InputAllowed 'This element has no ValuePattern; typing into it'
        [void](Test-Failsafe)
        $hwnd = Get-ElementWindow $el
        $state = Start-Input -InputObject $inputObject -Hwnd $hwnd
        try {
          $el.SetFocus()
          Assert-InFront $state
          Assert-ElementFocus $el
          if (-not [WindowsComputerUseNative]::SendKeyChord(@('ctrl','a'))) { throw 'COMPUTER_USE_INPUT_UNAVAILABLE: Windows rejected select-all input.' }
          # Ctrl+A can trigger application handlers that move focus.
          Assert-InFront $state
          Assert-ElementFocus $el
          Type-Text -Text $value -RestoreClipboard $restore
          $result["method"] = "FocusSelectAllTypeFallback"
        } finally { Complete-Input $state $result }
        return $result
      }
      if ($null -eq $method) { throw "Element has no ValuePattern and fallbackType is false." }
      return $result
    }
    "activate_window" {
      if (-not (Has-WindowTarget $inputObject)) { throw "Provide windowTitle, processId, or nativeWindowHandle." }
      $window = Get-ObservationWindow $inputObject
      $responsive = Get-WindowResponsive $window
      $result = [ordered]@{ok=$true; action="activate_window"; activated=$false; window=$window; targetResponsive=$responsive}
      if (-not $responsive) {
        $result["warning"] = "The target window is unresponsive; activation was skipped. Do not retry tree or input calls until the target recovers."
        return $result
      }
      $hwnd = [int64]$window.nativeWindowHandle
      $wasMinimized = [WindowsComputerUseNative]::IsIconic([IntPtr]$hwnd)
      if ($script:WcuLowDisruption) { [WcuInputHold]::Snapshot() }
      $result.activated = [bool](Set-WindowForeground $window)
      # Report the window as it is now. The entry above was read before the
      # activation, so a window just restored would still show its minimized
      # -32000 box and read as "nothing happened" (issue #82).
      foreach ($now in (Get-NativeWindowList -IncludeInvisible $true -MaxWindows 4096)) {
        if ([int64]$now.nativeWindowHandle -eq $hwnd) { $result.window = $now; break }
      }
      $stillMinimized = [WindowsComputerUseNative]::IsIconic([IntPtr]$hwnd)
      if ($wasMinimized) { $result['restored'] = -not $stillMinimized }
      if ($stillMinimized) { $result.activated = $false } else { Update-WindowCache $result.window }
      Update-WindowIdentity $inputObject $window
      # Kept in front by request; typing without a target goes here too.
      if ($result.activated) { $script:InputWindow = @{ series = $script:WcuSeries; hwnd = $hwnd; at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() } }
      if ($result.activated -and $script:WcuLowDisruption -and [WcuInputHold]::ArmGuard([long[]]@($hwnd), [long[]]@([int64](Get-WindowProcessId $hwnd)))) { $result['userInput'] = [WcuInputHold]::GuardNote }
      if (-not $result.activated) {
        $result["targetResponsive"] = Get-WindowResponsive $window
        $result["warning"] = if ($stillMinimized) { "The window is still minimized: Windows did not restore it. Try again; if it stays minimized, ask the user to restore it." } elseif ($result.targetResponsive) { "The window could not be brought to the foreground (Windows foreground lock)." } else { "The target window became unresponsive; avoid repeated activation, tree or input calls." }
      }
      return $result
    }
    "cursor_pos" {
      $p = New-Object WindowsComputerUseNative+POINT
      [void][WindowsComputerUseNative]::GetCursorPos([ref]$p)
      return ([ordered]@{ ok = $true; x = $p.x; y = $p.y })
    }
    "screen_info" {
      # Diagnostics: raw virtual-screen metrics vs GDI+ virtual screen, so
      # coordinate-space mismatches (DPI awareness state) are visible.
      $p = New-Object WindowsComputerUseNative+POINT
      [void][WindowsComputerUseNative]::GetCursorPos([ref]$p)
      $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
      return ([ordered]@{
        ok = $true
        metrics = [ordered]@{
          xVirtualScreen = [WindowsComputerUseNative]::GetSystemMetrics(76)
          yVirtualScreen = [WindowsComputerUseNative]::GetSystemMetrics(77)
          cxVirtualScreen = [WindowsComputerUseNative]::GetSystemMetrics(78)
          cyVirtualScreen = [WindowsComputerUseNative]::GetSystemMetrics(79)
          primary = [ordered]@{ w = [WindowsComputerUseNative]::GetSystemMetrics(0); h = [WindowsComputerUseNative]::GetSystemMetrics(1) }
        }
        gdiVirtualScreen = [ordered]@{ x = $vs.Left; y = $vs.Top; width = $vs.Width; height = $vs.Height }
        cursor = [ordered]@{ x = $p.x; y = $p.y }
      })
    }
    "wait_for" {
      $condition = [string](Get-Prop $inputObject 'condition' 'window')
      $query = [string](Get-Prop $inputObject 'query' '')
      if ($condition -eq 'window' -and -not (Has-WindowTarget $inputObject)) { throw 'Window wait requires a window target.' }
      if ($condition -ne 'window' -and [string]::IsNullOrWhiteSpace($query)) { throw 'Text/element wait requires query.' }
      $appear = [bool](Get-Prop $inputObject 'appear' $true)
      $timeoutMs = [int](Get-Prop $inputObject 'timeoutMs' 5000)
      $intervalMs = [int](Get-Prop $inputObject 'intervalMs' 250)
      $watch = [Diagnostics.Stopwatch]::StartNew()
      while ($true) {
        $found = $false
        $conclusive = $true
        if ($condition -eq 'window') {
          foreach ($info in (Get-NativeWindowList -IncludeInvisible $true -MaxWindows 4096)) {
            if (Test-TargetMatch $info $inputObject) { $found=$true; break }
          }
        } elseif ($condition -eq 'text') {
          # Internal observations never expose an image path to the host.
          $observationArgs = [pscustomobject]@{scope=(Get-Prop $inputObject 'scope' 'active_window');windowTitle=(Get-Prop $inputObject 'windowTitle' $null);processId=(Get-Prop $inputObject 'processId' $null);nativeWindowHandle=(Get-Prop $inputObject 'nativeWindowHandle' $null);query=$query;resolveControl=$false;activate=$false;_wcuSeries=$script:WcuSeries}
          $observationArgs | Add-Member NoteProperty '_wcuInternalOcr' $true
          $observation = Invoke-Action 'ocr' $observationArgs
          $found = $observation.matched.Count -gt 0
          $conclusive = -not [bool]$observation.occludedPossible
        } else {
          $budget = [Math]::Max(100, [Math]::Min([int](Get-Prop $inputObject 'treeTimeoutMs' 1000), $timeoutMs - [int]$watch.ElapsedMilliseconds))
          $observationArgs = [pscustomobject]@{scope=(Get-Prop $inputObject 'scope' 'active_window');windowTitle=(Get-Prop $inputObject 'windowTitle' $null);processId=(Get-Prop $inputObject 'processId' $null);nativeWindowHandle=(Get-Prop $inputObject 'nativeWindowHandle' $null);query=$query;controlType=(Get-Prop $inputObject 'controlType' '');viewMode=(Get-Prop $inputObject 'viewMode' 'control');includeOffscreen=(Get-Prop $inputObject 'includeOffscreen' $false);treeTimeoutMs=$budget;maxDepth=(Get-Prop $inputObject 'maxDepth' 8);maxNodes=(Get-Prop $inputObject 'maxNodes' 1200);maxResults=1;_wcuSeries=$script:WcuSeries}
          $observation = Invoke-Action 'find' $observationArgs
          $found = $observation.results.Count -gt 0
          $conclusive = -not $observation.truncated
        }
        $hit = if ($appear) { $found -and ($condition -ne 'text' -or $conclusive) } else { -not $found -and $conclusive }
        if ($hit -or $watch.ElapsedMilliseconds -ge $timeoutMs) {
          return ([ordered]@{ok=$true;action='wait_for';condition=$condition;found=$found;conclusive=$conclusive;timedOut=(-not $hit);waitedMs=[int]$watch.ElapsedMilliseconds;verification=if ($hit) {'observed'} else {'unconfirmed'}})
        }
        Start-Sleep -Milliseconds ([Math]::Min($intervalMs, [Math]::Max(1,$timeoutMs-[int]$watch.ElapsedMilliseconds)))
      }
    }
    "close_window" {
      # Graceful close: post WM_CLOSE (the app can veto it with a save dialog),
      # unlike killing the process.
      if (-not (Has-WindowTarget $inputObject)) { throw "Provide windowTitle, processId, or nativeWindowHandle." }
      $hwnd = Resolve-TargetHwnd $inputObject
      if (-not ($hwnd -and $hwnd -ne 0)) { throw "No window handle found for the target." }
      [void](Test-Failsafe)
      $posted = [WindowsComputerUseNative]::PostMessageW([IntPtr]$hwnd, [WindowsComputerUseNative]::WM_CLOSE, [IntPtr]0, [IntPtr]0)
      return ([ordered]@{ ok = $true; action = "close_window"; posted = [bool]$posted })
    }
    "move_window" {
      # Move (not resize) the target window. Default is SWP_NOACTIVATE (no
      # focus steal); activate:true hands the foreground to the moved window.
      # Note: maximized windows are not moved by Windows.
      if (-not (Has-WindowTarget $inputObject)) { throw "Provide windowTitle, processId, or nativeWindowHandle." }
      $x = Get-Prop $inputObject "x" $null
      $y = Get-Prop $inputObject "y" $null
      if ($null -eq $x -or $null -eq $y) { throw "x and y are required for move_window." }
      $el = Get-ObservationWindow $inputObject
      $hwnd = [int64]$el.nativeWindowHandle
      if (-not ($hwnd -and $hwnd -ne 0)) { throw "No window handle found for the target." }
      Assert-NativeInputTarget $hwnd
      $flags = [uint32]([WindowsComputerUseNative]::SWP_NOSIZE -bor [WindowsComputerUseNative]::SWP_NOZORDER)
      if (-not [bool](Get-Prop $inputObject "activate" $false)) {
        $flags = [uint32]($flags -bor [WindowsComputerUseNative]::SWP_NOACTIVATE)
      }
      [void](Test-Failsafe)
      $ok = [WindowsComputerUseNative]::SetWindowPos([IntPtr]$hwnd, [IntPtr]::Zero, [int]$x, [int]$y, 0, 0, $flags)
      $result = [ordered]@{ ok = $true; action = "move_window"; moved = [bool]$ok; x = [int]$x; y = [int]$y; note = if ($ok) { $null } else { "SetWindowPos refused (window may be maximized)." } }
      if ([bool](Get-Prop $inputObject "activate" $false)) {
        # SetWindowPos's implicit activation is silently refused by the
        # Windows foreground lock for background callers, so enforce the
        # switch with the AttachThreadInput helper and report the outcome.
        $activated = Set-WindowForeground $el
        $result["activated"] = [bool]$activated
        if (-not $activated) {
          $result["warning"] = "activate:true was requested but the window could not be brought to the foreground (Windows foreground lock); the window was moved but is not foreground."
        }
      }
      return $result
    }
    "screenshot" {
      $scope = Get-Prop $inputObject 'scope' 'active_window'
      $window = Get-ObservationWindow $inputObject $scope
      if ($null -ne $window) {
        if ([bool](Get-Prop $inputObject 'activate' $false) -and -not (Set-WindowForeground $window)) { throw 'Target activation refused; screenshot not taken.' }
        Update-WindowCache $window
        Update-WindowIdentity $inputObject $window
      }
      $responsive = Get-WindowResponsive $window
      $shot = Capture-Screenshot -WindowElement $(if ($responsive -eq $false) { $null } else { $window }) -MaxWidth ([int](Get-Prop $inputObject 'maxWidth' 1600))
      $result=[ordered]@{ok=$true;action='screenshot';source='win32';targetResponsive=$responsive;screenshot=$shot;degraded=($responsive -eq $false)}
      if ($shot.minimized) { $result['warning'] = 'The window is minimized: Windows draws only its title strip. Call activate_window to restore it, then capture again.' }
      if ($null -ne $window) { $result['windowObservation']=$script:WindowCache[[string]$window.nativeWindowHandle] }
      return $result
    }
    "ocr" {
      # OCR the target window (or the whole desktop) — the fallback for
      # UIA-blind apps (games, self-drawn Tk/Qt, RDP, canvases). Word boxes
      # come back in SCREEN coordinates. With `query`, matched words are also
      # upgraded to the underlying UIA control (FromPoint), so the model can
      # then invoke/click the real control instead of the glyph.
      $scope = Get-Prop $inputObject "scope" "active_window"
      # Native pixels by default: shrinking a wide window first makes its text
      # smaller than OCR reads well, and the helper enlarges small text itself.
      $maxWidth = [int](Get-Prop $inputObject "maxWidth" 0)
      $language = [string](Get-Prop $inputObject "language" "")
      $query = [string](Get-Prop $inputObject "query" "")
      $winEl = $null
      $activationRefused = $false
      $activationError = $null
      if (Has-WindowTarget $inputObject) {
        $winEl = Get-ObservationWindow $inputObject $scope
        # Capture happens on screen pixels: an occluded window would OCR the
        # overlapping content, so honour activate:true before capturing. A
        # refused activation degrades the capture but is not fatal — warn.
        if ([bool](Get-Prop $inputObject "activate" $false)) {
          try { $activationRefused = -not (Set-WindowForeground $winEl) }
          catch {
            if ($_.Exception.Message -notmatch '^(INPUT_TARGET_ACCESS_UNCONFIRMED|ELEVATED_TARGET_DENIED):') { throw }
            $activationRefused = $true
            $activationError = $_.Exception.Message
          }
        }
      } elseif ($scope -ne "desktop") {
        $winEl = Get-ObservationWindow $inputObject $scope
      }
      if ($null -ne $winEl) {
        if ((Get-WindowResponsive $winEl) -eq $false) { throw 'Target is unresponsive; skip OCR and inspect a desktop screenshot.' }
        Update-WindowCache $winEl
        Update-WindowIdentity $inputObject $winEl
      }
      $internalOcr = [bool](Get-Prop $inputObject '_wcuInternalOcr' $false)
      $shot = Capture-Screenshot -WindowElement $winEl -MaxWidth $maxWidth -InMemory:$internalOcr
      if ($shot.windowCaptureFailed) { throw "OCR target has no capturable surface (minimized/hidden?). Restore the window and retry." }
      if ($shot.minimized) { throw "OCR target window is minimized: Windows draws only its title strip, so there is no text to read. Call activate_window to restore it, then read again." }
      $origX = [int]$shot.bounds.x
      $origY = [int]$shot.bounds.y
      $scale = 1.0
      if ($null -ne $shot.imageScale) { $scale = [double]$shot.imageScale }
      $ocr = if ($internalOcr) { Invoke-Ocr -PngBytes $shot.pngBytes -Language $language } else { Invoke-Ocr -PngPath $shot.path -Language $language }
      $lines = New-Object System.Collections.Generic.List[object]
      foreach ($line in $ocr.lines) {
        $words = New-Object System.Collections.Generic.List[object]
        foreach ($w in $line.words) {
          $words.Add([ordered]@{
            text = $w.text
            x = [int]($origX + ($w.x / $scale))
            y = [int]($origY + ($w.y / $scale))
            width = [int]($w.width / $scale)
            height = [int]($w.height / $scale)
          })
        }
        $wordArr = $words.ToArray()
        $lines.Add([ordered]@{ text = $line.text; words = $wordArr; boundingBox = (Get-OcrWordBounds -Words $wordArr) })
      }
      # OCR -> control upgrade: ignore OCR whitespace when matching, then
      # hit-test the center of the matching word run's union box with UIA.
      $matched = New-Object System.Collections.Generic.List[object]
      $matchedLines = New-Object System.Collections.Generic.List[object]
      if ($query.Length -gt 0 -and $lines.Count -gt 0) {
        if ([bool](Get-Prop $inputObject 'resolveControl' $false) -and $null -ne $winEl) {
          if ($winEl.className -eq 'MozillaWindowClass') { [void](Initialize-GeckoPages $winEl @{ watch = [Diagnostics.Stopwatch]::StartNew(); budgetMs = 2000 }) }
          else { [void](Initialize-ChromiumPages $winEl @{ watch = [Diagnostics.Stopwatch]::StartNew(); budgetMs = 2000 }) }
        }
        foreach ($line in $lines) {
          if ($matched.Count -ge 3) { break }
          $lineText = [string]$line.text
          $hit = Find-OcrWordRun -Words @($line.words) -Query $query
          if ($null -eq $hit) { continue }
          $wx = [int]($hit.boundingBox.x + [int]($hit.boundingBox.width / 2))
          $wy = [int]($hit.boundingBox.y + [int]($hit.boundingBox.height / 2))
          $ctl = $null
          $el = $null
          if ([bool](Get-Prop $inputObject 'resolveControl' $false)) { $el = Invoke-Safe { [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($wx, $wy))) } $null }
          if ($null -ne $el) {
            $ctl = [ordered]@{
              controlType = Get-ControlTypeName (Invoke-Safe { $el.Current.ControlType } $null)
              name = Invoke-Safe { $el.Current.Name } ""
              automationId = Invoke-Safe { $el.Current.AutomationId } ""
              className = Invoke-Safe { $el.Current.ClassName } ""
              boundingBox = Convert-Rect (Invoke-Safe { $el.Current.BoundingRectangle } $null)
            }
          }
          $matched.Add([ordered]@{ source = "ocr"; line = $lineText; word = [ordered]@{ text = $hit.text; x = $wx; y = $wy }; boundingBox = $hit.boundingBox; control = $ctl })
          $matchedLines.Add($line)
        }
      }
      $result = [ordered]@{
        ok = $true
        action = "ocr"
        text = $ocr.text
        lines = $lines.ToArray()
        image = $shot.path
        imageBounds = $shot.bounds
        source = if ($winEl -ne $null) { "window" } else { "desktop" }
      }
      $result['coordinateSpace'] = 'screen'
      $result['imageScale'] = $scale
      # The recognizer that read the text, and how much the capture was
      # enlarged for it (1 = read at capture size).
      $result['language'] = $ocr.language
      $result['ocrScale'] = $ocr.readScale
      $result['captureMethod'] = $shot.method
      $result['occludedPossible'] = $shot.occludedPossible
      if ([bool](Get-Prop $inputObject 'includeScreenshot' $false)) { $result['screenshot'] = $shot }
      if ($query.Length -gt 0) {
        $result["query"] = $query
        $result["matched"] = $matched.ToArray()
        # A query asks for that text, not the whole transcript. Word boxes of
        # every line are most of a result (about 50,000 characters for a
        # 1500x900 window of text), so keep the matching lines whole and,
        # without a match, line texts and boxes to reformulate from (#82).
        $result.Remove('text')
        $result["lineCount"] = $lines.Count
        if ($matchedLines.Count -gt 0) {
          $result["lines"] = $matchedLines.ToArray()
          $result["note"] = "'lines' holds only the lines with a match; lineCount counts every recognized line. Call ocr without query for all text and word boxes."
        } else {
          $result["lines"] = @($lines | ForEach-Object { [ordered]@{ text = $_.text; boundingBox = $_.boundingBox } })
          $result["note"] = "No OCR word sequence matched the query (case-insensitive, ignoring whitespace). 'lines' holds every recognized line with its box; call ocr without query for word boxes."
        }
      }
      if ($activationRefused) {
        $reason = if ($activationError) { $activationError } else { 'Windows refused to bring the target window to the foreground.' }
        $result["warning"] = "$reason OCR captured without activating the target. Check for overlapping content before using any coordinates."
      }
      return $result
    }
    "wait" {
      $milliseconds = [int](Get-Prop $inputObject "milliseconds" 500)
      Start-Sleep -Milliseconds $milliseconds
      return ([ordered]@{ ok = $true; action = "wait"; milliseconds = $milliseconds })
    }
    default {
      return $null
    }
  }
  } finally {
    # A step that failed between Start-Input and Complete-Input still replays.
    if ($script:WcuHolding) { [void](Stop-InputHold) }
    Exit-DesktopInput $inputLease
  }
}

# ============================================================================
# Entry points
# ============================================================================

try {
  # Resolve the built-in JSON/Add-Type commands from this PowerShell installation,
  # without searching inherited third-party module paths on the first request.
  Write-BackendStage 'utility-import-start'
  Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
  Write-BackendStage 'utility-import-complete'
  Load-Assemblies
  Set-DpiAware
} catch {
  # One line the server can quote. Otherwise a startup failure reached the
  # model only as "Backend process exited" (#54).
  $inner = $_.Exception
  while ($inner.InnerException) { $inner = $inner.InnerException }
  $hresult = if ($inner.HResult) { ' (HRESULT 0x{0:X8})' -f $inner.HResult } else { '' }
  [Console]::Error.WriteLine(('WCU_BACKEND_STARTUP_FAILED stage={0}: {1}{2}' -f $script:BackendStage, ($_.Exception.Message -replace '\s+', ' ').Trim(), $hresult))
  exit 3
}
Write-BackendStage 'backend-ready'

if ($Persistent) {
  [Console]::Out.WriteLine((@{type='ready';protocol=1;pid=$PID}|ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  # Persistent mode: one JSON request per stdin line, one JSON response per
  # stdout line. Stays alive between actions so repeated calls skip process
  # startup, assembly loading and native-DLL resolution entirely.
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $req = $null
    Write-BackendStage 'request-parse-start'
    try { $req = $line | ConvertFrom-Json } catch {
      [Console]::Error.WriteLine('WCU_BACKEND_PROTOCOL_ERROR: request was not valid JSON')
      [Console]::Out.WriteLine('{"id":null,"ok":false,"error":"WCU_BACKEND_PROTOCOL_ERROR: request was not valid JSON"}')
      [Console]::Out.Flush()
      continue
    }
    Write-BackendStage 'request-parse-complete'
    $id = Get-Prop $req "id" 0
    $name = [string](Get-Prop $req "action" "")
    $result = $null
    try {
      $result = Invoke-Action -Action $name -InputObject (Get-Prop $req "args" $null)
      if ($null -eq $result) { throw "Unknown action '$name'." }
      $notice = [WcuInputHold]::TakeNotice()
      if ($notice -and $result -is [System.Collections.IDictionary]) { $result['userInputNotice'] = $notice }
    } catch {
      $result = [ordered]@{
        ok = $false
        action = $name
        error = $_.Exception.Message
        category = $_.CategoryInfo.Category.ToString()
        scriptStackTrace = $_.ScriptStackTrace
      }
    }
    $result["id"] = $id
    Write-BackendStage 'response-serialize-start'
    Write-Host ($result | ConvertTo-Json -Depth 50 -Compress)
    [Console]::Out.Flush()
  }
  exit 0
} else {
  if ([string]::IsNullOrWhiteSpace($Action)) {
    Write-Host ([ordered]@{ ok = $false; error = "No action given. Pass -Action <name>, or run with -Persistent for the line protocol." } | ConvertTo-Json -Depth 50 -Compress)
    exit 1
  }
  $inputObject = Get-InputObject
  $result = $null
  try {
    $result = Invoke-Action -Action $Action -InputObject $inputObject
    if ($null -eq $result) { throw "Unknown action '$Action'." }
  } catch {
    $result = [ordered]@{
      ok = $false
      action = $Action
      error = $_.Exception.Message
      category = $_.CategoryInfo.Category.ToString()
      scriptStackTrace = $_.ScriptStackTrace
    }
  }
  Write-Host ($result | ConvertTo-Json -Depth 50 -Compress)
  if (-not $result.ok) { exit 1 }
  exit 0
}
