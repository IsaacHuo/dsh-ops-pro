# Where keys or text go: a window and, while it is in front, the control with
# the keyboard focus there. The control is read through UI Automation only when
# the window answers messages, so a hung app cannot hold the call. $Via says how
# the window was chosen (Resolve-InputWindow). Title and name are app text.
function Get-KeyDestination {
  param([long]$Hwnd, [string]$Via)
  $title = New-Object System.Text.StringBuilder 256
  [void][WindowsComputerUseNative]::GetWindowText([IntPtr]$Hwnd, $title, 256)
  $text = $title.ToString()
  if ($text.Length -gt 80) { $text = $text.Substring(0, 80) + '...' }
  $info = [ordered]@{ nativeWindowHandle = $Hwnd; processId = (Get-WindowProcessId $Hwnd); title = $text }
  if ($Via) { $info['via'] = $Via }
  if ([WindowsComputerUseNative]::GetForegroundWindow().ToInt64() -eq $Hwnd -and [WindowsComputerUseNative]::IsResponsive([IntPtr]$Hwnd)) {
    $focused = Invoke-Safe { [System.Windows.Automation.AutomationElement]::FocusedElement } $null
    if ($null -ne $focused) {
      $type = Get-ControlTypeName (Invoke-Safe { $focused.Current.ControlType } $null)
      $name = [string](Invoke-Safe { $focused.Current.Name } '')
      if ($name.Length -gt 60) { $name = $name.Substring(0, 60) + '...' }
      if ($type) { $info['focus'] = if ($name) { "$type '$name'" } else { $type } }
    }
  }
  return $info
}

# A background element action whose UIA provider may take the foreground or
# the pointer on its own: whatever it took is given back, except while a menu
# or list the call opened is showing. The report goes to $script:BackgroundReport.
function Invoke-Guarded {
  param([scriptblock]$Call, [object]$Element)
  $front = [WindowsComputerUseNative]::GetForegroundWindow().ToInt64()
  $cursor = New-Object WindowsComputerUseNative+POINT
  [void][WindowsComputerUseNative]::GetCursorPos([ref]$cursor)
  $procId = [uint32](Invoke-Safe { $Element.Current.ProcessId } 0)
  Assert-InputProcess $procId
  $popups = @([WindowsComputerUseNative]::VisiblePopups($procId))
  $script:BackgroundReport = [ordered]@{}
  if ($script:WcuLowDisruption) { [WcuInputHold]::Snapshot() }
  try { return (& $Call) }
  finally {
    $now = New-Object WindowsComputerUseNative+POINT
    [void][WindowsComputerUseNative]::GetCursorPos([ref]$now)
    if ($now.x -ne $cursor.x -or $now.y -ne $cursor.y) {
      $box = Convert-Rect (Invoke-Safe { $Element.Current.BoundingRectangle } $null)
      if ($null -ne $box -and $now.x -ge $box.x - 2 -and $now.y -ge $box.y - 2 -and $now.x -le $box.x + $box.width + 2 -and $now.y -le $box.y + $box.height + 2) {
        [void][WindowsComputerUseNative]::SetCursorPos($cursor.x, $cursor.y)
        $script:BackgroundReport['pointer'] = 'returned (the app moved it)'
      }
    }
    $after = [WindowsComputerUseNative]::GetForegroundWindow().ToInt64()
    if ($after -ne $front -and $procId -and (Get-WindowProcessId $after) -eq $procId -and $front -and [WindowsComputerUseNative]::IsWindow([IntPtr]$front)) {
      $opened = @([WindowsComputerUseNative]::VisiblePopups($procId) | Where-Object { $popups -notcontains $_ })
      $script:BackgroundReport['foreground'] = if ([WindowsComputerUseNative]::InMenuMode([IntPtr]$after) -or $opened.Count) { 'kept: the app came forward and a menu, list or dialog it opened is showing' }
        elseif ([WindowsComputerUseNative]::GiveForeground([IntPtr]$front)) { 'returned (the app had come forward)' } else { 'kept: the app came forward and Windows refused to switch back' }
      if ($script:WcuLowDisruption -and $script:BackgroundReport['foreground'] -like 'kept*' -and [WcuInputHold]::ArmGuard([long[]](@([int64]$after) + $opened), [long[]]@([int64]$procId))) { $script:BackgroundReport['userInput'] = [WcuInputHold]::GuardNote }
    }
  }
}

# A Win32 or WinForms push button, check box or radio button takes BM_CLICK in
# its own message queue: no pointer, no foreground (measured on WinForms; the
# managed UIA proxy's Invoke calls SetForegroundWindow instead). Posted, so a
# dialog the click opens cannot hold the call; WM_NULL then waits until the
# button has handled it. $null when the element is no such button.
function Invoke-NativeButton {
  param([object]$Element)
  $hwnd = Invoke-Safe { [int64]$Element.Current.NativeWindowHandle } 0
  if (-not $hwnd) { return $null }
  $class = New-Object System.Text.StringBuilder 128
  [void][WindowsComputerUseNative]::GetClassName([IntPtr]$hwnd, $class, 128)
  if ($class.ToString() -notmatch '^(Button|WindowsForms10\.BUTTON\..*)$') { return $null }
  # BS_GROUPBOX (7) frames other controls and takes no click.
  if (([WindowsComputerUseNative]::GetWindowLong([IntPtr]$hwnd, -16) -band 0xF) -eq 7) { return $null }
  if (-not [WindowsComputerUseNative]::IsWindowEnabled([IntPtr]$hwnd)) { throw 'ELEMENT_DISABLED: the button is disabled; it does not respond to clicks.' }
  [void](Test-Failsafe)
  if (-not [WindowsComputerUseNative]::PostMessageW([IntPtr]$hwnd, [WindowsComputerUseNative]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)) { return $null }
  $ignored = [UIntPtr]::Zero
  [void][WindowsComputerUseNative]::SendMessageTimeout([IntPtr]$hwnd, 0, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 2000, [ref]$ignored)
  return 'BM_CLICK'
}

$script:NativeEditClass = '^(Edit|RichEdit\w*|WindowsForms10\.EDIT\..*|WindowsForms10\.RichEdit\w*\..*)$'

# A Win32 edit or rich edit takes its text through EM_SETSEL + EM_REPLACESEL,
# as typing would (the change notifications fire), with no focus, foreground
# or clipboard. $null when the element is no such control.
function Set-NativeEditText {
  param([object]$Element, [string]$Value)
  $hwnd = Invoke-Safe { [int64]$Element.Current.NativeWindowHandle } 0
  if (-not $hwnd) { return $null }
  $class = New-Object System.Text.StringBuilder 128
  [void][WindowsComputerUseNative]::GetClassName([IntPtr]$hwnd, $class, 128)
  if ($class.ToString() -notmatch $script:NativeEditClass) { return $null }
  # ES_READONLY (0x0800)
  if (([WindowsComputerUseNative]::GetWindowLong([IntPtr]$hwnd, -16) -band 0x0800) -ne 0) { throw 'ELEMENT_READ_ONLY: the field is read-only; it takes no value.' }
  if (-not [WindowsComputerUseNative]::IsWindowEnabled([IntPtr]$hwnd)) { throw 'ELEMENT_DISABLED: the field is disabled; it takes no value.' }
  [void](Test-Failsafe)
  $ignored = [UIntPtr]::Zero
  if ([WindowsComputerUseNative]::SendMessageTimeout([IntPtr]$hwnd, [WindowsComputerUseNative]::EM_SETSEL, [UIntPtr]::Zero, [IntPtr](-1), 2, 2000, [ref]$ignored) -eq [IntPtr]::Zero) { return $null }
  if ([WindowsComputerUseNative]::SendMessageTimeoutW([IntPtr]$hwnd, [WindowsComputerUseNative]::EM_REPLACESEL, [IntPtr]1, $Value, 2, 2000, [ref]$ignored) -eq [IntPtr]::Zero) { return $null }
  return 'EM_REPLACESEL'
}

