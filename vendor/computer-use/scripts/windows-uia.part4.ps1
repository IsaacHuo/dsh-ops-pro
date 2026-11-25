function Get-ScopeRoot {
  param([string]$Scope, [object]$InputObject = $null)
  if ($Scope -eq "desktop") {
    return [System.Windows.Automation.AutomationElement]::RootElement
  }

  $target = Resolve-TargetWindow $InputObject
  if ($null -ne $target) {
    if ([bool](Get-Prop $InputObject "activate" $false)) {
      [void](Set-WindowForeground $target)
    }
    return $target
  }

  $hwnd = [IntPtr](Get-WorkWindow)
  if ($hwnd -ne [IntPtr]::Zero) {
    $element = Invoke-Safe { [System.Windows.Automation.AutomationElement]::FromHandle($hwnd) } $null
    if ($null -ne $element) { return $element }
  }
  return [System.Windows.Automation.AutomationElement]::RootElement
}

# ============================================================================
# Tree + element resolution
# ============================================================================

function Get-Children {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [string]$ViewMode = "control", [bool]$IncludeOffscreen = $false,
    [int]$MaxChildren = 4096
  )
  # Match the filtered TreeWalker projection used by trees (including nodes
  # promoted through non-control containers), so legacy path ids stay resolvable.
  $items = New-Object "System.Collections.Generic.List[System.Windows.Automation.AutomationElement]"
  try {
    $cache = New-ElementCacheRequest "compact"
    $isGeckoEl = ((Invoke-Safe { $Element.Current.ClassName } '') -eq 'MozillaWindowClass') -or ((Invoke-Safe { $Element.Current.FrameworkId } '') -eq 'Gecko')
    $walker = New-Object System.Windows.Automation.TreeWalker -ArgumentList (Get-ViewCondition $ViewMode $IncludeOffscreen -SkipOffscreenFilter:$isGeckoEl)
    $child = $walker.GetFirstChild($Element, $cache)
    while ($null -ne $child -and $items.Count -lt $MaxChildren) {
      $items.Add($child)
      if ($items.Count -ge $MaxChildren) { break }
      $child = $walker.GetNextSibling($child, $cache)
    }
  } catch { }
  return ,$items
}

function Test-TreeBudget {
  param([object]$Traversal)
  if ($Traversal.watch.ElapsedMilliseconds -ge $Traversal.budgetMs) {
    $Traversal.reason = "timeBudget"
    return $false
  }
  return $true
}

function Test-RectOverlap {
  param([object]$A, [object]$B)
  return ($null -ne $A -and $null -ne $B -and $A.width -gt 0 -and $A.height -gt 0 -and $B.width -gt 0 -and $B.height -gt 0 -and
    $A.x -lt ($B.x + $B.width) -and $B.x -lt ($A.x + $A.width) -and
    $A.y -lt ($B.y + $B.height) -and $B.y -lt ($A.y + $A.height))
}

function Convert-Tree {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [string]$Path, [int]$Depth, [int]$MaxDepth, [ref]$Count, [int]$MaxNodes,
    [string]$ViewMode = "control", [bool]$IncludeOffscreen = $false,
    [string]$DetailLevel = "compact", [object]$Traversal, [object]$Owner = $null,
    [int]$Level = -1, [object]$GeckoPageBounds = $null
  )
  if ($Count.Value -ge $MaxNodes) { $Traversal.reason = "maxNodes"; return $null }
  if (-not (Test-TreeBudget $Traversal)) { return $null }
  if ($Level -lt 0) { $Level = $Depth }
  $previousOwner = $script:ObservationOwner
  if ($null -eq $Owner -and $null -ne $script:NativeOwners) {
    $nativeHwnd = Invoke-Safe { [int64]$Element.Cached.NativeWindowHandle } 0
    $Owner = $script:NativeOwners[[string]$nativeHwnd]
  }
  $script:ObservationOwner = $Owner
  $info = Convert-ElementInfo -Element $Element -Id "uia:$Path" -Depth $Depth -DetailLevel $DetailLevel -UseCache
  $Count.Value++
  if ($Traversal.pruneGeckoOffscreen -and $info.controlType -eq 'Document') {
    # Gecko can mark the whole page offscreen while its native window is
    # visible. Keep controls whose bounds overlap this document, but keep
    # the provider's isOffscreen value and the input checks unchanged.
    $GeckoPageBounds = if ($Owner.isOffscreen -eq $false -and $info.isOffscreen -eq $true -and (Test-RectOverlap $info.boundingBox $Owner.boundingBox)) { $info.boundingBox }
  }
  # Chromium nests a page six or more levels down, under unnamed layout panes
  # (NonClientView, ClientView, View...), and Firefox-family browsers put it
  # under three unnamed Gecko panes (#56). In window-scoped trees those panes do
  # not use up maxDepth, so the default depths reach the page; 16 extra levels
  # bound the recursion. Desktop trees stay an overview of every window.
  $childLevel = $Level + 1
  $fw = Invoke-Safe { $Element.Cached.FrameworkId } ''
  if ($Traversal.browserLayout -and [string]::IsNullOrEmpty($info.name) -and (
      ($info.controlType -eq 'Pane' -and $fw -in @('Chrome', 'Gecko')) -or
      (($fw -eq 'Gecko' -or ($null -ne $Owner -and $Owner.className -eq 'MozillaWindowClass')) -and $info.controlType -in @('Pane', 'Group', 'Custom'))
    )) { $childLevel = $Level }
  $childrenOut = New-Object System.Collections.Generic.List[object]
  if ($childLevel -le $MaxDepth -and $Depth -lt $MaxDepth + 16 -and $Count.Value -lt $MaxNodes -and (Test-TreeBudget $Traversal)) {
    try {
      $child = $Traversal.walker.GetFirstChild($Element, $Traversal.cache)
      $i = 0
      while ($null -ne $child) {
        if ($Count.Value -ge $MaxNodes -or -not (Test-TreeBudget $Traversal)) { break }
        $childOut = Convert-Tree -Element $child -Path "$Path.$i" -Depth ($Depth + 1) -MaxDepth $MaxDepth -Count $Count -MaxNodes $MaxNodes -ViewMode $ViewMode -IncludeOffscreen $IncludeOffscreen -DetailLevel $DetailLevel -Traversal $Traversal -Owner $Owner -Level $childLevel -GeckoPageBounds $GeckoPageBounds
        if ($null -ne $childOut) { $childrenOut.Add($childOut) }
        if ($Count.Value -ge $MaxNodes -or $null -ne $Traversal.reason -or -not (Test-TreeBudget $Traversal)) { break }
        $child = $Traversal.walker.GetNextSibling($child, $Traversal.cache)
        $i++
      }
    } catch {
      $Traversal.reason = "providerError"
      $Traversal.error = $_.Exception.Message
    }
  }
  if ($Depth -gt 0 -and $Traversal.pruneGeckoOffscreen -and $info.isOffscreen -eq $true -and $childrenOut.Count -eq 0 -and $info.controlType -notin @('Window','Pane','Document','Group','Tab','TabItem') -and
      (-not (Test-RectOverlap $info.boundingBox $GeckoPageBounds) -or -not (Test-RectOverlap $info.boundingBox $Owner.boundingBox))) {
    $Count.Value--
    $script:ObservationOwner = $previousOwner
    return $null
  }
  if ($Count.Value -ge $MaxNodes -and $null -eq $Traversal.reason) { $Traversal.reason = "maxNodes" }
  # Only count nodes kept in the result, after the Gecko leaf filter.
  $Traversal.countedDepth = [Math]::Max([int]$Traversal['countedDepth'], $Level)
  $Traversal.structuralDepth = [Math]::Max([int]$Traversal['structuralDepth'], $Depth)
  $info["children"] = @($childrenOut.ToArray())
  $script:ObservationOwner = $previousOwner
  return $info
}