# Typing without the keyboard: when the control with the focus in the window
# the text goes to is a Win32 edit, EM_REPLACESEL puts the text at its caret
# (in place of the selection), as typing or a paste would, with no pointer,
# keyboard, clipboard or foreground. Text with line breaks is left to real
# input, since a single-line edit handles Enter on its own. $null when this
# does not apply; else the edit and how much its length grew.
function Set-FocusedEditText {
  param([long]$Hwnd, [string]$Text)
  if (-not $Hwnd -or $Text -match "[`r`n]") { return $null }
  $focus = [WindowsComputerUseNative]::FocusedWindow([IntPtr]$Hwnd).ToInt64()
  if (-not $focus -or (Get-RootWindow $focus) -ne $Hwnd) { return $null }
  $class = New-Object System.Text.StringBuilder 128
  [void][WindowsComputerUseNative]::GetClassName([IntPtr]$focus, $class, 128)
  if ($class.ToString() -notmatch $script:NativeEditClass) { return $null }
  # ES_READONLY (0x0800)
  if (([WindowsComputerUseNative]::GetWindowLong([IntPtr]$focus, -16) -band 0x0800) -ne 0 -or -not [WindowsComputerUseNative]::IsWindowEnabled([IntPtr]$focus)) { return $null }
  [void](Test-Failsafe)
  $reply = [UIntPtr]::Zero
  if ([WindowsComputerUseNative]::SendMessageTimeout([IntPtr]$focus, [WindowsComputerUseNative]::WM_GETTEXTLENGTH, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 2000, [ref]$reply) -eq [IntPtr]::Zero) { return $null }
  $before = [double]$reply.ToUInt64()
  $ignored = [UIntPtr]::Zero
  if ([WindowsComputerUseNative]::SendMessageTimeoutW([IntPtr]$focus, [WindowsComputerUseNative]::EM_REPLACESEL, [IntPtr]1, $Text, 2, 2000, [ref]$ignored) -eq [IntPtr]::Zero) { return $null }
  [void][WindowsComputerUseNative]::SendMessageTimeout([IntPtr]$focus, [WindowsComputerUseNative]::WM_GETTEXTLENGTH, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 2000, [ref]$reply)
  return @{ hwnd = $focus; grew = [int]([double]$reply.ToUInt64() - $before) }
}

function Get-BestTextControl {
  # Pick the most likely text-input control inside a window: the largest
  # (by bounding-box area) enabled Edit or Document control.
  param([System.Windows.Automation.AutomationElement]$Window)
  $cands = New-Object System.Collections.Generic.List[object]
  try {
    $cond1 = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Edit)
    $cond2 = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Document)
    $orCond = New-Object System.Windows.Automation.OrCondition ($cond1, $cond2)
    $enabledCond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::IsEnabledProperty), $true
    $cond = New-Object System.Windows.Automation.AndCondition ($orCond, $enabledCond)
    $coll = $Window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    for ($i = 0; $i -lt $coll.Count; $i++) {
      $el = $coll.Item($i)
      $rect = Convert-Rect (Invoke-Safe { $el.Current.BoundingRectangle } $null)
      $area = 0
      if ($null -ne $rect) { $area = [int64]$rect.width * [int64]$rect.height }
      $cands.Add([pscustomobject]@{ el = $el; area = $area })
    }
  } catch {
    return $null
  }
  if ($cands.Count -eq 0) { return $null }
  return ($cands | Sort-Object area -Descending | Select-Object -First 1).el
}

function Focus-TextControl {
  # Set keyboard focus on the window's main text control. Returns the
  # control type name when focus was set, else $null.
  param([System.Windows.Automation.AutomationElement]$Window)
  $el = Get-BestTextControl $Window
  if ($null -eq $el) { return $null }
  [void](Test-Failsafe)
  $ok = Invoke-Safe { $el.SetFocus(); $true } $false
  if (-not $ok) { return $null }
  Start-Sleep -Milliseconds 80
  $focused = Invoke-Safe { [bool]$el.Current.HasKeyboardFocus } $false
  if (-not $focused) { return $null }
  return (Get-ControlTypeName (Invoke-Safe { $el.Current.ControlType } $null))
}

# ============================================================================
# Homing: remember window rects when observed, compensate coordinates when
# the window moved between observation and action (desktop-touch-mcp Tier 1).
# ============================================================================

$script:WindowCache = @{}   # hwnd -> @{ x=..; y=..; ts=.. }
$script:WindowObservations = @{} # immutable token -> window identity and origin

function Get-FreshWindowRect {
  param([object]$Element)
  if (Get-Prop $Element 'nativeWindowHandle' 0) { return $Element.boundingBox }
  $hwnd = Invoke-Safe { [int64]$Element.Current.NativeWindowHandle } 0
  if ($hwnd) {
    $nativeRect = New-Object WindowsComputerUseNative+RECT
    if ([WindowsComputerUseNative]::GetWindowRect([IntPtr]$hwnd, [ref]$nativeRect)) {
      return [ordered]@{x=$nativeRect.left;y=$nativeRect.top;width=$nativeRect.right-$nativeRect.left;height=$nativeRect.bottom-$nativeRect.top}
    }
  }
  return Convert-Rect (Invoke-Safe { $Element.Current.BoundingRectangle } $null)
}

function Update-WindowCache {
  param([object]$Element)
  $hwnd = if (Get-Prop $Element 'nativeWindowHandle' 0) { [int64]$Element.nativeWindowHandle } else { Invoke-Safe { $Element.Current.NativeWindowHandle } 0 }
  if (-not $hwnd) { return }
  $rect = Get-FreshWindowRect $Element
  if ($null -eq $rect) { return }
  if ($null -eq $script:WindowObservations) { $script:WindowObservations=@{} }
  $token=[Guid]::NewGuid().ToString('N')
  $owner=[uint32](Get-Prop $Element 'processId' 0)
  if (-not $owner) { [void][WindowsComputerUseNative]::GetWindowThreadProcessId([IntPtr]$hwnd,[ref]$owner) }
  $entry=@{token=$token;x=$rect.x;y=$rect.y;hwnd=$hwnd;processId=$owner;ts=[DateTimeOffset]::Now.ToUnixTimeMilliseconds()}
  $script:WindowCache[[string]$hwnd]=$entry
  $script:WindowObservations[$token]=$entry
  if ($Element -is [System.Collections.IDictionary]) { $Element['observationToken']=$token }
  if ($script:WindowObservations.Count -gt 512) {
    foreach ($old in @($script:WindowObservations.GetEnumerator() | Sort-Object { [long]$_.Value.ts } | Select-Object -First 128)) {
      $script:WindowObservations.Remove($old.Key)
    }
  }
}

function Home-Point {
  # A point is already in current screen coordinates unless the caller
  # explicitly binds it to the origin of a previous observation.
  param([int]$X,[int]$Y,[object]$Target,[string]$ObservationToken='')
  $result=[ordered]@{x=$X;y=$Y;homed=$null}
  if (-not $ObservationToken) { return $result }
  $hwnd=if(Get-Prop $Target 'nativeWindowHandle' 0){[int64]$Target.nativeWindowHandle}else{Invoke-Safe {$Target.Current.NativeWindowHandle} 0}
  $cached=$script:WindowObservations[$ObservationToken]
  if ($null -eq $cached -or [int64]$cached.hwnd -ne $hwnd -or ([DateTimeOffset]::Now.ToUnixTimeMilliseconds()-[long]$cached.ts) -gt 300000) {
    throw 'OBSERVATION_TOKEN_STALE: re-observe the target and use its token or current screen coordinates.'
  }
  $owner=[uint32]0
  [void][WindowsComputerUseNative]::GetWindowThreadProcessId([IntPtr]$hwnd,[ref]$owner)
  if ($owner -ne [uint32]$cached.processId) { throw 'OBSERVATION_TOKEN_STALE: the target process changed.' }
  $now=Get-FreshWindowRect $Target
  if ($null -eq $now) { throw 'OBSERVATION_TOKEN_STALE: the target geometry is unavailable.' }
  $dx=$now.x-[int]$cached.x;$dy=$now.y-[int]$cached.y
  if ($dx -ne 0 -or $dy -ne 0) {
    $result.x=$X+$dx;$result.y=$Y+$dy
    $result.homed=[ordered]@{dx=$dx;dy=$dy;observationToken=$ObservationToken}
  }
  return $result
}

# ----------------------------------------------------------------------------
# Window identity guard: when the caller targets a window BY TITLE, remember
# which HWND/PID that title referred to at observation time. If the title now
# resolves to a different HWND/PID (app restarted, window recreated), acting
# on the new window with stale coordinates/focus would be a silent miss or —
# worse — a hit on the wrong app. Fail closed with an identity_changed error.
# ----------------------------------------------------------------------------
$script:WindowIdentity = @{}   # lowercased title -> @{ hwnd=; pid=; ts= }

function Update-WindowIdentity {
  param([object]$InputObject, [object]$Target)
  $title = [string](Get-Prop $InputObject "windowTitle" "")
  if ([string]::IsNullOrWhiteSpace($title) -or $null -eq $Target) { return }
  $hwnd = if (Get-Prop $Target 'nativeWindowHandle' 0) { [int64]$Target.nativeWindowHandle } else { Invoke-Safe { [int64]$Target.Current.NativeWindowHandle } 0 }
  $procId = if (Get-Prop $Target 'processId' 0) { [int]$Target.processId } else { Invoke-Safe { [int]$Target.Current.ProcessId } 0 }
  $script:WindowIdentity[$title.Trim().ToLowerInvariant()] = @{ hwnd = $hwnd; pid = $procId; ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }
}

function Assert-WindowIdentity {
  param([object]$InputObject, [object]$Target)
  $title = [string](Get-Prop $InputObject "windowTitle" "")
  if ([string]::IsNullOrWhiteSpace($title) -or $null -eq $Target) { return }
  $key = $title.Trim().ToLowerInvariant()
  $hwnd = if (Get-Prop $Target 'nativeWindowHandle' 0) { [int64]$Target.nativeWindowHandle } else { Invoke-Safe { [int64]$Target.Current.NativeWindowHandle } 0 }
  $procId = if (Get-Prop $Target 'processId' 0) { [int]$Target.processId } else { Invoke-Safe { [int]$Target.Current.ProcessId } 0 }
  $cached = $script:WindowIdentity[$key]
  if ($null -eq $cached) {
    # First sighting of this title: baseline it, no check.
    $script:WindowIdentity[$key] = @{ hwnd = $hwnd; pid = $procId; ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }
    return
  }
  $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  if (($now - [int64]$cached.ts) -gt 300000) {
    # Stale baseline (older than 5 min): silently re-baseline rather than
    # failing on a long-ago observation.
    $script:WindowIdentity[$key] = @{ hwnd = $hwnd; pid = $procId; ts = $now }
    return
  }
  if ($hwnd -ne [int64]$cached.hwnd -or $procId -ne [int]$cached.pid) {
    throw "identity_changed: the window titled '$title' is a different window than when last observed (HWND $([int64]$cached.hwnd) -> $hwnd, PID $([int]$cached.pid) -> $procId). The app may have restarted or the window was recreated. Re-observe with snapshot before acting."
  }
  $script:WindowIdentity[$key] = @{ hwnd = $hwnd; pid = $procId; ts = $now }
}

# ============================================================================
# Emergency-stop failsafe: parking the physical cursor in the top-left corner
# of the virtual screen for ~500ms refuses further input actions (the user's
# panic brake). Config: WCU_FAILSAFE=0 disables; WCU_FAILSAFE_CORNER="x,y"
# moves the corner; WCU_FAILSAFE_RADIUS (default 12) and WCU_FAILSAFE_HOLD_MS
# (default 500) tune it.
# ============================================================================

$script:FailsafeFirstSeen = 0

function Test-Failsafe {
  # Quiet actions are cancelled by the host's request/series state. They do not
  # arm the global stop listener; requiring its event here rejects the very
  # first background UIA/BM_CLICK/EM_REPLACESEL call in a real DSH session.
  # Assert-InputAllowed refuses physical input until the host upgrades the lease.
  if ($env:WCU_CANCEL_EVENT -and -not $script:WcuQuiet) { [WindowsComputerUseNative]::ThrowIfCancelled() }
  # Returns $true when an input action is ALLOWED. Throws when the failsafe
  # is engaged (cursor parked in the corner beyond the hold time).
  if ([string]$env:WCU_FAILSAFE -eq '0' -or $script:WcuCornerFailsafe -eq $false) { return $true }
  $radius = 12
  if ("$env:WCU_FAILSAFE_RADIUS" -match '^\d+$') { $radius = [int]$env:WCU_FAILSAFE_RADIUS }
  $holdMs = 500
  if ("$env:WCU_FAILSAFE_HOLD_MS" -match '^\d+$') { $holdMs = [int]$env:WCU_FAILSAFE_HOLD_MS }

  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $cx = $vs.Left
  $cy = $vs.Top
  if ("$env:WCU_FAILSAFE_CORNER" -match '^(-?\d+)\s*,\s*(-?\d+)$') { $cx = [int]$Matches[1]; $cy = [int]$Matches[2] }

  $p = New-Object WindowsComputerUseNative+POINT
  [void][WindowsComputerUseNative]::GetCursorPos([ref]$p)
  $inCorner = [Math]::Abs($p.x - $cx) -le $radius -and [Math]::Abs($p.y - $cy) -le $radius
  if (-not $inCorner) { $script:FailsafeFirstSeen = 0; return $true }
  $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  if ($script:FailsafeFirstSeen -eq 0) { $script:FailsafeFirstSeen = $now; return $true }
  if (($now - $script:FailsafeFirstSeen) -ge $holdMs) {
    throw "EMERGENCY STOP: the mouse is parked in the failsafe corner ($cx,$cy) and input is refused. Move the mouse away to resume."
  }
  return $true
}