function Resolve-Element {
  param([string]$ElementId, [object]$InputObject = $null)
  if ([string]::IsNullOrWhiteSpace($ElementId)) {
    throw "elementId is required."
  }


  if ($ElementId -match '^uia:hwnd:(\d+):pid:(\d+)$') {
    $handle = [IntPtr]([int64]$Matches[1])
    $expectedOwner = [uint32]$Matches[2]
    $null = Get-ViewMode $InputObject "control"
    $ownerId = [uint32]0
    [void][WindowsComputerUseNative]::GetWindowThreadProcessId($handle, [ref]$ownerId)
    if (-not [WindowsComputerUseNative]::IsWindow($handle) -or $ownerId -ne $expectedOwner) { throw 'Window identity changed; refresh the window list.' }
    if (Has-WindowTarget $InputObject) {
      $requested = Get-ObservationWindow $InputObject
      if ([int64]$requested.nativeWindowHandle -ne $handle.ToInt64()) { throw 'Element belongs to a different target window; re-observe before acting.' }
    }
    return [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  }

  # Preferred form: uia:rt:<n>-<n>-... resolved by RuntimeId (stable for the
  # life of the owning process, immune to UI re-layouts).
  if ($ElementId -match '^uia:rt:(.+)$') {
    $runtimeText = $Matches[1]
    if ($runtimeText -notmatch '^-?\d+(?:--?\d+)+$') { throw "Malformed runtime element id '$ElementId'." }
    # RuntimeId lookup bypasses view traversal, but the declared view filters
    # must still be validated here — an illegal viewMode has to fail exactly
    # like it does on the legacy path instead of being silently ignored.
    $null = Get-ViewMode $InputObject "control"
    $entry = $script:ElementRegistry[$ElementId]
    if ($null -eq $entry -or ([DateTimeOffset]::Now.ToUnixTimeMilliseconds() - [int64]$entry.ts) -gt 300000) {
      throw "Element '$ElementId' is stale or was not observed by this backend. Re-run snapshot/tree/find for fresh ids."
    }
    $owner = [uint32]0
    [void][WindowsComputerUseNative]::GetWindowThreadProcessId([IntPtr]([int64]$entry.hwnd), [ref]$owner)
    if (-not [WindowsComputerUseNative]::IsWindow([IntPtr]([int64]$entry.hwnd)) -or $owner -ne [uint32]$entry.processId) { throw 'Element owner changed; re-observe before acting.' }
    if (Has-WindowTarget $InputObject) {
      $target = Get-ObservationWindow $InputObject
      if ([int64]$target.nativeWindowHandle -ne [int64]$entry.hwnd) { throw 'Element belongs to a different target window; re-observe before acting.' }
    }
    $actualId = Invoke-Safe { @($entry.element.GetRuntimeId()) -join '-' } $null
    if ($actualId -ne $runtimeText) { throw 'Element no longer exists; re-observe before acting.' }
    return $entry.element
  }

  # Legacy form: uia:<active|root>.<index>.<index>... resolved by tree path.
  if ($ElementId -match '^uia:(active|root)(\.\d+)*$') {
    $path = $ElementId.Substring(4)
    $parts = $path.Split(".")
    $scopeName = $parts[0]
    $viewMode = Get-ViewMode $InputObject "control"
    $includeOffscreen = [bool](Get-Prop $InputObject "includeOffscreen" $false)
    $element = if ($scopeName -eq "root") {
      [System.Windows.Automation.AutomationElement]::RootElement
    } else {
      Get-ScopeRoot "active_window" $InputObject
    }
    for ($i = 1; $i -lt $parts.Length; $i++) {
      $index = [int]$parts[$i]
      $children = Get-Children -Element $element -ViewMode $viewMode -IncludeOffscreen $includeOffscreen -MaxChildren ($index + 1)
      if ($null -eq $children -or $index -lt 0 -or $index -ge $children.Count) {
        throw "Element path '$ElementId' is stale or out of range at segment $i."
      }
      $element = $children.Item($index)
    }
    return $element
  }

  throw "Unsupported element id '$ElementId'. Use an id from windows_computer_use_snapshot or windows_computer_use_accessibility_tree."
}

function Assert-ElementPoint {
  param([object]$Element, [int]$X, [int]$Y)
  if ($null -eq $Element) { return }
  if ((Invoke-Safe { [bool]$Element.Current.IsOffscreen } $true)) { throw 'ELEMENT_OFFSCREEN: observe or scroll the requested element before clicking.' }
  if (-not (Invoke-Safe { [bool]$Element.Current.IsEnabled } $false)) { throw 'ELEMENT_DISABLED: the requested element is disabled.' }
  $point = New-Object System.Windows.Point($X, $Y)
  $hit = [System.Windows.Automation.AutomationElement]::FromPoint($point)
  $want = @($Element.GetRuntimeId()) -join '-'
  if (-not $want) { throw 'ELEMENT_ID_UNCONFIRMED: the requested element has no runtime identity.' }
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  for ($depth = 0; $depth -lt 60 -and $null -ne $hit; $depth++) {
    if ((@($hit.GetRuntimeId()) -join '-') -eq $want) { return }
    $hit = $walker.GetParent($hit)
  }
  throw 'ELEMENT_POINT_COVERED: the point belongs to another element; no click was sent.'
}

function Confirm-ElementPoint {
  param([System.Collections.IDictionary]$Point)
  if ($null -eq $Point.element) { return }
  $candidate = New-Object System.Windows.Point
  try { $available = $Point.element.TryGetClickablePoint([ref]$candidate) } catch { $available = $false }
  if ($available) { $Point.x = [int][Math]::Round($candidate.X); $Point.y = [int][Math]::Round($candidate.Y) }
  else {
    $rect = Convert-Rect (Invoke-Safe { $Point.element.Current.BoundingRectangle } $null)
    if ($null -eq $rect) { throw 'ELEMENT_POINT_UNAVAILABLE: the element has no click point.' }
    $Point.x = [int]$rect.centerX; $Point.y = [int]$rect.centerY
  }
  Assert-ElementPoint $Point.element $Point.x $Point.y
}

function Get-PointFromArgs {
  param([object]$InputObject)
  $elementId = Get-Prop $InputObject "elementId" $null
  if ($null -ne $elementId) {
    $el = Resolve-Element $elementId $InputObject
    $rect = Convert-Rect (Invoke-Safe { $el.Current.BoundingRectangle } $null)
    if ($null -eq $rect) { throw "Element '$elementId' has no clickable bounding box." }
    return [ordered]@{ x = $rect.centerX; y = $rect.centerY; element = $el; elementId = $elementId }
  }

  $x = Get-Prop $InputObject "x" $null
  $y = Get-Prop $InputObject "y" $null
  if ($null -eq $x -or $null -eq $y) {
    throw "Provide either elementId or x and y."
  }
  return [ordered]@{ x = [int]$x; y = [int]$y; element = $null; elementId = $null }
}

# ============================================================================
# Search
# ============================================================================

function Element-Matches {
  param([object]$Info, [string]$Query, [string]$ControlType)
  if (-not [string]::IsNullOrWhiteSpace($ControlType)) {
    if (($Info.controlType + "") -notlike "*$ControlType*") { return $false }
  }
  if ([string]::IsNullOrWhiteSpace($Query)) { return $true }
  $haystack = @(
    $Info.name,
    $Info.automationId,
    $Info.className,
    $Info.controlType,
    $Info.localizedControlType,
    $Info.value
  ) -join "`n"
  return $haystack.IndexOf($Query, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Search-Tree {
  param([object]$Node, [string]$Query, [string]$ControlType, [int]$MaxResults, [System.Collections.Generic.List[object]]$Results)
  if ($null -eq $Node -or $Results.Count -ge $MaxResults) { return }
  if (Element-Matches -Info $Node -Query $Query -ControlType $ControlType) {
    $copy = [ordered]@{}
    foreach ($prop in $Node.Keys) {
      if ($prop -ne "children") { $copy[$prop] = $Node[$prop] }
    }
    $Results.Add($copy)
  }
  foreach ($child in @($Node.children)) {
    if ($Results.Count -ge $MaxResults) { break }
    Search-Tree -Node $child -Query $Query -ControlType $ControlType -MaxResults $MaxResults -Results $Results
  }
}

# ============================================================================
# Input (modern SendInput path)
# ============================================================================

function Get-ButtonFlags {
  param([string]$Button)
  switch ($Button) {
      "right" { return @([uint32]0x0008, [uint32]0x0010) }
      "middle" { return @([uint32]0x0020, [uint32]0x0040) }
      default { return @([uint32]0x0002, [uint32]0x0004) }
  }
}

function Click-At {
  param([int]$X, [int]$Y, [string]$Button = "left", [int]$Count = 1)
  $flags = Get-ButtonFlags $Button
  for ($i = 0; $i -lt $Count; $i++) {
    [void](Test-Failsafe)
    $sent = [WindowsComputerUseNative]::SendClick($X, $Y, [uint32]$flags[0], [uint32]$flags[1])
    if ($sent -lt 2) { throw 'COMPUTER_USE_INPUT_UNAVAILABLE: Windows rejected mouse input. The click was not replayed.' }
    if ($sent -ne 3) { throw 'COMPUTER_USE_INPUT_UNAVAILABLE: Windows rejected mouse release. Cleanup was attempted; the click was not replayed.' }
    if ($i + 1 -lt $Count) {
      # Pause between rapid multi-clicks so double/triple click detection fires reliably.
      Start-Sleep -Milliseconds 60
    }
  }
}

function Move-ToPoint {
  param([int]$X, [int]$Y)
  [void](Test-Failsafe)
  if (-not [WindowsComputerUseNative]::SetCursorPos($X, $Y)) { throw 'COMPUTER_USE_INPUT_UNAVAILABLE: Windows rejected cursor positioning. Restore the interactive desktop before retrying.' }
}

function Begin-ClipboardLease {
  param([string]$Text, [bool]$RestoreClipboard)
  if (-not ('WcuClipboardLease' -as [type])) {
    $clipboardSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'windows-clipboard.cs'),[Text.Encoding]::UTF8)
    $precompiled = (Get-Command Import-PackagedHelper -ErrorAction SilentlyContinue) -and (Import-PackagedHelper -Name clipboard -Source $clipboardSource)
    if (-not $precompiled) {
      $runtimeKey = $PSVersionTable.PSEdition.ToLowerInvariant() + '-clr' + [Environment]::Version.Major
      $dll = Join-Path (Get-HelperCacheDir) ("wcu-clipboard-" + $runtimeKey + '-' + (Get-CsHash -Source $clipboardSource) + ".dll")
      $references = @('System.Windows.Forms', 'System.Drawing')
      if ($PSVersionTable.PSEdition -eq 'Core') {
        # As for the takeover helper: the short names alone miss the .NET
        # reference assemblies (HashSet<T>) and the split Windows Forms ones.
        $references = @(Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter '*.dll' | ForEach-Object { $_.FullName })
        $references += [System.Reflection.Assembly]::Load('System.Windows.Forms').Location
        $references += [System.Reflection.Assembly]::Load('System.Windows.Forms.Primitives').Location
        $references += [System.Reflection.Assembly]::Load('System.Drawing.Common').Location
        $references += @(Get-ChildItem -LiteralPath $PSHOME -Filter 'System.Private.Windows*.dll' | ForEach-Object { $_.FullName })
      }
      Import-HelperAssembly -Path $dll -Compile { param($out) Add-Type -TypeDefinition $clipboardSource -ReferencedAssemblies $references -OutputAssembly $out }
    }
  }
  [uint32]$targetProcess = 0
  $focusedWindow=[WindowsComputerUseNative]::FocusedWindow([WindowsComputerUseNative]::GetForegroundWindow())
  if($focusedWindow -ne [IntPtr]::Zero){[void][WindowsComputerUseNative]::GetWindowThreadProcessId($focusedWindow, [ref]$targetProcess)}
  return New-Object -TypeName WcuClipboardLease -ArgumentList @($Text, $RestoreClipboard, [int]$targetProcess)
}

function Type-Text {
  param([string]$Text, [bool]$RestoreClipboard = $true)
  # Check the input desktop without repositioning the shared pointer. The user
  # may have moved it since GetCursorPos returned; pasting needs no mouse move.
  $position = New-Object WindowsComputerUseNative+POINT
  if (-not [WindowsComputerUseNative]::GetCursorPos([ref]$position)) { throw 'COMPUTER_USE_INPUT_UNAVAILABLE: Windows input desktop is unavailable.' }
  $script:LastPasteInfo = $null
  [void](Test-Failsafe)
  $lease = Begin-ClipboardLease -Text $Text -RestoreClipboard $RestoreClipboard
  try {
    [void](Test-Failsafe)
    $pasteTarget=[WindowsComputerUseNative]::FocusedWindow([WindowsComputerUseNative]::GetForegroundWindow())
    if (-not $lease.TryPasteNative($pasteTarget)) {
      if (-not [WindowsComputerUseNative]::SendKeyChord(@('ctrl','v'))) { throw 'COMPUTER_USE_INPUT_UNAVAILABLE: Windows rejected paste input.' }
      $lease.MarkPasteSent([WindowsComputerUseNative]::FocusedWindow([WindowsComputerUseNative]::GetForegroundWindow()))
    }
    $deadline = [DateTime]::UtcNow.AddMilliseconds(2200)
    while (-not $lease.IsCompleted -and [DateTime]::UtcNow -lt $deadline) {
      [void](Test-Failsafe)
      [void]$lease.Complete(25)
    }
    $requested = $lease.Complete(0)
    $script:LastPasteInfo = @{ clipboardRequested = $requested; clipboardPasteCompleted = $lease.NativePasteCompleted; clipboardRestored = $lease.Restored; clipboardRestoreFailed = $lease.RestorationFailed; clipboardRequestWindow = $lease.RequestWindow; clipboardRequestProcessId = $lease.RequestProcessId }
  } finally {
    # The lease rolls back if nothing was sent. Once dispatched it keeps the
    # requested text available for slow recipients until a read is confirmed.
    $lease.Dispose()
  }
}

function Convert-KeyChord {
  param([object[]]$Keys)
  $mod = ""
  $main = $null
  foreach ($keyRaw in $Keys) {
    $key = ("" + $keyRaw).Trim()
    switch -Regex ($key.ToLowerInvariant()) {
        "^(ctrl|control)$" { $mod += "^"; continue }
        "^(alt|option)$" { $mod += "%"; continue }
        "^shift$" { $mod += "+"; continue }
        "^(cmd|meta|win|windows)$" { throw "The Windows key is blocked by design (it would open system dialogs such as Win+R / Win+L). Use a different key combination." }
        default { $main = $key }
    }
  }
  if ([string]::IsNullOrWhiteSpace($main)) { throw "A non-modifier key is required." }
  $special = @{
    "enter" = "{ENTER}"; "return" = "{ENTER}"; "tab" = "{TAB}"; "esc" = "{ESC}"; "escape" = "{ESC}"
    "backspace" = "{BACKSPACE}"; "delete" = "{DELETE}"; "del" = "{DELETE}"; "home" = "{HOME}"
    "end" = "{END}"; "pageup" = "{PGUP}"; "pagedown" = "{PGDN}"; "up" = "{UP}"; "down" = "{DOWN}"
    "left" = "{LEFT}"; "right" = "{RIGHT}"; "space" = " "; "insert" = "{INSERT}"
    "f1" = "{F1}"; "f2" = "{F2}"; "f3" = "{F3}"; "f4" = "{F4}"; "f5" = "{F5}"; "f6" = "{F6}"
    "f7" = "{F7}"; "f8" = "{F8}"; "f9" = "{F9}"; "f10" = "{F10}"; "f11" = "{F11}"; "f12" = "{F12}"
  }
  $lower = $main.ToLowerInvariant()
  $encoded = if ($special.ContainsKey($lower)) {
    $special[$lower]
  } elseif ($main.Length -eq 1) {
    if ($main -match '^[+^%~(){}\[\]]$') { '{' + $main + '}' } else { $main.ToLowerInvariant() }
  } else {
    "{" + $main.ToUpperInvariant() + "}"
  }
  return $mod + $encoded
}

function Invoke-ElementPattern {
  param([object]$Element)
  Assert-InputProcess ([int](Invoke-Safe { $Element.Current.ProcessId } 0))
  $script:BackgroundReport = $null
  $native = Invoke-NativeButton $Element
  if ($null -ne $native) { return $native }
  return (Invoke-Guarded { Invoke-UiaPattern $Element } $Element)
}

function Invoke-UiaPattern {
  param([object]$Element)
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern) } $false) {
    [void](Test-Failsafe)
    $pattern.Invoke()
    return "Invoke"
  }
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern) } $false) {
    [void](Test-Failsafe)
    $pattern.Toggle()
    return "Toggle"
  }
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern) } $false) {
    [void](Test-Failsafe)
    $pattern.Select()
    return "SelectionItem"
  }
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern) } $false) {
    $state = Invoke-Safe { $pattern.Current.ExpandCollapseState } $null
    [void](Test-Failsafe)
    if ($state -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) {
      $pattern.Expand()
    } else {
      $pattern.Collapse()
    }
    return "ExpandCollapse"
  }
  return $null
}

function Set-ElementValue {
  param([System.Windows.Automation.AutomationElement]$Element, [string]$Value)
  Assert-InputProcess ([int](Invoke-Safe { $Element.Current.ProcessId } 0))
  $script:BackgroundReport = $null
  $native = Set-NativeEditText $Element $Value
  if ($null -ne $native) { return $native }
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) } $false) {
    [void](Test-Failsafe)
    return (Invoke-Guarded { $pattern.SetValue($Value); 'ValuePattern' } $Element)
  }
  return $null
}

# invoke action:'expand' | 'collapse' | 'scroll_into_view': the element's own
# ExpandCollapse or ScrollItem pattern, under the UIA guard. An element already
# in the requested state is left as it is.
function Invoke-ElementAction {
  param([object]$Element, [string]$Kind)
  $script:BackgroundReport = $null
  $type = if ($Kind -eq 'scroll_into_view') { [System.Windows.Automation.ScrollItemPattern]::Pattern } else { [System.Windows.Automation.ExpandCollapsePattern]::Pattern }
  $pattern = $null
  if (-not (Invoke-Safe { $Element.TryGetCurrentPattern($type, [ref]$pattern) } $false)) {
    throw "ELEMENT_ACTION_UNSUPPORTED: this element has no $(if ($Kind -eq 'scroll_into_view') { 'ScrollItemPattern' } else { 'ExpandCollapsePattern' }), so it cannot $($Kind -replace '_', ' '). Use the default invoke, click it, or scroll its container."
  }
  if ($Kind -ne 'scroll_into_view') {
    $state = Invoke-Safe { $pattern.Current.ExpandCollapseState } $null
    if (($Kind -eq 'expand' -and $state -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) -or ($Kind -eq 'collapse' -and $state -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed)) {
      return $(if ($Kind -eq 'expand') { 'ExpandCollapse (already expanded)' } else { 'ExpandCollapse (already collapsed)' })
    }
    if ($state -eq [System.Windows.Automation.ExpandCollapseState]::LeafNode) { throw "ELEMENT_ACTION_UNSUPPORTED: this element is a leaf; it has nothing to $Kind." }
  }
  [void](Test-Failsafe)
  return (Invoke-Guarded {
    switch ($Kind) {
      'expand' { $pattern.Expand(); 'ExpandCollapse.Expand' }
      'collapse' { $pattern.Collapse(); 'ExpandCollapse.Collapse' }
      default { $pattern.ScrollIntoView(); 'ScrollItem.ScrollIntoView' }
    }
  } $Element)
}