# ============================================================================
# Background (PostMessage) input: no system input queue, no foreground steal.
# ============================================================================

function Resolve-TargetHwnd {
  param([object]$InputObject)
  $target = Get-ObservationWindow $InputObject
  if ($null -eq $target) { throw 'No native target window found.' }
  Assert-NativeInputTarget ([int64]$target.nativeWindowHandle)
  return [int64]$target.nativeWindowHandle
}

function Post-BackgroundClick {
  # Post a button press/release at screen coords into the target window's
  # message queue (converted to client coords). Returns $true when the
  # messages were queued. The app may still ignore them (Chromium/Electron/
  # UWP) — callers must label the result as unverified.
  param([long]$Hwnd, [int]$X, [int]$Y, [string]$Button, [int]$Count)
  Assert-NativeInputTarget $Hwnd
  $ptr = [IntPtr]$Hwnd
  $pt = New-Object WindowsComputerUseNative+POINT
  $pt.x = $X
  $pt.y = $Y
  if (-not [WindowsComputerUseNative]::ScreenToClient($ptr, [ref]$pt)) { return $false }
  $dbl = [uint32]0
  switch ($Button) {
      "right" { $down = [WindowsComputerUseNative]::WM_RBUTTONDOWN; $up = [WindowsComputerUseNative]::WM_RBUTTONUP; $mk = [WindowsComputerUseNative]::MK_RBUTTON }
      "middle" { $down = [WindowsComputerUseNative]::WM_MBUTTONDOWN; $up = [WindowsComputerUseNative]::WM_MBUTTONUP; $mk = [WindowsComputerUseNative]::MK_MBUTTON }
      default {
        $down = [WindowsComputerUseNative]::WM_LBUTTONDOWN
        $up = [WindowsComputerUseNative]::WM_LBUTTONUP
        $mk = [WindowsComputerUseNative]::MK_LBUTTON
        $dbl = [WindowsComputerUseNative]::WM_LBUTTONDBLCLK
      }
  }
  $lp = [WindowsComputerUseNative]::MakeLParam($pt.x, $pt.y)
  [void](Test-Failsafe)
  $ok = [WindowsComputerUseNative]::PostMessageW($ptr, $down, [IntPtr]$mk, $lp)
  Start-Sleep -Milliseconds 30
  $ok = [WindowsComputerUseNative]::PostMessageW($ptr, $up, [IntPtr]0, $lp) -and $ok
  if ($Count -ge 2 -and $dbl -ne 0) {
    # A real double-click: the double-click message carries the click, so a
    # second up completes it.
    Start-Sleep -Milliseconds 30
    [void](Test-Failsafe)
    $ok = [WindowsComputerUseNative]::PostMessageW($ptr, $dbl, [IntPtr]$mk, $lp) -and $ok
    Start-Sleep -Milliseconds 30
    $ok = [WindowsComputerUseNative]::PostMessageW($ptr, $up, [IntPtr]0, $lp) -and $ok
  }
  Start-Sleep -Milliseconds 40
  return $ok
}

# Posted keyboard messages go to the control with the keyboard focus in the
# target window. Each thread keeps its own focus while its windows are in the
# background. A top-level window does not pass characters posted to it on to
# its edit control, so posting to the window itself typed nothing. The focus
# may be the window itself (Chromium), but never a window outside the target.
function Get-BackgroundKeyTarget {
  param([long]$Hwnd)
  Assert-NativeInputTarget $Hwnd
  $focus = [WindowsComputerUseNative]::FocusedWindow([IntPtr]$Hwnd).ToInt64()
  if (-not $focus -or (Get-RootWindow $focus) -ne (Get-RootWindow $Hwnd)) {
    throw "background_unavailable: no control in the target window has the keyboard focus, so posted characters would reach nothing. Focus a field first (focus or click), or use method:'auto' / dispatch:'foreground'."
  }
  return $focus
}

# The text length of a Win32 edit, else $null: other controls answer
# WM_GETTEXTLENGTH with their caption, not their content.
function Get-EditTextLength {
  param([long]$Hwnd)
  $class = New-Object System.Text.StringBuilder 128
  [void][WindowsComputerUseNative]::GetClassName([IntPtr]$Hwnd, $class, 128)
  if ($class.ToString() -notmatch $script:NativeEditClass) { return $null }
  $reply = [UIntPtr]::Zero
  if ([WindowsComputerUseNative]::SendMessageTimeout([IntPtr]$Hwnd, [WindowsComputerUseNative]::WM_GETTEXTLENGTH, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 1000, [ref]$reply) -eq [IntPtr]::Zero) { return $null }
  return [int64]$reply.ToUInt64()
}

# Capture the expected post-input value of a small, plain Win32 edit. Treat
# password fields and unsupported or ambiguous reads as unverified.
function Get-SendInputEdit {
  param([IntPtr]$Focus, [string]$Text)
  if ($Focus -eq [IntPtr]::Zero -or $Text -match '\p{Cc}') { return $null }
  $class = New-Object System.Text.StringBuilder 128
  [void][WindowsComputerUseNative]::GetClassName($Focus, $class, 128)
  if ($class.ToString() -notmatch $script:NativeEditClass) { return $null }
  if (([WindowsComputerUseNative]::GetWindowLong($Focus, -16) -band 0x0020) -ne 0) { return $null } # ES_PASSWORD
  $reply = [UIntPtr]::Zero
  # EM_GETPASSWORDCHAR can identify a password mask installed at runtime.
  if ([WindowsComputerUseNative]::SendMessageTimeout($Focus, 0x00D2, [UIntPtr]::Zero, [IntPtr]::Zero, 3, 100, [ref]$reply) -eq [IntPtr]::Zero -or $reply.ToUInt64() -ne 0) { return $null }
  if ([WindowsComputerUseNative]::SendMessageTimeout($Focus, [WindowsComputerUseNative]::WM_GETTEXTLENGTH, [UIntPtr]::Zero, [IntPtr]::Zero, 3, 100, [ref]$reply) -eq [IntPtr]::Zero -or $reply.ToUInt64() + $Text.Length -gt 32768) { return $null }
  # Leave room for text the application adds itself, such as an autocomplete suffix.
  $capacity = [int]$reply.ToUInt64() + $Text.Length + 1026
  $before = [WindowsComputerUseNative]::ReadEditText($Focus, $capacity)
  if ($null -eq $before) { return $null }
  # RichEdit may count a line break as one selection unit but return CRLF in text.
  if ($class.ToString() -match 'RichEdit' -and $before -match "[`r`n]") { return $null }
  $selection = [WindowsComputerUseNative]::ReadEditSelection($Focus)
  if ($null -eq $selection) { return $null }
  $start, $end = $selection
  if ($start -gt $end -or $end -gt $before.Length) { return $null }
  $head = $before.Substring(0, $start) + $Text
  $tail = $before.Substring($end)
  $expected = $head + $tail
  if ([string]::Equals($expected, $before, [StringComparison]::Ordinal)) { return $null }
  return @{ expected = $expected; head = $head; tail = $tail; capacity = $capacity }
}

# SendInput returns once the keys sit in the target thread's input queue, but
# a key reaches whichever window has the focus when that thread takes it out.
# Giving the foreground back before then drops the rest of the text or sends
# it elsewhere (issue #90). So the foreground stays until the target has taken
# the keys; a repaint requested now arrives only after the last one.
#  - A readable edit is done once it holds the expected text. The wait goes on
#    while its text changes or the repaint is pending. After the repaint, reads
#    that show no change for 400 ms mean the keys are used up.
#  - Any other control waits at least 150 ms and until the repaint.
# The cap grows with the text. A foreground or focus change ends the wait.
# Returns 'observed', 'changed' (all typed text arrived, and the application
# added text or changed letter case), 'incomplete', or $null (not verified).
function Wait-SendInputEdit {
  param([IntPtr]$Front, [IntPtr]$Focus, [hashtable]$Edit, [int]$Length = 1)
  $wait = [Diagnostics.Stopwatch]::StartNew()
  $paint = [WindowsComputerUseNative]::RequestPaint($Focus)
  $limit = if ($null -eq $Edit) { [Math]::Min(5000, 150 + 50 * $Length) } else { [Math]::Min(15000, 1000 + 50 * $Length) }
  $classify = {
    param([string]$Value)
    if ([string]::Equals($Value, $Edit.expected, [StringComparison]::OrdinalIgnoreCase) -or
        ($Value.Length -gt $Edit.expected.Length -and $Value.StartsWith($Edit.head, [StringComparison]::Ordinal) -and $Value.EndsWith($Edit.tail, [StringComparison]::Ordinal))) { 'changed' } else { 'incomplete' }
  }
  $last = $null
  $still = [Diagnostics.Stopwatch]::StartNew()
  do {
    [void](Test-Failsafe)
    if ([WindowsComputerUseNative]::GetForegroundWindow() -ne $Front -or [WindowsComputerUseNative]::FocusedWindow($Front) -ne $Focus) {
      if ($null -eq $Edit) { return $null }
      $value = [WindowsComputerUseNative]::ReadEditText($Focus, $Edit.capacity)
      if ($null -ne $value -and [string]::Equals($value, $Edit.expected, [StringComparison]::Ordinal)) { return 'observed' }
      return 'incomplete'
    }
    $taken = -not ($paint -and [WindowsComputerUseNative]::PaintPending($Focus))
    if ($null -eq $Edit) {
      if ($taken -and $wait.ElapsedMilliseconds -ge 150) { return $null }
      Start-Sleep -Milliseconds 10
    } else {
      $value = [WindowsComputerUseNative]::ReadEditText($Focus, $Edit.capacity)
      if ($null -ne $value) {
        if ([string]::Equals($value, $Edit.expected, [StringComparison]::Ordinal)) { return 'observed' }
        if ($null -eq $last -or -not [string]::Equals($value, $last, [StringComparison]::Ordinal)) { $last = $value; $still.Restart() }
        elseif ($taken -and $still.ElapsedMilliseconds -ge 400) { return (& $classify $value) }
      }
      Start-Sleep -Milliseconds 25
    }
  } while ($wait.ElapsedMilliseconds -lt $limit)
  if ($null -eq $last) { return $null }
  if ($still.ElapsedMilliseconds -ge 400 -and -not ($paint -and [WindowsComputerUseNative]::PaintPending($Focus))) { return (& $classify $last) }
  return 'incomplete'
}

# Posted characters arrive after the post returns. For a Win32 edit, wait up
# to a second until its length grew by the text; when it did not (typing over
# a selection), the text is still found in its value. $null when the control
# is no Win32 edit and cannot be checked.
function Test-BackgroundTyped {
  param([long]$Hwnd, $Before, [string]$Text)
  if ($null -eq $Before) { return $null }
  $deadline = [DateTime]::UtcNow.AddMilliseconds(1000)
  do {
    Start-Sleep -Milliseconds 40
    $now = Get-EditTextLength $Hwnd
    if ($null -ne $now -and $now - $Before -eq $Text.Length) { return $true }
  } while ([DateTime]::UtcNow -lt $deadline)
  $value = Get-ValueText (Invoke-Safe { [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Hwnd) } $null)
  return ($null -ne $value -and $value.Contains($Text))
}

function Post-BackgroundText {
  # Post WM_CHAR per UTF-16 code unit to the given control. No clipboard,
  # no foreground, no system input queue. Works on controls that accept char
  # input (Edit, RichEdit, most Win32 dialogs).
  param([long]$Hwnd, [string]$Text)
  Assert-NativeInputTarget $Hwnd
  $ptr = [IntPtr]$Hwnd
  $allOk = $true
  foreach ($ch in $Text.ToCharArray()) {
    [void](Test-Failsafe)
    $ok = [WindowsComputerUseNative]::PostMessageW($ptr, [WindowsComputerUseNative]::WM_CHAR, [IntPtr][int][char]$ch, [IntPtr]1)
    if (-not $ok) { $allOk = $false }
    Start-Sleep -Milliseconds 5
  }
  return $allOk
}

# ============================================================================
# OCR (Windows.Media.Ocr via a compiled C# WinRT helper): the fallback for
# UIA-blind apps (games, self-drawn Tk/Qt, RDP, canvases). Word boxes come
# back in the image's pixel coords; the caller maps them to screen coords.
#
# PowerShell 5.1 cannot resolve WinRT type literals reliably on recent
# builds, so the WinRT calls live in a small C# helper compiled against
# Windows.winmd and cached in TEMP (same pattern as the main native DLL).
# ============================================================================

$script:WcuOcrCs = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Threading.Tasks;
using Windows.Foundation;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;
using Windows.Storage.Streams;

public static class WindowsComputerUseOcr {
  private static T WaitOp<T>(IAsyncOperation<T> op) {
    var tcs = new TaskCompletionSource<T>();
    op.Completed = (o, s) => {
      try {
        if (s == AsyncStatus.Completed) tcs.SetResult(o.GetResults());
        else if (s == AsyncStatus.Canceled) tcs.SetCanceled();
        else tcs.SetException(new Exception("OCR async operation failed (status: " + s + ")."));
      } catch (Exception ex) { tcs.TrySetException(ex); }
    };
    return tcs.Task.GetAwaiter().GetResult();
  }

  // No tag: the Windows user languages, as before. A tag picks the installed
  // recognizer it names or that extends it ("zh-Hans" reads with zh-Hans-CN).
  public static OcrEngine CreateEngine(string tag) {
    if (String.IsNullOrWhiteSpace(tag)) {
      OcrEngine profile = OcrEngine.TryCreateFromUserProfileLanguages();
      if (profile == null) throw new Exception("No OCR language is installed for this user. " + InstalledLanguages());
      return profile;
    }
    string wanted = tag.Trim();
    foreach (Language language in OcrEngine.AvailableRecognizerLanguages)
      if (String.Equals(language.LanguageTag, wanted, StringComparison.OrdinalIgnoreCase)) return OcrEngine.TryCreateFromLanguage(language);
    foreach (Language language in OcrEngine.AvailableRecognizerLanguages)
      if (language.LanguageTag.StartsWith(wanted + "-", StringComparison.OrdinalIgnoreCase)) return OcrEngine.TryCreateFromLanguage(language);
    throw new Exception("OCR language '" + wanted + "' is not installed. " + InstalledLanguages());
  }