# Scrolling an element without the pointer. The element, or its nearest
# ancestor that scrolls in that direction (ScrollPattern), scrolls by window
# messages when it is a Win32 control with its own scroll bar (WM_VSCROLL /
# WM_HSCROLL: no foreground), else through its ScrollPattern under the UIA
# guard. One wheel notch (120) scrolls the lines set for the wheel in Windows,
# or a page when the wheel is set to a screen at a time. $null when nothing
# scrolls; else the method and the scroll positions before and after.
function Invoke-ElementScroll {
  param([object]$Element, [int]$DeltaX, [int]$DeltaY)
  $script:BackgroundReport = $null
  $lines = [System.Windows.Forms.SystemInformation]::MouseWheelScrollLines
  $byPage = $lines -lt 0
  $steps = { param([int]$Delta) if ($Delta -eq 0) { 0 } elseif ($byPage) { [int][math]::Max(1, [math]::Round([math]::Abs($Delta) / 120)) } else { [int][math]::Min(100, [math]::Max(1, [math]::Round([math]::Abs($Delta) * $lines / 120))) } }
  $countY = & $steps $DeltaY
  $countX = & $steps $DeltaX
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $node = $Element; $scroller = $null; $pattern = $null
  for ($depth = 0; $null -ne $node -and $depth -lt 12; $depth++) {
    $candidate = $null
    if (Invoke-Safe { $node.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$candidate) } $false) {
      $vertical = [bool](Invoke-Safe { $candidate.Current.VerticallyScrollable } $false)
      $horizontal = [bool](Invoke-Safe { $candidate.Current.HorizontallyScrollable } $false)
      if (($countY -eq 0 -or $vertical) -and ($countX -eq 0 -or $horizontal)) { $scroller = $node; $pattern = $candidate; break }
    }
    $node = Invoke-Safe { $walker.GetParent($node) } $null
  }
  $hwnd = if ($null -ne $scroller) { Invoke-Safe { [int64]$scroller.Current.NativeWindowHandle } 0 } else { Invoke-Safe { [int64]$Element.Current.NativeWindowHandle } 0 }
  $style = if ($hwnd) { [WindowsComputerUseNative]::GetWindowLong([IntPtr]$hwnd, -16) } else { 0 }
  # WS_VSCROLL (0x00200000), WS_HSCROLL (0x00100000)
  $native = $hwnd -and ($countY -eq 0 -or ($style -band 0x00200000) -ne 0) -and ($countX -eq 0 -or ($style -band 0x00100000) -ne 0)
  if (-not $native -and $null -eq $pattern) { return $null }
  $position = { if ($null -ne $pattern) { @([math]::Round([double](Invoke-Safe { $pattern.Current.HorizontalScrollPercent } -1), 1), [math]::Round([double](Invoke-Safe { $pattern.Current.VerticalScrollPercent } -1), 1)) } else { $null } }
  $before = & $position
  [void](Test-Failsafe)
  if ($native) {
    # SB_LINEUP 0 / SB_LINEDOWN 1 / SB_PAGEUP 2 / SB_PAGEDOWN 3, then SB_ENDSCROLL 8.
    $reply = [UIntPtr]::Zero
    foreach ($axis in @(@{ count = $countY; delta = $DeltaY; msg = [WindowsComputerUseNative]::WM_VSCROLL }, @{ count = $countX; delta = $DeltaX; msg = [WindowsComputerUseNative]::WM_HSCROLL })) {
      if ($axis.count -eq 0) { continue }
      $code = if ($axis.delta -gt 0) { 1 } else { 0 }
      if ($byPage) { $code += 2 }
      for ($i = 0; $i -lt $axis.count; $i++) {
        if ([WindowsComputerUseNative]::SendMessageTimeout([IntPtr]$hwnd, $axis.msg, [UIntPtr][uint32]$code, [IntPtr]::Zero, 2, 1000, [ref]$reply) -eq [IntPtr]::Zero) { return $null }
      }
      [void][WindowsComputerUseNative]::SendMessageTimeout([IntPtr]$hwnd, $axis.msg, [UIntPtr][uint32]8, [IntPtr]::Zero, 2, 1000, [ref]$reply)
    }
    $method = if ($countY) { 'WM_VSCROLL' } else { 'WM_HSCROLL' }
  } else {
    $method = Invoke-Guarded {
      $amount = [System.Windows.Automation.ScrollAmount]
      $none = $amount::NoAmount
      $amountY = if ($DeltaY -gt 0) { if ($byPage) { $amount::LargeIncrement } else { $amount::SmallIncrement } } else { if ($byPage) { $amount::LargeDecrement } else { $amount::SmallDecrement } }
      $amountX = if ($DeltaX -gt 0) { if ($byPage) { $amount::LargeIncrement } else { $amount::SmallIncrement } } else { if ($byPage) { $amount::LargeDecrement } else { $amount::SmallDecrement } }
      for ($i = 0; $i -lt $countY; $i++) { $pattern.Scroll($none, $amountY) }
      for ($i = 0; $i -lt $countX; $i++) { $pattern.Scroll($amountX, $none) }
      'ScrollPattern'
    } $Element
  }
  $result = [ordered]@{ method = "background:$method" }
  if ($null -ne $before) {
    $after = & $position
    $result['scrollPercent'] = [ordered]@{ before = $before; after = $after }
    if ($before[0] -eq $after[0] -and $before[1] -eq $after[1]) { $result['note'] = 'The scroll position did not change: the content may already be at its end in that direction.' }
  }
  return $result
}