  public static string InstalledLanguages() {
    var tags = new List<string>();
    foreach (Language language in OcrEngine.AvailableRecognizerLanguages) tags.Add(language.LanguageTag);
    return "Installed OCR languages: " + (tags.Count == 0 ? "none" : String.Join(", ", tags.ToArray())) + ". Windows adds one with a language's optical character recognition feature (Settings > Time & language > Language & region).";
  }

  // Windows OCR misreads small text (#75). As in Text-Grab, a first pass
  // measures the words; when the median word is under 30 px tall the image is
  // read again enlarged toward 36 px, at most 3x and within the engine's
  // maximum image size and a 36-megapixel budget. On rendered 9-20 px UI text
  // this halved the character error rate; enlarging 4x did worse than 3x.
  public const double TargetWordHeight = 36, MaxUpscale = 3, PixelBudget = 36e6;
  public static double Fit(int width, int height, double maxDimension) {
    return Math.Min(maxDimension / Math.Max(width, height), Math.Sqrt(PixelBudget / ((double)width * height)));
  }
  public static double ReadScale(double[] wordHeights, int width, int height, double maxDimension) {
    double scale = MaxUpscale;
    if (wordHeights.Length > 0) {
      var sorted = (double[])wordHeights.Clone();
      Array.Sort(sorted);
      double median = sorted[sorted.Length / 2];
      if (median > 0) scale = Math.Min(MaxUpscale, TargetWordHeight / median);
    }
    return Math.Min(scale, Fit(width, height, maxDimension));
  }

  // Chinese and Japanese lines come back with a space between characters.
  // Their words are joined the way PowerToys Text Extractor does it
  // (OcrTextFormatter): a space only next to a word holding Latin letters or
  // digits, never after opening or before closing punctuation.
  public static bool UsesSpaces(string languageTag) {
    return !(languageTag.StartsWith("zh", StringComparison.OrdinalIgnoreCase) || languageTag.StartsWith("ja", StringComparison.OrdinalIgnoreCase));
  }
  private static bool Punctuation(UnicodeCategory c) {
    return c == UnicodeCategory.ConnectorPunctuation || c == UnicodeCategory.DashPunctuation || c == UnicodeCategory.OpenPunctuation || c == UnicodeCategory.ClosePunctuation
      || c == UnicodeCategory.InitialQuotePunctuation || c == UnicodeCategory.FinalQuotePunctuation || c == UnicodeCategory.OtherPunctuation;
  }
  private static bool TightPunctuation(int point) {
    switch (point) {
      case 0x3001: case 0x3002: case 0x30FB: case 0xFF01: case 0xFF05: case 0xFF0C: case 0xFF0E:
      case 0xFF1A: case 0xFF1B: case 0xFF1F: case 0xFF61: case 0xFF64: case 0xFF65: return true;
    }
    return false;
  }
  public static string JoinWords(IList<string> words) {
    var sb = new StringBuilder();
    bool started = false, leftSpaces = false;
    int leftLast = 0;
    UnicodeCategory leftCategory = UnicodeCategory.OtherNotAssigned;
    foreach (string word in words) {
      if (String.IsNullOrEmpty(word)) continue;
      int first = -1, last = 0;
      UnicodeCategory firstCategory = UnicodeCategory.OtherNotAssigned, lastCategory = UnicodeCategory.OtherNotAssigned;
      bool spaces = false, punctuationOnly = true;
      for (int i = 0; i < word.Length; i += Char.IsSurrogatePair(word, i) ? 2 : 1) {
        int point = Char.IsSurrogatePair(word, i) ? Char.ConvertToUtf32(word, i) : word[i];
        UnicodeCategory category = CharUnicodeInfo.GetUnicodeCategory(word, i);
        if (first < 0) { first = point; firstCategory = category; }
        last = point; lastCategory = category;
        spaces |= category == UnicodeCategory.UppercaseLetter || category == UnicodeCategory.LowercaseLetter || category == UnicodeCategory.TitlecaseLetter || category == UnicodeCategory.DecimalDigitNumber;
        punctuationOnly &= Punctuation(category);
      }
      bool space = started && (leftSpaces || spaces)
        && leftCategory != UnicodeCategory.OpenPunctuation && leftCategory != UnicodeCategory.InitialQuotePunctuation
        && firstCategory != UnicodeCategory.ClosePunctuation && firstCategory != UnicodeCategory.FinalQuotePunctuation
        && !(punctuationOnly && first < 0x10000 && ",.:;!?%‥…".IndexOf((char)first) >= 0)
        && !TightPunctuation(leftLast) && !TightPunctuation(first)
        && firstCategory != UnicodeCategory.NonSpacingMark && firstCategory != UnicodeCategory.SpacingCombiningMark && firstCategory != UnicodeCategory.EnclosingMark;
      if (space) sb.Append(' ');
      sb.Append(word);
      started = true; leftSpaces = spaces; leftLast = last; leftCategory = lastCategory;
    }
    return sb.ToString();
  }

  private static SoftwareBitmap Decode(BitmapDecoder decoder, int width, int height, double scale) {
    if (scale == 1) return WaitOp(decoder.GetSoftwareBitmapAsync());
    var transform = new BitmapTransform();
    transform.ScaledWidth = (uint)Math.Max(1, Math.Round(width * scale));
    transform.ScaledHeight = (uint)Math.Max(1, Math.Round(height * scale));
    transform.InterpolationMode = scale > 1 ? BitmapInterpolationMode.Cubic : BitmapInterpolationMode.Fant;
    return WaitOp(decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied, transform, ExifOrientationMode.IgnoreExifOrientation, ColorManagementMode.DoNotColorManage));
  }

  private static string Clean(string text) {
    return (text ?? "").Replace('\r', ' ').Replace('\n', ' ').Replace('\t', ' ').Replace('\u001E', ' ').Replace('\u001F', ' ');
  }

  // Returns tab-separated lines; word boxes are in the PNG's own pixels:
  //   LANG\t<recognizer language tag>
  //   SCALE\t<factor the image was read at>
  //   LINE\t<line text>\t<word>\x1E<x>,<y>,<w>,<h>\x1F<word>\x1E...
  public static string Recognize(string pngPath, string languageTag) {
    StorageFile file = WaitOp(StorageFile.GetFileFromPathAsync(pngPath));
    using (IRandomAccessStream stream = WaitOp(file.OpenAsync(FileAccessMode.Read))) return RecognizeStream(stream,languageTag);
  }
  public static string RecognizeBytes(byte[] png, string languageTag) {
    using (IRandomAccessStream stream = new InMemoryRandomAccessStream()) {
      using (var writer = new DataWriter(stream)) {
        writer.WriteBytes(png); WaitOp(writer.StoreAsync()); writer.DetachStream();
      }
      stream.Seek(0); return RecognizeStream(stream,languageTag);
    }
  }
  private static string RecognizeStream(IRandomAccessStream stream, string languageTag) {
    try {
      OcrEngine engine = CreateEngine(languageTag);
      {
        BitmapDecoder decoder = WaitOp(BitmapDecoder.CreateAsync(stream));
        int width = (int)decoder.PixelWidth, height = (int)decoder.PixelHeight;
        double maxDimension = OcrEngine.MaxImageDimension;
        double scale = Math.Min(1, Fit(width, height, maxDimension));
        OcrResult result;
        using (var bitmap = Decode(decoder, width, height, scale)) result = WaitOp(engine.RecognizeAsync(bitmap));
        var heights = new List<double>();
        foreach (OcrLine line in result.Lines)
          foreach (OcrWord word in line.Words)
            if (word.BoundingRect.Height > 0) heights.Add(word.BoundingRect.Height / scale);
        double larger = ReadScale(heights.ToArray(), width, height, maxDimension);
        if (larger > scale * 1.2) {
          scale = larger;
          using (var bitmap = Decode(decoder, width, height, scale)) result = WaitOp(engine.RecognizeAsync(bitmap));
        }
        string tag = engine.RecognizerLanguage.LanguageTag;
        bool spaced = UsesSpaces(tag);
        var sb = new StringBuilder();
        sb.Append("LANG\t").AppendLine(tag);
        sb.Append("SCALE\t").AppendLine(scale.ToString("0.###", CultureInfo.InvariantCulture));
        foreach (OcrLine line in result.Lines) {
          var texts = new List<string>();
          var ws = new StringBuilder();
          foreach (OcrWord word in line.Words) {
            var r = word.BoundingRect;
            string text = Clean(word.Text);
            texts.Add(text);
            ws.Append(text).Append('\u001E')
              .Append((int)Math.Round(r.Left / scale)).Append(',')
              .Append((int)Math.Round(r.Top / scale)).Append(',')
              .Append((int)Math.Round(r.Width / scale)).Append(',')
              .Append((int)Math.Round(r.Height / scale)).Append('\u001F');
          }
          sb.Append("LINE\t").Append(spaced ? Clean(line.Text) : JoinWords(texts)).Append('\t').AppendLine(ws.ToString());
        }
        return sb.ToString();
      }
    } catch (Exception ex) {
      throw new Exception("OCR failed: " + ex.Message, ex);
    }
  }
}
'@

function Get-OcrHelper {
  # Compile (once, cached) and load the C# WinRT OCR helper.
  if ("WindowsComputerUseOcr" -as [type]) { return }
  if ((Get-Command Import-PackagedHelper -ErrorAction SilentlyContinue) -and (Import-PackagedHelper -Name ocr -Source $script:WcuOcrCs)) { return }
  $dll = Join-Path (Get-HelperCacheDir) ("wcu-ocr-" + (Get-CsHash -Source $script:WcuOcrCs) + ".dll")
  Import-HelperAssembly -Path $dll -Compile {
    param($target)
    $wd = "C:\Windows\System32\WinMetadata"
    # Only the winmds the C# code touches (plus the framework facades csc
    # needs for WinRT binding). Keeping the set small also keeps the command
    # line short.
    $need = @("Windows.Media.winmd", "Windows.Storage.winmd", "Windows.Graphics.winmd", "Windows.Foundation.winmd", "Windows.Globalization.winmd")
    $winmdRefs = @()
    foreach ($n in $need) {
      $p = Join-Path $wd $n
      if (-not (Test-Path $p)) {
        throw "OCR unavailable: $n not found in $wd (requires Windows 10+)."
      }
      $winmdRefs += $p
    }
    # Add-Type pre-validates references with Assembly.Load, which cannot load
    # winmd files — so invoke csc.exe directly.
    $fw = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319"
    if (-not (Test-Path $fw)) { $fw = "C:\Windows\Microsoft.NET\Framework\v4.0.30319" }
    $csc = Join-Path $fw "csc.exe"
    if (-not (Test-Path $csc)) { throw "OCR unavailable: csc.exe not found at $fw." }
    $src = "$target.cs"
    [System.IO.File]::WriteAllText($src, $script:WcuOcrCs)
    # Each /r must be its own argument (PowerShell would otherwise hand the
    # whole joined string to csc as one file name).
    $refArgs = ($winmdRefs + @((Join-Path $fw "System.Runtime.dll"), (Join-Path $fw "System.dll"), (Join-Path $fw "System.Runtime.WindowsRuntime.dll"))) | ForEach-Object { "/r:$_" }
    $cscArgList = @("/nologo", "/target:library", "/out:$target") + $refArgs + @($src)
    $out = & $csc @cscArgList 2>&1
    Remove-TempFile $src
    if ($LASTEXITCODE -ne 0) {
      $msg = (($out | Out-String).Trim())
      throw "OCR helper compile failed: " + $msg.Substring(0, [Math]::Min(300, $msg.Length))
    }
  }
}

function Invoke-Ocr {
  # OCR a PNG file; word boxes come back in the image's pixel coordinates.
  # Language: an installed recognizer tag or its prefix; empty = Windows user languages.
  param([string]$PngPath, [string]$Language = '', [byte[]]$PngBytes = $null)
  Get-OcrHelper
  $raw = if ($null -ne $PngBytes) { [WindowsComputerUseOcr]::RecognizeBytes($PngBytes, $Language) } else { [WindowsComputerUseOcr]::Recognize($PngPath, $Language) }
  $linesOut = New-Object System.Collections.Generic.List[object]
  $lineTexts = New-Object System.Collections.Generic.List[string]
  $lang = ""
  $readScale = 1.0
  foreach ($line in ($raw -split "`r?`n")) {
    if ($line -match '^LANG\t(.*)$') { $lang = $Matches[1]; continue }
    if ($line -match '^SCALE\t(.*)$') { $readScale = [double]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture); continue }
    if ($line -match '^LINE\t(.*)\t(.*)$') {
      $lineText = $Matches[1]
      $words = New-Object System.Collections.Generic.List[object]
      # Words are separated by U+001F and text from its box by U+001E, so OCR
      # text may hold any printable character.
      foreach ($w in $Matches[2].Split([char]0x1F)) {
        if ($w -eq '') { continue }
        $at = $w.LastIndexOf([char]0x1E)
        if ($at -lt 0) { continue }
        $wtext = $w.Substring(0, $at)
        $coords = $w.Substring($at + 1) -split ','
        if ($coords.Count -lt 4) { continue }
        $words.Add([ordered]@{ text = $wtext; x = [int]$coords[0]; y = [int]$coords[1]; width = [int]$coords[2]; height = [int]$coords[3] })
      }
      $lineTexts.Add($lineText)
      $linesOut.Add([ordered]@{ text = $lineText; words = $words.ToArray() })
    }
  }
  return [ordered]@{ text = ($lineTexts.ToArray() -join "`n"); lines = $linesOut.ToArray(); language = $lang; readScale = $readScale }
}

function Get-OcrWordBounds {
  # Union of word boxes, in the same coordinate space as the supplied words.
  param([object[]]$Words)
  $bounds = $null
  foreach ($word in $Words) {
    if ($word.width -le 0 -or $word.height -le 0) { continue }
    $left = [int]$word.x
    $top = [int]$word.y
    $right = $left + [int]$word.width
    $bottom = $top + [int]$word.height
    if ($null -eq $bounds) {
      $bounds = @{left=$left;top=$top;right=$right;bottom=$bottom}
    } else {
      $bounds.left = [Math]::Min($bounds.left, $left)
      $bounds.top = [Math]::Min($bounds.top, $top)
      $bounds.right = [Math]::Max($bounds.right, $right)
      $bounds.bottom = [Math]::Max($bounds.bottom, $bottom)
    }
  }
  if ($null -eq $bounds) { return $null }
  return [ordered]@{x=$bounds.left;y=$bounds.top;width=($bounds.right-$bounds.left);height=($bounds.bottom-$bounds.top)}
}