# Real input is the last resort: a call that would need it while it runs in the
# background (no indicator, no Esc stop) asks the server to run it again with
# both, before anything is sent.
function Assert-InputAllowed {
  param([string]$What)
  if ($script:WcuQuiet) { throw "WCU_NEEDS_INPUT: $What needs the real pointer or keyboard." }
}

# Adds what a background element action gave back to the result.
function Add-BackgroundReport {
  param([System.Collections.IDictionary]$Result)
  if ($null -eq $script:BackgroundReport) { return }
  foreach ($key in $script:BackgroundReport.Keys) { $Result[$key] = $script:BackgroundReport[$key] }
}

# ============================================================================
# Screenshot: unobstructed foreground screen crop, otherwise window capture.
# ============================================================================

function Get-ExtendedFrameBounds {
  param([long]$Hwnd)
  if (-not ($Hwnd -and $Hwnd -ne 0)) { return $null }
  $r = New-Object WindowsComputerUseNative+RECT
  $hr = Invoke-Safe { [WindowsComputerUseNative]::DwmGetWindowAttribute([IntPtr]$Hwnd, 9, [ref]$r, 16) } 0
  if ($hr -ne 0) { return $null }
  $w = $r.right - $r.left
  $h = $r.bottom - $r.top
  if ($w -le 0 -or $h -le 0) { return $null }
  return [ordered]@{ x = $r.left; y = $r.top; width = $w; height = $h }
}

function Test-WindowScreenCapture {
  param([long]$Hwnd, [object]$Bounds, [object]$VirtualScreen)
  # Include this window's owned dialogs/menus in its screen crop. Unrelated
  # windows, including unowned same-process siblings, still make it unusable.
  if ($null -eq $Bounds -or $Bounds.width -le 0 -or $Bounds.height -le 0) { return $false }
  if (-not (Test-InputWindow ([WindowsComputerUseNative]::GetForegroundWindow().ToInt64()) $Hwnd)) { return $false }
  if ($Bounds.x -lt $VirtualScreen.Left -or $Bounds.y -lt $VirtualScreen.Top -or
      $Bounds.x + $Bounds.width -gt $VirtualScreen.Right -or
      $Bounds.y + $Bounds.height -gt $VirtualScreen.Bottom) { return $false }
  foreach ($handle in [WindowsComputerUseNative]::TopLevelWindows()) {
    if ($handle.ToInt64() -eq $Hwnd) {
      return ([WindowsComputerUseNative]::IsWindowVisible($handle) -and -not [WindowsComputerUseNative]::IsIconic($handle))
    }
    if (-not [WindowsComputerUseNative]::IsWindowVisible($handle) -or [WindowsComputerUseNative]::IsIconic($handle)) { continue }
    if (Test-InputWindow $handle.ToInt64() $Hwnd) { continue }
    [uint32]$overlayOwner = 0
    if ($script:TakeoverProcessId) {
      [void][WindowsComputerUseNative]::GetWindowThreadProcessId($handle, [ref]$overlayOwner)
      if ($overlayOwner -eq $script:TakeoverProcessId) { continue }
    }
    $other = New-Object WindowsComputerUseNative+RECT
    # Unknown geometry must not be treated as proof that the crop is clear.
    if (-not [WindowsComputerUseNative]::GetWindowRect($handle, [ref]$other)) { return $false }
    if ($other.right -gt $Bounds.x -and $other.left -lt $Bounds.x + $Bounds.width -and
        $other.bottom -gt $Bounds.y -and $other.top -lt $Bounds.y + $Bounds.height) { return $false }
  }
  return $false
}