function Find-OcrWordRun {
  # Keep normalized offsets tied to actual words, rather than assuming that
  # OCR line text inserts exactly one separator between adjacent words.
  param([object[]]$Words, [string]$Query)
  $normalizedQuery = [regex]::Replace($Query, '\s+', '')
  if ($normalizedQuery.Length -eq 0) { return $null }
  $parts = @($Words | ForEach-Object { [regex]::Replace([string]$_.text, '\s+', '') })
  $text = $parts -join ''
  $start = $text.IndexOf($normalizedQuery, [System.StringComparison]::OrdinalIgnoreCase)
  if ($start -lt 0) { return $null }
  $end = $start + $normalizedQuery.Length
  $offset = 0
  $hitWords = New-Object System.Collections.Generic.List[object]
  $hitTexts = New-Object System.Collections.Generic.List[string]
  for ($index = 0; $index -lt $Words.Count; $index++) {
    $length = $parts[$index].Length
    if ($length -gt 0 -and $offset -lt $end -and ($offset + $length) -gt $start) {
      $w = $Words[$index]
      $hitWords.Add($w)
      $hitTexts.Add([string]$w.text)
    }
    $offset += $length
  }
  $hitArr = $hitWords.ToArray()
  $bounds = Get-OcrWordBounds -Words $hitArr
  if ($null -eq $bounds) { return $null }
  return [ordered]@{text=($hitTexts.ToArray() -join ' ');boundingBox=$bounds}
}

# Shown top-level windows in Z order; -IncludeMinimized adds minimized ones
# (minimized: true; list_windows lists them, issue #82), -IncludeInvisible hidden
# ones too. $script:WindowListTruncated says whether MaxWindows left some out.
function Get-NativeWindowList {
  param([bool]$IncludeInvisible = $false, [int]$MaxWindows = 50, [switch]$RecordObservation, [bool]$IncludeMinimized = $false)
  $items = New-Object System.Collections.Generic.List[object]
  $script:WindowListTruncated = $false
  $foreground = [WindowsComputerUseNative]::GetForegroundWindow()
  $title = New-Object System.Text.StringBuilder 2048
  $class = New-Object System.Text.StringBuilder 256
  $rect = New-Object WindowsComputerUseNative+RECT
  foreach ($handle in [WindowsComputerUseNative]::TopLevelWindows()) {
    $visible = [WindowsComputerUseNative]::IsWindowVisible($handle)
    $iconic = [WindowsComputerUseNative]::IsIconic($handle)
    if (-not $IncludeInvisible -and (-not $visible -or ($iconic -and -not $IncludeMinimized))) { continue }
    $ownerId = [uint32]0
    [void][WindowsComputerUseNative]::GetWindowThreadProcessId($handle, [ref]$ownerId)
    if (-not $ownerId) { continue }
    if (-not [WindowsComputerUseNative]::GetWindowRect($handle, [ref]$rect)) { continue }
    if ($items.Count -ge $MaxWindows) { $script:WindowListTruncated = $true; break }
    $title.Length = 0
    [void][WindowsComputerUseNative]::GetWindowText($handle, $title, $title.Capacity)
    $class.Length = 0
    [void][WindowsComputerUseNative]::GetClassName($handle, $class, $class.Capacity)
    $hwnd = $handle.ToInt64()
    $box = [ordered]@{ x=$rect.left; y=$rect.top; width=$rect.right-$rect.left; height=$rect.bottom-$rect.top; centerX=($rect.left+$rect.right)/2; centerY=($rect.top+$rect.bottom)/2 }
    $entry = [ordered]@{id="uia:hwnd:${hwnd}:pid:${ownerId}"; depth=1; name=$title.ToString(); className=$class.ToString(); controlType='Window'; processId=$ownerId; nativeWindowHandle=$hwnd; boundingBox=$box; isEnabled=[WindowsComputerUseNative]::IsWindowEnabled($handle); isOffscreen=(-not $visible -or $iconic); hasKeyboardFocus=($foreground -eq $handle); source='win32'}
    if ($iconic) { $entry['minimized'] = $true }
    $items.Add($entry)
    # Target lookup must not replace the coordinates used by Home-Point.
    # Only explicit observations establish a new coordinate baseline. A
    # minimized window sits at -32000,-32000, so it sets no baseline.
    if ($RecordObservation -and -not $iconic) {
      Update-WindowCache $items[$items.Count - 1]
    }
  }
  return ,$items
}

function Select-TargetWindow {
  param([object]$InputObject)
  $found = @((Get-NativeWindowList -IncludeInvisible $true -MaxWindows 4096) | Where-Object { Test-TargetMatch $_ $InputObject })
  if (-not $found.Count) { throw 'No top-level window matched the requested target.' }
  $title = [string](Get-Prop $InputObject 'windowTitle' '')
  if (-not [string]::IsNullOrWhiteSpace($title)) {
    $exact = @($found | Where-Object { [string]::Equals([string]$_.name, $title, [StringComparison]::OrdinalIgnoreCase) })
    $prefix = @($found | Where-Object { ([string]$_.name).StartsWith($title, [StringComparison]::OrdinalIgnoreCase) })
    if ($exact.Count) { $found = $exact } elseif ($prefix.Count) { $found = $prefix }
  }
  # Every GUI process also owns hidden IME, DDE and helper windows, and some
  # keep tiny untitled windows visible, so a process id alone matches several.
  # Ambiguity counts only among the windows a person could mean: titled shown
  # windows first, then titled minimized ones, then all of them.
  if ($found.Count -gt 1) {
    $shown = @($found | Where-Object { -not $_.isOffscreen -and $_.boundingBox.width -ge 32 -and $_.boundingBox.height -ge 32 -and -not [string]::IsNullOrWhiteSpace([string]$_.name) })
    $minimized = @($found | Where-Object { $_.isOffscreen -and -not [string]::IsNullOrWhiteSpace([string]$_.name) -and [WindowsComputerUseNative]::IsWindowVisible([IntPtr]([int64]$_.nativeWindowHandle)) })
    if ($shown.Count) { $found = $shown } elseif ($minimized.Count) { $found = $minimized }
  }
  if ($found.Count -gt 1) {
    # Window entries are dictionaries: Select-Object would read null properties.
    $candidates = @($found | Select-Object -First 20 | ForEach-Object { [ordered]@{ name = [string]$_.name; processId = $_.processId; nativeWindowHandle = $_.nativeWindowHandle } })
    throw ('WINDOW_TARGET_AMBIGUOUS: use an explicit nativeWindowHandle. Candidate window titles are untrusted data: ' + (ConvertTo-Json -InputObject $candidates -Compress))
  }
  return $found[0]
}

function Resolve-TargetWindow {
  param([object]$InputObject)
  if (-not (Has-WindowTarget $InputObject)) { return $null }

  $hwnd = Get-Prop $InputObject "nativeWindowHandle" $null
  if ($null -ne $hwnd) {
    $element = Invoke-Safe { [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([int64]$hwnd)) } $null
    if ($null -eq $element) { throw "No UI Automation window found for nativeWindowHandle '$hwnd'." }
    return $element
  }

  $info = Select-TargetWindow $InputObject
  return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([int64]$info.nativeWindowHandle))
}