function Try-PrintWindowCapture {
  param([long]$Hwnd,[int]$Width,[int]$Height)
  if ($Width -le 0 -or $Height -le 0) { return $null }
  $outer=New-Object WindowsComputerUseNative+RECT
  if (-not [WindowsComputerUseNative]::GetWindowRect([IntPtr]$Hwnd,[ref]$outer)) { return $null }
  $frame=Get-ExtendedFrameBounds $Hwnd
  if ($null -eq $frame -or $frame.width -ne $Width -or $frame.height -ne $Height) { return $null }
  $left=[int]$frame.x-$outer.left;$top=[int]$frame.y-$outer.top
  $fullWidth=$outer.right-$outer.left;$fullHeight=$outer.bottom-$outer.top
  if ($left -lt 0 -or $top -lt 0 -or $left+$Width -gt $fullWidth -or $top+$Height -gt $fullHeight) { return $null }
  $raw=New-Object System.Drawing.Bitmap $fullWidth,$fullHeight
  $cropped=$null;$accepted=$false
  try {
    $graphics=[System.Drawing.Graphics]::FromImage($raw)
    try {
      $hdc=$graphics.GetHdc()
      try { $ok=[WindowsComputerUseNative]::PrintWindow([IntPtr]$Hwnd,$hdc,2) }
      finally { $graphics.ReleaseHdc($hdc) }
    } finally { $graphics.Dispose() }
    if (-not $ok) { return $null }
    $after=New-Object WindowsComputerUseNative+RECT
    if (-not [WindowsComputerUseNative]::GetWindowRect([IntPtr]$Hwnd,[ref]$after) -or
        $after.left -ne $outer.left -or $after.top -ne $outer.top -or
        $after.right -ne $outer.right -or $after.bottom -ne $outer.bottom) { return $null }
    $crop=New-Object System.Drawing.Rectangle $left,$top,$Width,$Height
    $cropped=$raw.Clone($crop,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $allDark=$true
    $stepX=[Math]::Max(4,[Math]::Min(16,[int]($Width/16)))
    $stepY=[Math]::Max(4,[Math]::Min(16,[int]($Height/16)))
    $bmpRect=New-Object System.Drawing.Rectangle 0,0,$Width,$Height
    $bmpData=$cropped.LockBits($bmpRect,[System.Drawing.Imaging.ImageLockMode]::ReadOnly,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      for($y=0;$y -lt $Height;$y+=$stepY){
        $rowOffset=$y*$bmpData.Stride
        for($x=0;$x -lt $Width;$x+=$stepX){
          $argb=[System.Runtime.InteropServices.Marshal]::ReadInt32($bmpData.Scan0,$rowOffset+($x*4))
          if(((($argb -shr 16) -band 0xFF) -gt 4) -or ((($argb -shr 8) -band 0xFF) -gt 4) -or (($argb -band 0xFF) -gt 4)){$allDark=$false;break}
        }
        if(-not $allDark){break}
      }
    } finally {
      $cropped.UnlockBits($bmpData)
    }
    if($allDark){return $null}
    $accepted=$true;return $cropped
  } finally {
    $raw.Dispose()
    if(-not $accepted -and $null -ne $cropped){$cropped.Dispose()}
  }
}

# Our own screenshot PNGs older than 30 minutes. Times compare in UTC: a
# local write time against a UTC cutoff kept files for hours east of UTC and
# deleted fresh ones west of it.
$script:LastScreenshotCleanupUtc = $null
function Remove-OldScreenshots {
  $now = [DateTime]::UtcNow
  if ($null -ne $script:LastScreenshotCleanupUtc -and ($now - $script:LastScreenshotCleanupUtc).TotalSeconds -lt 60) { return }
  $script:LastScreenshotCleanupUtc = $now
  $cutoff = $now.AddMinutes(-30)
  try {
    foreach ($file in [System.IO.Directory]::EnumerateFiles($env:TEMP, 'windows-computer-use-*.png')) {
      if ([System.IO.File]::GetLastWriteTimeUtc($file) -lt $cutoff) { Remove-TempFile $file }
    }
  } catch { }
}

function Capture-Screenshot {
  param([object]$WindowElement = $null, [int]$MaxWidth = 1600, [bool]$IncludeImageData = ($script:WcuImageData -ne $false), [switch]$InMemory)
  $background = $env:WCU_BACKGROUND_DESKTOP -eq '1'
  if ($background -and $null -eq $WindowElement) {
    throw 'WCU_BACKGROUND_DESKTOP_TARGET_REQUIRED: capture a window by its nativeWindowHandle.'
  }
  if (-not $InMemory) { Remove-OldScreenshots }
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = $null
  $method = "screen"
  $occludedPossible = $false
  $windowCaptureFailed = $false
  $bx = $vs.Left; $by = $vs.Top; $bw = $vs.Width; $bh = $vs.Height
  $minimized = $false

  if ($null -ne $WindowElement) {
    $hwnd = if (Get-Prop $WindowElement 'nativeWindowHandle' 0) { [int64]$WindowElement.nativeWindowHandle } else { Invoke-Safe { [int64]$WindowElement.Current.NativeWindowHandle } 0 }
    # Windows parks a minimized window at -32000,-32000 and draws only its
    # title strip there: the capture works but shows nothing of the app (#82).
    $minimized = [bool]($hwnd -and [WindowsComputerUseNative]::IsIconic([IntPtr]$hwnd))
    $rect = $null
    if ($hwnd -and $hwnd -ne 0) { $rect = Get-ExtendedFrameBounds -Hwnd $hwnd }
    if ($null -eq $rect) { $rect = Convert-Rect (Invoke-Safe { $WindowElement.Current.BoundingRectangle } $null) }

    if ($null -ne $rect -and $hwnd -and $hwnd -ne 0) {
      # PrintWindow may return success with a partial Chromium/CEF surface.
      # For an unobstructed foreground window, read the actual desktop pixels.
      # Recheck Z order, focus and geometry after the copy before accepting it.
      if (-not $background -and (Invoke-Safe { Test-WindowScreenCapture -Hwnd $hwnd -Bounds $rect -VirtualScreen $vs } $false)) {
        $screen = $null
        try {
          $screen = New-Object System.Drawing.Bitmap $rect.width, $rect.height
          $sg = [System.Drawing.Graphics]::FromImage($screen)
          try { $sg.CopyFromScreen($rect.x, $rect.y, 0, 0, $screen.Size) } finally { $sg.Dispose() }
          $after = Get-ExtendedFrameBounds -Hwnd $hwnd
          if ($null -ne $after -and $after.x -eq $rect.x -and $after.y -eq $rect.y -and
              $after.width -eq $rect.width -and $after.height -eq $rect.height -and
              (Test-WindowScreenCapture -Hwnd $hwnd -Bounds $rect -VirtualScreen $vs)) {
            $bmp = $screen; $screen = $null; $method = "screen-region"
          }
        } catch {
          # The native window capture chain remains available after a race or
          # an unavailable desktop surface; no focus change is requested here.
        } finally {
          if ($null -ne $screen) { $screen.Dispose() }
        }
      }
      if ($null -eq $bmp) { $bmp = Invoke-Safe { Try-PrintWindowCapture -Hwnd $hwnd -Width $rect.width -Height $rect.height } $null }
      if ($null -ne $bmp) {
        if ($method -ne "screen-region") { $method = "printwindow" }
        $bx = $rect.x; $by = $rect.y; $bw = $rect.width; $bh = $rect.height
      } elseif (-not $background) {
        # PrintWindow may fail for composited surfaces. The final screen crop
        # is explicitly marked as possibly occluded.
        if ($null -eq $bmp) {
          # Last resort: the on-screen part of the window rect. This may show
          # whatever is covering the window — flagged, not hidden.
          $cx = [Math]::Max($rect.x, $vs.Left); $cy = [Math]::Max($rect.y, $vs.Top)
          $cx2 = [Math]::Min($rect.x + $rect.width, $vs.Left + $vs.Width)
          $cy2 = [Math]::Min($rect.y + $rect.height, $vs.Top + $vs.Height)
          if ($cx2 -gt $cx -and $cy2 -gt $cy) {
            $tmp = New-Object System.Drawing.Bitmap ($cx2 - $cx), ($cy2 - $cy)
            $g = [System.Drawing.Graphics]::FromImage($tmp)
            try { $g.CopyFromScreen($cx, $cy, 0, 0, $tmp.Size) } finally { $g.Dispose() }
            $bmp = $tmp
            $method = "screen-region"
            $occludedPossible = $true
            $bx = $cx; $by = $cy; $bw = $cx2 - $cx; $bh = $cy2 - $cy
          } else {
            $windowCaptureFailed = $true
          }
        }
      }
    } else {
      $windowCaptureFailed = $true
    }
  }

  if ($null -eq $bmp) {
    if ($background) { throw 'WCU_BACKGROUND_DESKTOP_LIMIT: Windows could not capture this window on the background desktop.' }
    if ($windowCaptureFailed) {
      # Target window has no capturable surface (minimized/hidden): capture
      # the whole screen but say so explicitly instead of pretending.
      $windowCaptureFailed = $true
    }
    $bmp = New-Object System.Drawing.Bitmap $bw, $bh
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try { $g.CopyFromScreen($bx, $by, 0, 0, $bmp.Size) } finally { $g.Dispose() }
  }

  $scale = 1.0
  if ($MaxWidth -gt 0 -and $bmp.Width -gt $MaxWidth) {
    $scale = [double]$MaxWidth / [double]$bmp.Width
    $nw = [int]$MaxWidth
    $nh = [int]($bmp.Height * $scale)
    if ($nh -lt 1) { $nh = 1 }
    $small = New-Object System.Drawing.Bitmap $nw, $nh
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    try {
      $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g2.DrawImage($bmp, 0, 0, $nw, $nh)
    } finally { $g2.Dispose() }
    $bmp.Dispose()
    $bmp = $small
  }

  $file = $null; $pngBytes = $null
  if ($InMemory) {
    $stream = New-Object System.IO.MemoryStream
    try { $bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png); $pngBytes = $stream.ToArray() }
    finally { $stream.Dispose(); $bmp.Dispose() }
    $byteLength = $pngBytes.Length
  } else {
    $file = Join-Path $env:TEMP ("windows-computer-use-" + [Guid]::NewGuid().ToString("N") + ".png")
    try { $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $bmp.Dispose() }
    $byteLength = (New-Object System.IO.FileInfo -ArgumentList $file).Length
  }

  $meta = [ordered]@{
    path = $file
    mimeType = "image/png"
    bytes = $byteLength
    method = $method
    bounds = [ordered]@{ x = $bx; y = $by; width = $bw; height = $bh }
    imageScale = [Math]::Round($scale, 4)
  }
  if ($method -eq "screen-region") { $meta["occludedPossible"] = $occludedPossible }
  if ($windowCaptureFailed) { $meta["windowCaptureFailed"] = $true }
  if ($minimized) { $meta["minimized"] = $true }
  if ($scale -ne 1.0) {
    $meta["imageScale"] = [Math]::Round($scale, 4)
    $meta["origin"] = [ordered]@{ x = $bx; y = $by }
  }
  if ($InMemory) { $meta['pngBytes'] = $pngBytes }
  elseif ($IncludeImageData) { $meta['base64'] = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($file)) }
  return $meta
}

function Get-ObservationWindow {
  # Without a window target: the window DSH works in (see Get-WorkWindow), or
  # with -Foreground the window actually in front.
  param([object]$InputObject, [string]$Scope = "active_window", [switch]$Foreground)
  if ($Scope -eq "desktop") { return $null }
  if (Has-WindowTarget $InputObject) {
    return (Select-TargetWindow $InputObject)
  }
  $hwnd = if ($Foreground) { [WindowsComputerUseNative]::GetForegroundWindow().ToInt64() } else { Get-WorkWindow }
  foreach ($info in (Get-NativeWindowList -IncludeInvisible $true -MaxWindows 4096)) {
    if ([int64]$info.nativeWindowHandle -eq $hwnd) { return $info }
  }
  return $null
}

function Get-WindowResponsive {
  param([object]$Window)
  if ($null -eq $Window) { return $null }
  return [WindowsComputerUseNative]::IsResponsive([IntPtr]([int64]$Window.nativeWindowHandle))
}

# ----------------------------------------------------------------------------
# Chromium page content (issue #50). Electron, Chrome/Edge, CEF and WebView2
# build a page's accessibility tree only after a UIA client reads a property of
# the page root, the first child of the Chrome_RenderWidgetHostHWND window.
# The control view skips that empty root, so tree walks alone can leave a
# window at its frame and layout panes. Before a window-scoped observation,
# read the root of each visible renderer and wait briefly for the page tree.
# An empty renderer is retried by later observations for 30 seconds; a single
# call waits at most 1.5 seconds and half of its traversal budget.
# ----------------------------------------------------------------------------
$script:ChromiumPages = @{}   # renderer hwnd -> @{ processId; firstSeen; ready }

function Test-ChromiumPage {
  param([IntPtr]$Renderer)
  # Resolve the renderer on every probe: enabling the page tree replaces the
  # root, and navigation from an element obtained earlier stays empty.
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $root = $walker.GetFirstChild([System.Windows.Automation.AutomationElement]::FromHandle($Renderer))
  if ($null -eq $root) { return $false }
  [void]$root.Current.ControlType
  return ($null -ne $walker.GetFirstChild($root))
}

# Attachment is not content. A document that finished loading before its content
# reached the DOM exposes its root and one unnamed container, so the page tree is
# attached while the window shows nothing: measured on Edge 157, a page whose
# body held only an empty mount element gave one descendant with no name, 0
# characters of text and the same all-white frame as about:blank. This walk
# answers one question -- does the page carry text? -- so one observation can
# say "nothing to read yet" instead of leaving it to be inferred from the
# attachment flag.
#
# It stops at the first descendant that carries text: the answer is a boolean,
# so walking the rest only spends the caller's time budget (measured on
# Electron 44, a full walk doubled a normal page's observation, 129 -> 274 ms).
# It also stops at $LimitMs and at $MaxNodes and says which happened, so a walk
# that did not finish is reported as unknown instead of empty.
#
# The page root is skipped on purpose: its name is the document title, which an
# otherwise blank page has too (<title> with an empty body still yields a named
# root). Returns $null when the renderer exposes no page root at all, which is
# "not built yet", not "empty".
#
# This looks for text, and only text. A page whose whole content is an image or
# a canvas carries no text and can still be a working page, so "no text" is a
# fact about text nodes, not a verdict about the page; callers must not turn it
# into "broken", and not into "reload".
function Get-ChromiumPageContent {
  param([IntPtr]$Renderer, [int]$LimitMs = 250, [int]$MaxNodes = 200)
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $root = $walker.GetFirstChild([System.Windows.Automation.AutomationElement]::FromHandle($Renderer))
  if ($null -eq $root) { return $null }
  [void]$root.Current.ControlType
  $facts = @{ hasText = $false; truncated = $false }
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $visited = 0
  $queue = New-Object System.Collections.Generic.Queue[object]
  $child = $walker.GetFirstChild($root)
  while ($null -ne $child -and $queue.Count -lt $MaxNodes -and $watch.ElapsedMilliseconds -lt $LimitMs) {
    $queue.Enqueue($child)
    $child = $walker.GetNextSibling($child)
  }
  if ($null -ne $child) { $facts.truncated = $true }
  while ($queue.Count -gt 0) {
    # Both limits mean the same thing here: the subtree was not read to the end.
    if ($visited -ge $MaxNodes -or $watch.ElapsedMilliseconds -ge $LimitMs) { $facts.truncated = $true; break }
    $element = $queue.Dequeue()
    $visited++
    $text = ''
    try { $text = [string]$element.Current.Name } catch { }
    if (-not $text.Trim()) {
      # A control that carries only a value (a filled input, a document body)
      # still shows text; the name is not the only place it can live.
      try {
        $pattern = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
          if ($null -ne $pattern -and ([string]$pattern.Current.Value).Trim()) { $text = [string]$pattern.Current.Value }
        }
      } catch { }
    }
    if ($text.Trim()) { return @{ hasText = $true; truncated = $false } }
    if ($watch.ElapsedMilliseconds -ge $LimitMs) { $facts.truncated = $true; break }
    $next = $walker.GetFirstChild($element)
    while ($null -ne $next -and $queue.Count -lt $MaxNodes -and $watch.ElapsedMilliseconds -lt $LimitMs) {
      $queue.Enqueue($next)
      $next = $walker.GetNextSibling($next)
    }
    if ($null -ne $next) { $facts.truncated = $true }
  }
  return $facts
}

