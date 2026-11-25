  // A guard that acted between two steps, for the next result.
  public static string TakeNotice() { lock (gate) { string text = notice; notice = null; return text; } }

  static bool Present(IntPtr window) { return window != IntPtr.Zero && WindowsComputerUseNative.IsWindow(window) && WindowsComputerUseNative.IsWindowVisible(window); }
  static bool GiveBack(IntPtr window) {
    if (WindowsComputerUseNative.GiveForeground(window)) return true;
    System.Threading.Thread.Sleep(30);
    return WindowsComputerUseNative.GiveForeground(window);
  }
  static void Place(int x, int y) {
    int left = WindowsComputerUseNative.GetSystemMetrics(76), top = WindowsComputerUseNative.GetSystemMetrics(77);
    int width = WindowsComputerUseNative.GetSystemMetrics(78), height = WindowsComputerUseNative.GetSystemMetrics(79);
    if (width > 0 && height > 0) { x = Math.Max(left, Math.Min(left + width - 1, x)); y = Math.Max(top, Math.Min(top + height - 1, y)); }
    WindowsComputerUseNative.SetCursorPos(x, y);
  }
  static System.Collections.Generic.HashSet<long> TopLevelSet() {
    var set = new System.Collections.Generic.HashSet<long>();
    foreach (IntPtr window in WindowsComputerUseNative.TopLevelWindows()) set.Add(window.ToInt64());
    return set;
  }
  // Under gate. A window DSH worked in, one of them owns, or a new window of
  // the processes DSH worked in.
  static bool IsDsh(IntPtr window) {
    if (window == IntPtr.Zero) return false;
    IntPtr owner = window;
    for (int depth = 0; owner != IntPtr.Zero && depth < 8; depth++) {
      if (dshWindows.Contains(owner.ToInt64())) return true;
      owner = WindowsComputerUseNative.GetWindow(owner, 4);
    }
    uint pid; WindowsComputerUseNative.GetWindowThreadProcessId(window, out pid);
    return pid != 0 && dshProcesses.Contains(pid) && !before.Contains(window.ToInt64());
  }
  static bool Overdue() { return (DateTime.UtcNow - since).TotalMilliseconds > 8000; }

  // Replays the queue in order, also what arrives meanwhile, then switches
  // from expected to next once nothing is left (unless a new step took over).
  // Each batch waits until the hooks have seen its events: input the user sent
  // before them is ahead in Windows' queue and must be held, not let through
  // after the switch ahead of the replay. Keys go nowhere when they cannot
  // reach the user's window. Returns how many key events were dropped.
  static int Drain(bool deliverKeys, int expected, int next) {
    int dropped = 0, size = Marshal.SizeOf(typeof(WindowsComputerUseNative.INPUT));
    for (;;) {
      Held[] batch;
      lock (gate) {
        if (Decisions.State != expected) return dropped;
        if (Decisions.Queue.Count == 0) { Decisions.State = next; Decisions.Keys.Clear(); Decisions.Buttons.Clear(); Decisions.PreHeld.Clear(); return dropped; }
        batch = Decisions.Queue.ToArray(); Decisions.Queue.Clear();
      }
      int sent = 0;
      foreach (Held held in batch) {
        if (held.Key && !deliverKeys) { dropped++; continue; }
        if (!held.Key) WindowsComputerUseNative.SetCursorPos(held.X, held.Y);
        sent += (int)WindowsComputerUseNative.SendInput(1, new WindowsComputerUseNative.INPUT[] { ToInput(held) }, size);
      }
      int target = System.Threading.Interlocked.Add(ref replaySent, sent);
      DateTime start = DateTime.UtcNow;
      while (System.Threading.Volatile.Read(ref replaySeen) < target && (DateTime.UtcNow - start).TotalMilliseconds < 500) System.Threading.Thread.Sleep(1);
      if (System.Threading.Volatile.Read(ref replaySeen) < target) System.Threading.Interlocked.Exchange(ref replaySeen, target);
    }
  }
  static int replaySent, replaySeen;
  // On the hook thread: a replayed event has reached the hooks.
  static void Seen(bool injected, ulong extra) { if (injected && extra == (ulong)ReplayMarker) System.Threading.Interlocked.Increment(ref replaySeen); }
  static void ReturnToUser(object ignored) {
    IntPtr target; lock (gate) target = user;
    bool returned = Present(target) && GiveBack(target);
    Drain(returned, Returning, Idle);
    lock (gate) notice = returned
      ? "Since your last step the user typed while a window DSH worked in was in front, so the foreground went back to their window and their keys went there. Observe again before acting in that window."
      : "Since your last step the user typed while a window DSH worked in was in front; Windows did not give their window the foreground, so those keys were dropped.";
    Request(UninstallMessage, false);
  }

  // The hooks live on one thread with a message loop. Install and remove are
  // requests to it; a remove without force waits until nothing is held or guarded.
  delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] struct KeyData { public uint vk, scan, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MouseData { public int x, y; public uint data, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct Msg { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern int GetMessage(out Msg message, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] static extern bool PeekMessage(out Msg message, IntPtr hwnd, uint min, uint max, uint remove);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  const uint InstallMessage = 0x8001, UninstallMessage = 0x8002;
  static readonly HookProc keyboardProc = OnKey, mouseProc = OnMouse;
  static readonly object pump = new object();
  static System.Threading.Thread thread;
  static uint threadId;
  static int requested, done;
  static IntPtr keyboardHook, mouseHook;

  static void Pump() {
    Msg message;
    PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
    lock (pump) { threadId = WindowsComputerUseNative.GetCurrentThreadId(); System.Threading.Monitor.PulseAll(pump); }
    while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {
      if (message.message == InstallMessage) {
        if (keyboardHook == IntPtr.Zero) keyboardHook = SetWindowsHookEx(13, keyboardProc, GetModuleHandle(null), 0);
        if (mouseHook == IntPtr.Zero) mouseHook = SetWindowsHookEx(14, mouseProc, GetModuleHandle(null), 0);
      } else if (message.message == UninstallMessage) {
        bool idle; lock (gate) idle = Decisions.State == Idle;
        if (idle || message.lParam != IntPtr.Zero) {
          if (keyboardHook != IntPtr.Zero) { UnhookWindowsHookEx(keyboardHook); keyboardHook = IntPtr.Zero; }
          if (mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(mouseHook); mouseHook = IntPtr.Zero; }
        }
      } else continue;
      lock (pump) { done = Math.Max(done, message.wParam.ToInt32()); System.Threading.Monitor.PulseAll(pump); }
    }
  }
  static bool Request(uint message, bool force) {
    int sequence; uint target;
    lock (pump) {
      if (thread == null || !thread.IsAlive) {
        threadId = 0;
        thread = new System.Threading.Thread(Pump);
        thread.IsBackground = true; thread.Name = "DSH input hold"; thread.Start();
        DateTime start = DateTime.UtcNow;
        while (threadId == 0 && (DateTime.UtcNow - start).TotalMilliseconds < 2000) System.Threading.Monitor.Wait(pump, 100);
        if (threadId == 0) return false;
      }
      sequence = ++requested; target = threadId;
    }
    if (!PostThreadMessage(target, message, new IntPtr(sequence), new IntPtr(force ? 1 : 0))) return false;
    lock (pump) {
      DateTime start = DateTime.UtcNow;
      while (done < sequence) {
        int left = 1000 - (int)(DateTime.UtcNow - start).TotalMilliseconds;
        if (left <= 0) return false;
        System.Threading.Monitor.Wait(pump, left);
      }
      return message != InstallMessage || (keyboardHook != IntPtr.Zero && mouseHook != IntPtr.Zero);
    }
  }
  static void Release() { PostThreadMessage(threadId, UninstallMessage, IntPtr.Zero, IntPtr.Zero); }

  static IntPtr OnKey(int code, IntPtr wParam, IntPtr lParam) {
    if (code >= 0) {
      var data = (KeyData)Marshal.PtrToStructure(lParam, typeof(KeyData));
      Seen((data.flags & 0x10) != 0, data.extra.ToUInt64());
      int kind = wParam.ToInt32();
      bool up = kind == 0x101 || kind == 0x105, swallow, returning, ended;
      bool down = !up && (GetAsyncKeyState((int)data.vk) & 0x8000) != 0;
      lock (gate) {
        int was = Decisions.State;
        bool dshInFront = false;
        if (was == Guarding && !up) {
          if (DateTime.UtcNow > guardUntil) Decisions.State = Idle;
          else {
            IntPtr front = WindowsComputerUseNative.GetForegroundWindow();
            dshInFront = front != user && Present(user) && IsDsh(front);
          }
        }
        swallow = Decisions.Key((int)data.vk, (int)data.scan, (int)data.flags, data.extra.ToUInt64(), up, down, dshInFront, was == Holding && Overdue());
        returning = was == Guarding && Decisions.State == Returning;
        ended = was == Guarding && Decisions.State == Idle;
      }
      if (returning) System.Threading.ThreadPool.QueueUserWorkItem(ReturnToUser);
      if (ended) Release();
      if (swallow) return new IntPtr(1);
    }
    return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
  }
  static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam) {
    if (code >= 0) {
      var data = (MouseData)Marshal.PtrToStructure(lParam, typeof(MouseData));
      Seen((data.flags & 0x01) != 0, data.extra.ToUInt64());
      WindowsComputerUseNative.POINT cursor;
      WindowsComputerUseNative.GetCursorPos(out cursor);
      bool swallow, ended;
      lock (gate) {
        int was = Decisions.State;
        swallow = Decisions.Mouse(wParam.ToInt32(), data.x, data.y, cursor.x, cursor.y, unchecked((int)data.data), (int)data.flags, data.extra.ToUInt64(), was == Holding && Overdue());
        ended = was == Guarding && Decisions.State == Idle;
      }
      if (ended) Release();
      if (swallow) return new IntPtr(1);
    }
    return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
  }
}
'@

function Get-CsHash {
  param([string]$Source)
  $normalized = $Source.Replace("`r`n", "`n").Replace("`r", "`n")
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($normalized))
    return ([BitConverter]::ToString($bytes).Replace("-", "").Substring(0, 16)).ToLowerInvariant()
  } finally { $sha.Dispose() }
}

# Load a helper compiled into %TEMP%, compiling it first when no cached copy
# exists. The bytes are read rather than passed to Assembly.LoadFrom: .NET
# Framework refuses LoadFrom for an unsigned DLL it treats as coming from a
# remote or internet location (0x80131515), which left every tool failing with
# "Backend process exited" on some machines (#54). The compiler writes a
# file of its own and only a complete one is moved into place, because another
# backend may be reading the cache at the same time.
#
# TEMP is often an 8.3 short path. Windows PowerShell's FileSystemProvider
# rejects a short name that is longer than the name it stands for, such as
# C:\Users\LIHUA~1 for "Li Hua", with "An object at the specified path ...
# does not exist" (#78). Remove-Item met that on every OCR compile, so
# temporary files are handled with .NET calls only, never with Remove-Item,
# Get-ChildItem or Test-Path.
function Remove-TempFile {
  param([string]$Path)
  try { [System.IO.File]::Delete($Path) } catch { }
}

function Get-HelperCacheDir {
  $local = [Environment]::GetFolderPath('LocalApplicationData')
  $configured = [string]$env:TEMP
  if ($configured -and [IO.Directory]::Exists($configured)) {
    # Resolve a user's usual 8.3 TEMP spelling before deciding whether it is
    # a caller override. Cache file I/O itself still uses .NET paths.
    try { $configured = (Get-Item -LiteralPath $configured -ErrorAction Stop).FullName } catch {}
  }
  $default = Join-Path $local 'Temp'
  $userTemp = [Environment]::ExpandEnvironmentVariables([string][Environment]::GetEnvironmentVariable('TEMP','User'))
  if ($configured -and $configured.TrimEnd('\') -ne $default.TrimEnd('\') -and $configured -ne $userTemp) {
    if (-not [IO.Path]::IsPathRooted($configured)) { throw 'The configured TEMP path must be absolute.' }
    $dir = [IO.Path]::GetFullPath($configured)
  } else {
    $dir = Join-Path $local 'dsh-computer-use-win\native-cache'
    if (-not [IO.Directory]::Exists($dir)) {
      $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
      try {
        $acl=[Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true,$false)
        foreach($sid in @($identity.User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
          $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
        }
        if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::Create([IO.DirectoryInfo]::new($dir),$acl) }
        else { [void][IO.Directory]::CreateDirectory($dir,$acl) }
      } finally { $identity.Dispose() }
    }
  }
  [void][IO.Directory]::CreateDirectory($dir)
  Assert-PrivateHelperPath $dir -Directory
  return $dir
}

function Assert-PrivateHelperPath {
  param([string]$Path, [switch]$Directory)
  $attributes = [IO.File]::GetAttributes($Path)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -or
      ([bool]($attributes -band [IO.FileAttributes]::Directory) -ne [bool]$Directory)) {
    throw 'Native cache must contain ordinary files in a private directory.'
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try { $trusted = @($identity.User.Value,$identity.Owner.Value,'S-1-5-18','S-1-5-32-544') }
  finally { $identity.Dispose() }
  $item = if ($Directory) { [IO.DirectoryInfo]::new($Path) } else { [IO.FileInfo]::new($Path) }
  $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
  $acl = if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::GetAccessControl($item,$sections) } else { $item.GetAccessControl($sections) }
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) {
    throw 'Native cache ownership does not match the Windows account.'
  }
  $writeRights = [Security.AccessControl.FileSystemRights]'WriteData, AppendData, DeleteSubdirectoriesAndFiles, Delete, ChangePermissions, TakeOwnership'
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and
        ($rule.FileSystemRights -band $writeRights) -and $rule.IdentityReference.Value -notin $trusted) {
      throw 'Native cache grants write access to another account.'
    }
  }
}

function Get-HelperDigest {
  param([byte[]]$Bytes)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

# A compile that failed or was cut off leaves <helper>.<pid>.<guid>.dll and
# its .cs source behind (one pair per OCR call on the machines of #78). Those
# an hour old are removed before a helper is compiled.
function Remove-StaleHelperParts {
  param([string]$Directory)
  $cutoff = [DateTime]::UtcNow.AddHours(-1)
  try {
    foreach ($file in [System.IO.Directory]::EnumerateFiles($Directory, 'wcu-*.dll*')) {
      if ([System.IO.Path]::GetFileName($file) -cmatch '^wcu-(native|ocr|clipboard|wgc)-[a-z0-9-]+\.\d+\.[0-9a-f]{32}\.dll(\.cs)?$' -and [System.IO.File]::GetLastWriteTimeUtc($file) -lt $cutoff) { Remove-TempFile $file }
    }
  } catch { }
}

function Import-HelperAssembly {
  param([string]$Path, [scriptblock]$Compile)
  $directory = [IO.Path]::GetDirectoryName($Path)
  Assert-PrivateHelperPath $directory -Directory
  $digestFile = $Path + '.sha256'
  $mutex = [Threading.Mutex]::new($false, ('Local\DSH-WCU-Helper-' + (Get-CsHash $Path.ToUpperInvariant())))
  $owned = $false
  $partial = $Path -replace '\.dll$', (".$PID." + [Guid]::NewGuid().ToString('N') + '.dll')
  try {
    try { $owned = $mutex.WaitOne(20000) } catch [Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { throw 'Timed out waiting for the native helper cache.' }
    if ([IO.File]::Exists($Path)) { Assert-PrivateHelperPath $Path }
    if ([IO.File]::Exists($digestFile)) { Assert-PrivateHelperPath $digestFile }
    if ([IO.File]::Exists($Path) -and [IO.File]::Exists($digestFile)) {
      $bytes = [IO.File]::ReadAllBytes($Path)
      if ((Get-HelperDigest $bytes) -ceq [IO.File]::ReadAllText($digestFile)) {
        [void][Reflection.Assembly]::Load($bytes)
        return
      }
    }
    Remove-StaleHelperParts $directory
    & $Compile $partial
    $bytes = [IO.File]::ReadAllBytes($partial)
    [IO.File]::WriteAllText("$partial.sha256",(Get-HelperDigest $bytes))
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($partial,$Path,[NullString]::Value) }
    else { [IO.File]::Move($partial,$Path) }
    if ([IO.File]::Exists($digestFile)) { [IO.File]::Replace("$partial.sha256",$digestFile,[NullString]::Value) }
    else { [IO.File]::Move("$partial.sha256",$digestFile) }
    [void][Reflection.Assembly]::Load($bytes)
  } finally {
    Remove-TempFile $partial
    Remove-TempFile "$partial.cs"
    Remove-TempFile "$partial.sha256"
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

function Load-Assemblies {
  # DPI awareness MUST be set before any GDI+/WinForms assembly is loaded:
  # loading System.Windows.Forms/System.Drawing initializes GDI, which locks
  # the process DPI context (and GetSystemMetrics then returns virtualized
  # 150%-scaled values like 3414x960 instead of physical 5120x1440).
  if (-not ("WindowsComputerUseNative" -as [type])) {
    Write-BackendStage 'native-load-start'
    # Add-Type targets the current runtime. A Core-built helper cannot be used
    # by Windows PowerShell 5.1 even when its C# source is identical.
    $runtimeKey = $PSVersionTable.PSEdition.ToLowerInvariant() + '-clr' + [Environment]::Version.Major
    $precompiled = (Get-Command Import-PackagedHelper -ErrorAction SilentlyContinue) -and (Import-PackagedHelper -Name native -Source $script:WcuCs)
    if (-not $precompiled) {
      $dll = Join-Path (Get-HelperCacheDir) ("wcu-native-" + $runtimeKey + '-' + (Get-CsHash -Source $script:WcuCs) + ".dll")
      Import-HelperAssembly -Path $dll -Compile { param($out) Add-Type -TypeDefinition $script:WcuCs -OutputAssembly $out }
    }
  }
  Write-BackendStage 'native-load-complete'
  Set-DpiAware
  Write-BackendStage 'uia-assemblies-start'

  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  # Standard Win32 controls need the client-side providers. Without these,
  # controls can silently appear as unnamed Pane nodes with no Value pattern.
  Add-Type -AssemblyName UIAutomationClientsideProviders
  # Register the exported table directly: .NET 10 assembly-name casing breaks proxy type lookup.
  Write-BackendStage 'uia-providers-start'
  $providers = [UIAutomationClientsideProviders.UIAutomationClientSideProviders]::ClientSideProviderDescriptionTable
  try {
    [System.Windows.Automation.ClientSettings]::RegisterClientSideProviders($providers)
  } catch {
    # .NET Framework's first registration can initialize its proxy table and
    # throw NullReferenceException. A single second registration completes it.
    if ($_.Exception.InnerException -isnot [NullReferenceException]) { throw }
    [System.Windows.Automation.ClientSettings]::RegisterClientSideProviders($providers)
  }
  Write-BackendStage 'uia-providers-complete'
  Add-Type -AssemblyName WindowsBase
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Write-BackendStage 'assemblies-complete'
}

function Set-DpiAware {
  # Per-Monitor V2 (context value -4); fall back to system-aware. Must run
  # before any screen/UIA work so coordinates and pixels are physical.
  $ok = $false
  try { $ok = [WindowsComputerUseNative]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) }
  catch [EntryPointNotFoundException] {}
  if (-not $ok) {
    [void][WindowsComputerUseNative]::SetProcessDPIAware()
  }
}

function Invoke-Safe {
  param([scriptblock]$Block, [object]$Default = $null)
  try {
    return & $Block
  } catch {
    return $Default
  }
}

function Get-ControlTypeName {
  param([object]$ControlType)
  if ($null -eq $ControlType) { return $null }
  $name = Invoke-Safe { $ControlType.ProgrammaticName } $null
  if ($null -eq $name) { return $null }
  return ($name -replace "^ControlType\.", "")
}

function Convert-Rect {
  param([object]$Rect)
  if ($null -eq $Rect) { return $null }
  $empty = Invoke-Safe { $Rect.IsEmpty } $true
  if ($empty) { return $null }
  $x = [int][Math]::Round($Rect.X)
  $y = [int][Math]::Round($Rect.Y)
  $width = [int][Math]::Round($Rect.Width)
  $height = [int][Math]::Round($Rect.Height)
  return [ordered]@{
    x = $x
    y = $y
    width = $width
    height = $height
    centerX = [int]($x + ($width / 2))
    centerY = [int]($y + ($height / 2))
  }
}

function Get-Patterns {
  param([object]$Element)
  $items = New-Object System.Collections.Generic.List[string]
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern) } $false) { $items.Add("Invoke") }
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) } $false) { $items.Add("Value") }
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern) } $false) { $items.Add("Toggle") }
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern) } $false) { $items.Add("SelectionItem") }
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern) } $false) { $items.Add("ExpandCollapse") }
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$pattern) } $false) { $items.Add("ScrollItem") }
  return ,([string[]]$items.ToArray())
}

function Get-ValueText {
  param([object]$Element)
  if (Invoke-Safe { $Element.Current.IsPassword } $true) { return $null }
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) } $false) {
    return Invoke-Safe { $pattern.Current.Value } $null
  }
  return $null
}

function New-ElementCacheRequest {
  param([string]$DetailLevel = "compact")
  $cache = New-Object System.Windows.Automation.CacheRequest
  $cache.TreeScope = [System.Windows.Automation.TreeScope]::Element
  $cache.TreeFilter = [System.Windows.Automation.Automation]::RawViewCondition
  # Full keeps a live reference for navigation/actions; all observation reads
  # below use Cached, including RuntimeId. Never fetch an entire subtree.
  $cache.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::Full
  foreach ($name in @('Name','AutomationId','ClassName','ControlType','BoundingRectangle',
      'IsEnabled','IsOffscreen','HasKeyboardFocus','ProcessId','NativeWindowHandle','RuntimeId','FrameworkId','IsPassword')) {
    $cache.Add([System.Windows.Automation.AutomationElement]::("${name}Property"))
  }
  if ($DetailLevel -eq "full") {
    $cache.Add([System.Windows.Automation.AutomationElement]::LocalizedControlTypeProperty)
    $cache.Add([System.Windows.Automation.ValuePattern]::ValueProperty)
    foreach ($pattern in @([System.Windows.Automation.InvokePattern]::Pattern,
        [System.Windows.Automation.ValuePattern]::Pattern, [System.Windows.Automation.TogglePattern]::Pattern,
        [System.Windows.Automation.SelectionItemPattern]::Pattern,
        [System.Windows.Automation.ExpandCollapsePattern]::Pattern, [System.Windows.Automation.ScrollItemPattern]::Pattern)) {
      $cache.Add($pattern)
    }
  }
  return $cache
}

$script:ElementGeneration = [long]0
$script:ElementRegistry = @{}
function Register-ObservedElement {
  param([string]$Id,[object]$Element,[object]$Owner)
  if ($null -eq $script:ElementRegistry) { $script:ElementRegistry=@{} }
  if (-not $script:ElementRegistry.ContainsKey($Id) -and $script:ElementRegistry.Count -ge 6000) {
    $candidates=@($script:ElementRegistry.GetEnumerator() | Where-Object {
      [long]$_.Value.generation -ne [long]$script:ElementGeneration
    } | Sort-Object { [long]$_.Value.ts } | Select-Object -First 1000)
    foreach ($old in $candidates) { $script:ElementRegistry.Remove($old.Key) }
  }
  $script:ElementRegistry[$Id]=@{element=$Element;hwnd=$Owner.nativeWindowHandle;processId=$Owner.processId;
    ts=[DateTimeOffset]::Now.ToUnixTimeMilliseconds();generation=$script:ElementGeneration}
}
$script:ObservationOwner = $null
$script:NativeOwners = @{}
function Convert-ElementInfo {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [string]$Id = $null,
    [int]$Depth = 0,
    [string]$DetailLevel = "full",
    [switch]$UseCache
  )
  if (-not $UseCache) {
    $Element = $Element.GetUpdatedCache((New-ElementCacheRequest $DetailLevel))
  }
  $cached = try { $Element.Cached } catch { $null }
  $rect = Convert-Rect $(try { $cached.BoundingRectangle } catch { $null })
  $rtArr = try { @($Element.GetCachedPropertyValue([System.Windows.Automation.AutomationElement]::RuntimeIdProperty)) } catch { $null }
  $rtStr = $null
  if ($null -ne $rtArr -and $rtArr.Count -ge 2) { $rtStr = ($rtArr | ForEach-Object { [int]$_ }) -join "-" }
  $info = [ordered]@{
    id = if ($null -ne $rtStr) { "uia:rt:$rtStr" } else { $Id }
    depth = $Depth
    name = $(try { $cached.Name } catch { "" })
    automationId = $(try { $cached.AutomationId } catch { "" })
    className = $(try { $cached.ClassName } catch { "" })
    controlType = Get-ControlTypeName $(try { $cached.ControlType } catch { $null })
    boundingBox = $rect
    isEnabled = $(try { $cached.IsEnabled } catch { $null })
    isOffscreen = $(try { $cached.IsOffscreen } catch { $null })
    hasKeyboardFocus = $(try { $cached.HasKeyboardFocus } catch { $null })
  }
  if ($null -ne $rtStr -and $null -ne $script:ObservationOwner) {
    Register-ObservedElement "uia:rt:$rtStr" $Element $script:ObservationOwner
  }
  if ($DetailLevel -eq "full") {
    $valuePattern = $null
    $patterns = New-Object System.Collections.Generic.List[string]
    foreach ($pair in @(
      @('Invoke', [System.Windows.Automation.InvokePattern]::Pattern),
      @('Value', [System.Windows.Automation.ValuePattern]::Pattern),
      @('Toggle', [System.Windows.Automation.TogglePattern]::Pattern),
      @('SelectionItem', [System.Windows.Automation.SelectionItemPattern]::Pattern),
      @('ExpandCollapse', [System.Windows.Automation.ExpandCollapsePattern]::Pattern),
      @('ScrollItem', [System.Windows.Automation.ScrollItemPattern]::Pattern)
    )) {
      $pat = try { $Element.GetCachedPattern($pair[1]) } catch { $null }
      if ($null -ne $pat) {
        $patterns.Add($pair[0])
        if ($pair[0] -eq 'Value') { $valuePattern = $pat }
      }
    }
    $info["localizedControlType"] = try { $cached.LocalizedControlType } catch { "" }
    $info["processId"] = try { $cached.ProcessId } catch { $null }
    $info["nativeWindowHandle"] = try { $cached.NativeWindowHandle } catch { $null }
    $info["runtimeId"] = $rtStr
    $isPassword = Invoke-Safe { $cached.IsPassword } $true
    $info["value"] = if ($null -ne $valuePattern -and -not $isPassword) { try { $valuePattern.Cached.Value } catch { $null } } else { $null }
    $info["patterns"] = [string[]]$patterns.ToArray()
  } else {
    if ($Depth -le 1) { $info["processId"] = try { $cached.ProcessId } catch { $null } }
    $nativeHwnd = try { $cached.NativeWindowHandle } catch { 0 }
    if ($nativeHwnd) { $info["nativeWindowHandle"] = $nativeHwnd }
  }
  return $info
}

# ============================================================================
# Window targeting
# ============================================================================

function Has-WindowTarget {
  param([object]$InputObject)
  if ($null -eq $InputObject) { return $false }
  $title = [string](Get-Prop $InputObject "windowTitle" "")
  $processId = Get-Prop $InputObject "processId" $null
  $hwnd = Get-Prop $InputObject "nativeWindowHandle" $null
  return (-not [string]::IsNullOrWhiteSpace($title)) -or ($null -ne $processId) -or ($null -ne $hwnd)
}

function Test-TargetMatch {
  param([object]$Info, [object]$InputObject)
  $title = [string](Get-Prop $InputObject "windowTitle" "")
  $processId = Get-Prop $InputObject "processId" $null
  $hwnd = Get-Prop $InputObject "nativeWindowHandle" $null

  if (-not [string]::IsNullOrWhiteSpace($title)) {
    $name = "" + $Info.name
    if ($name.IndexOf($title, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  }
  if ($null -ne $processId -and [int]$Info.processId -ne [int]$processId) { return $false }
  if ($null -ne $hwnd -and [int64]$Info.nativeWindowHandle -ne [int64]$hwnd) { return $false }
  return $true
}

function Set-WindowForeground {
  param([object]$Element)
  $hwnd = if (Get-Prop $Element 'nativeWindowHandle' 0) { [int64]$Element.nativeWindowHandle } else { Invoke-Safe { $Element.Current.NativeWindowHandle } 0 }
  if (-not ($hwnd -and $hwnd -ne 0)) { return $false }
  Assert-NativeInputTarget $hwnd
  $ptr = [IntPtr]([int64]$hwnd)

  # SW_RESTORE is not a no-op on maximized/snapped windows: it un-maximizes
  # them. Only restore windows that are actually minimized.
  if ([WindowsComputerUseNative]::IsIconic($ptr)) {
    if ($env:WCU_CANCEL_EVENT) { [WindowsComputerUseNative]::ThrowIfCancelled() }
    [WindowsComputerUseNative]::ShowWindow($ptr, 9) | Out-Null
    # Wait until it is restored. A window that ignores ShowWindow still takes
    # the Restore command of its system menu (WM_SYSCOMMAND, SC_RESTORE).
    for ($i = 0; $i -lt 10 -and [WindowsComputerUseNative]::IsIconic($ptr); $i++) {
      if ($i -eq 4) { [void][WindowsComputerUseNative]::PostMessageW($ptr, 0x0112, [IntPtr]0xF120, [IntPtr]::Zero) }
      Start-Sleep -Milliseconds 50
    }
    # A minimized window can still take the foreground, but nobody sees it and
    # input would go to it unseen: report the activation as failed.
    if ([WindowsComputerUseNative]::IsIconic($ptr)) { return $false }
    Start-Sleep -Milliseconds 80
  }
  # First without a key press: joining the input of the thread in front lets
  # SetForegroundWindow pass the foreground on (it worked every time on local
  # fixtures). A lone Alt, below, can move focus to an app's menu bar.
  if ($env:WCU_CANCEL_EVENT) { [WindowsComputerUseNative]::ThrowIfCancelled() }
  if ([WindowsComputerUseNative]::GiveForeground($ptr)) { Start-Sleep -Milliseconds 60; return $true }

  # Beat the Windows foreground lock: a background process is normally
  # silently refused by SetForegroundWindow. Attaching our input thread to
  # the current foreground window's thread and tapping the Alt key releases
  # the lock long enough to switch (classic AutoHotkey trick).
  $fgPtr = [WindowsComputerUseNative]::GetForegroundWindow()
  $fgProcess = [uint32]0
  $fgThread = [WindowsComputerUseNative]::GetWindowThreadProcessId($fgPtr, [ref]$fgProcess)
  if (-not $fgThread) { return $false }
  $ownThread = [WindowsComputerUseNative]::GetCurrentThreadId()
  $attached = $false
  if ($fgThread -ne $ownThread) {
    $attached = [WindowsComputerUseNative]::AttachThreadInput($ownThread, $fgThread, $true)
  }
  try {
    if ($env:WCU_CANCEL_EVENT) { [WindowsComputerUseNative]::ThrowIfCancelled() }
    [void][WindowsComputerUseNative]::keybd_event([WindowsComputerUseNative]::VK_MENU, 0, 0, [UIntPtr]([uint64][WindowsComputerUseNative]::InputMarker))
    [void][WindowsComputerUseNative]::keybd_event([WindowsComputerUseNative]::VK_MENU, 0, [WindowsComputerUseNative]::KEYEVENTF_KEYUP, [UIntPtr]([uint64][WindowsComputerUseNative]::InputMarker))
    if ($env:WCU_CANCEL_EVENT) { [WindowsComputerUseNative]::ThrowIfCancelled() }
    [WindowsComputerUseNative]::SetForegroundWindow($ptr) | Out-Null
    Start-Sleep -Milliseconds 120
  } finally {
    if ($attached) { [void][WindowsComputerUseNative]::AttachThreadInput($ownThread, $fgThread, $false) }
  }

  # Verify the switch actually happened; report it so callers can react.
  $nowFg = [WindowsComputerUseNative]::GetForegroundWindow()
  return ($nowFg -eq $ptr)
}

function Activate-TargetIfRequested {
  param([object]$InputObject)
  if ((Has-WindowTarget $InputObject) -and [bool](Get-Prop $InputObject "activate" $false)) {
    $target = Get-ObservationWindow $InputObject
    Assert-NativeInputTarget ([int64]$target.nativeWindowHandle)
    $ok = Set-WindowForeground $target
    if (-not $ok) {
      $title = [string](Get-Prop $InputObject "windowTitle" "")
      throw "Failed to bring the target window ('$title') to the foreground (Windows foreground lock). Input was NOT sent. Try again, or pass a different window target."
    }
  }
}

# Same-process windows are not interchangeable (Explorer, browsers and UWP).
function Assert-InputProcess {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { throw 'INPUT_TARGET_UNAVAILABLE: the target process could not be identified.' }
  $hostProcess=0
  [void][int]::TryParse([string]$env:WCU_HOST_PID,[ref]$hostProcess)
  if ($ProcessId -eq $PID -or ($hostProcess -gt 0 -and $ProcessId -eq $hostProcess) -or
      ($script:TakeoverProcessId -gt 0 -and $ProcessId -eq $script:TakeoverProcessId)) {
    throw 'HOST_INPUT_DENIED: desktop input cannot target the DSH host or computer-use helper.'
  }
  $checkImage = [bool]$env:WCU_HOST_EXECUTABLE
  $target = [WindowsComputerUseNative]::ReadInputProcess([uint32]$ProcessId, $checkImage)
  if ($target.Gone) { throw 'INPUT_TARGET_UNAVAILABLE: the target process has exited. No input was sent.' }
  if ($checkImage -and $target.ImagePath -and
      [string]::Equals([IO.Path]::GetFullPath($target.ImagePath),[IO.Path]::GetFullPath($env:WCU_HOST_EXECUTABLE),[StringComparison]::OrdinalIgnoreCase)) {
    throw 'HOST_INPUT_DENIED: desktop input cannot target a DSH host executable window.'
  }
  $currentIntegrity = [WindowsComputerUseNative]::ReadCurrentIntegrity()
  if ($null -ne $target.Integrity -and $null -ne $currentIntegrity -and $target.Integrity -gt $currentIntegrity) {
    throw 'ELEVATED_TARGET_DENIED: the target window has a higher Windows integrity level than the input worker. No input was sent.'
  }
  if ($target.TokenAccessDenied) {
    throw 'INPUT_TARGET_ACCESS_UNCONFIRMED: Windows denied access to verify the target integrity level. It may be running as administrator. Open a non-elevated instance if possible. No input was sent.'
  }
  if ($null -eq $target.Integrity -or $null -eq $currentIntegrity -or ($checkImage -and -not $target.ImagePath)) {
    throw 'INPUT_TARGET_ACCESS_UNCONFIRMED: Windows did not allow the target identity or integrity level to be verified. No input was sent.'
  }
}

function Assert-NativeInputTarget {
  param([long]$Hwnd)
  if (-not $Hwnd -or -not [WindowsComputerUseNative]::IsWindow([IntPtr]$Hwnd)) {
    throw 'INPUT_TARGET_UNAVAILABLE: no live target window was resolved.'
  }
  Assert-InputProcess (Get-WindowProcessId $Hwnd)
}

function Test-InputWindow {
  param([long]$Candidate, [long]$Target, [hashtable]$State = $null)
  if (-not $Candidate -or -not $Target) { return $false }
  if ($Candidate -eq $Target) { return $true }
  $owner = $Candidate
  $seen = @{}
  for ($depth = 0; $depth -lt 40 -and $owner -and -not $seen.ContainsKey([string]$owner); $depth++) {
    $seen[[string]$owner] = $true
    $owner = [WindowsComputerUseNative]::GetWindow([IntPtr]$owner, 4).ToInt64()
    if ($owner -eq $Target) { return $true }
  }
  if ($null -ne $State -and $State.procId -and (Get-WindowProcessId $Candidate) -eq $State.procId -and $State.popups -notcontains $Candidate) {
    return (@([WindowsComputerUseNative]::VisiblePopups([uint32]$State.procId)) -contains $Candidate)
  }
  return $false
}

function Assert-InFront {
  param([hashtable]$State)
  if (-not $State.target) { return }
  $front = [WindowsComputerUseNative]::GetForegroundWindow().ToInt64()
  if (-not (Test-InputWindow $front $State.target $State)) {
    throw 'The target window is no longer in front (another window took the foreground), so no input was sent. Try again.'
  }
}

function Assert-ElementFocus {
  param([object]$Element)
  if (-not (Invoke-Safe { [bool]$Element.Current.HasKeyboardFocus } $false)) {
    throw 'ELEMENT_FOCUS_UNCONFIRMED: the requested element did not retain keyboard focus; no replacement text was sent.'
  }
}

# ============================================================================
# Less takeover. Each action uses the least intrusive way that works:
# 1. Background element actions: window messages (BM_CLICK, EM_REPLACESEL) or
#    UIA patterns, with no pointer, keyboard or clipboard. Some UIA providers
#    bring their window forward or move the pointer on their own (managed
#    Win32 proxies call SetForegroundWindow; a list view item's Invoke clicks
#    with the real pointer); both are given back at once.
# 2. Real input, only when nothing else works: the target comes forward for
#    the action, then the pointer goes back where the user left it and the
#    window the user had in front gets the foreground back. The target stays
#    in front while a menu, a drop-down or a dialog the action opened shows,
#    when the user switched windows meanwhile, and with activate:true.
# Input without a window target goes to the window DSH gave input to last in
# this operation series, never into the window the user got back.
# ============================================================================
$script:InputWindow = @{ series = $null; hwnd = [int64]0; at = 0 }
$script:WcuSeries = $null
$script:WcuQuiet = $false

function Get-WindowProcessId {
  param([long]$Hwnd)
  $procId = [uint32]0
  if ($Hwnd) { [void][WindowsComputerUseNative]::GetWindowThreadProcessId([IntPtr]$Hwnd, [ref]$procId) }
  return $procId
}

function Get-RootWindow {
  param([long]$Hwnd)
  if (-not $Hwnd) { return [int64]0 }
  return [WindowsComputerUseNative]::GetAncestor([IntPtr]$Hwnd, 2).ToInt64()
}

function Get-RootWindowAt {
  param([int]$X, [int]$Y)
  $point = New-Object WindowsComputerUseNative+POINT
  $point.x = $X; $point.y = $Y
  return (Get-RootWindow ([WindowsComputerUseNative]::WindowFromPoint($point).ToInt64()))
}

# The top-level window of a UIA element: most elements have no window handle
# of their own, so the nearest ancestor that has one decides.
function Get-ElementWindow {
  param([object]$Element)
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $node = $Element
  for ($depth = 0; $null -ne $node -and $depth -lt 40; $depth++) {
    $hwnd = Invoke-Safe { [int64]$node.Current.NativeWindowHandle } 0
    if ($hwnd) { return (Get-RootWindow $hwnd) }
    $node = Invoke-Safe { $walker.GetParent($node) } $null
  }
  return [int64]0
}

# The window DSH works in: the window it gave input to last in this series
# (within two minutes when no series is known), while that window is still
# open; else the window in front. After the foreground went back to the user,
# input and observations without a window target keep to DSH's window.
function Get-WorkWindow {
  $last = $script:InputWindow
  $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  $same = if ($null -ne $script:WcuSeries) { $last.series -eq $script:WcuSeries } else { $null -eq $last.series -and ($now - [int64]$last.at) -lt 120000 }
  if ($same -and $last.hwnd -and [WindowsComputerUseNative]::IsWindow([IntPtr]$last.hwnd) -and [WindowsComputerUseNative]::IsWindowVisible([IntPtr]$last.hwnd)) { return [int64]$last.hwnd }
  return [WindowsComputerUseNative]::GetForegroundWindow().ToInt64()
}

# A background element action (set_value, invoke, a pattern click, an element
# scroll) works in a window too: input without a window target goes there next,
# as after real input. set_value on a field, then keypress Enter, issue #82.
function Set-WorkWindow {
  param([long]$Hwnd)
  if ($Hwnd) { $script:InputWindow = @{ series = $script:WcuSeries; hwnd = [int64]$Hwnd; at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() } }
}

# The window that input for this call goes to: the requested target, else the
# window DSH works in. $script:InputWindowVia says which, so a result can tell
# when the keys went to whatever window happened to be in front.
function Resolve-InputWindow {
  param([object]$InputObject)
  if (Has-WindowTarget $InputObject) {
    $target = Get-ObservationWindow $InputObject
    if ($null -eq $target) { throw 'No native target window found.' }
    $hwnd=[int64]$target.nativeWindowHandle
    $script:InputWindowVia = 'window target'
  } else {
    $hwnd=Get-WorkWindow
    $script:InputWindowVia = if ($script:InputWindow.hwnd -and $hwnd -eq [int64]$script:InputWindow.hwnd) { 'last DSH window' } else { 'front window' }
  }
  Assert-NativeInputTarget $hwnd
  return $hwnd
}

# Before real input: note the window in front and the pointer, then bring the
# target (a top-level window, or 0 for whatever is in front) forward. With
# -NoActivate the input itself brings it forward (a click on an uncovered
# point, a UIA SetFocus); it is given back all the same.
function Start-Input {
  param([object]$InputObject, [long]$Hwnd, [switch]$NoActivate)
  Assert-NativeInputTarget $Hwnd
  # Low disruption: from here until Complete-Input the user's own keys and
  # mouse actions are held, then replayed to their window. A modifier or
  # button they already hold gets a second to come up.
  if ($script:WcuLowDisruption -and -not $script:WcuHolding -and -not (Get-Prop $InputObject 'activate' $false)) {
    $script:WcuHolding = [WcuInputHold]::Begin($Hwnd)
    if ($script:WcuHolding -and -not [WcuInputHold]::WaitForRelease(1000)) {
      [void](Stop-InputHold)
      throw 'WCU_USER_INPUT_HELD: The user is holding a key or mouse button, so nothing was sent. Try again in a moment, or use an element action, which needs neither.'
    }
  }
  try {
    $cursor = New-Object WindowsComputerUseNative+POINT
    [void][WindowsComputerUseNative]::GetCursorPos([ref]$cursor)
    $state = @{ user = [WindowsComputerUseNative]::GetForegroundWindow().ToInt64(); target = [int64]$Hwnd; keep = [bool](Get-Prop $InputObject 'activate' $false)
      cursor = $cursor; moved = $null; borrowed = $false; procId = (Get-WindowProcessId $Hwnd); popups = @() }
    if ($state.procId) { $state.popups = @([WindowsComputerUseNative]::VisiblePopups([uint32]$state.procId)) }
    if ($state.target -and $state.user -ne $state.target) {
      if (-not $NoActivate -and -not (Set-WindowForeground ([pscustomobject]@{ nativeWindowHandle = $state.target }))) {
        throw 'The target window could not be brought to the foreground (Windows foreground lock), so no input was sent. Try again, or call activate_window first.'
      }
      $state.borrowed = $true
    }
    return $state
  } catch {
    if ($script:WcuHolding) { [void](Stop-InputHold) }
    throw
  }
}

# The end of a hold: replays what the user did meanwhile (WcuInputHold::End).
# $Windows: what DSH worked in. Returns the note for the result, or $null.
function Stop-InputHold {
  param([long[]]$Windows = @())
  $script:WcuHolding = $false
  return [WcuInputHold]::End([long[]]$Windows)
}

# Real input lands on whatever shows at the point. With the target in front,
# the point must show the target or a window of its process (its menu, list or
# dialog); otherwise nothing is sent. WindowFromPoint skips the DSH indicator,
# which is layered and click-through.
function Assert-PointOnTarget {
  param([int]$X, [int]$Y, [long]$Target, [hashtable]$State = $null)
  if (-not $Target) { return }
  $hit = Get-RootWindowAt $X $Y
  if (Test-InputWindow $hit $Target $State) { return }
  $title = New-Object System.Text.StringBuilder 256
  [void][WindowsComputerUseNative]::GetWindowText([IntPtr]$hit, $title, 256)
  $class = New-Object System.Text.StringBuilder 128
  [void][WindowsComputerUseNative]::GetClassName([IntPtr]$hit, $class, 128)
  throw "POINT_COVERED: ($X,$Y) shows another window ('$($title.ToString())', class $($class.ToString()), HWND $hit) above the target, so no input was sent. Move or close that window, or pick a point of the target that is not covered."
}

# After real input, and under Low disruption also the end of the hold, whose
# note goes to the result as userInput.
function Complete-Input {
  param([hashtable]$State, [System.Collections.IDictionary]$Result)
  try { Complete-BorrowedInput $State $Result }
  finally {
    if ($script:WcuHolding) {
      # What DSH worked in: the target and the menus, lists and dialogs it opened.
      $windows = @()
      if ($State.target) { $windows += [int64]$State.target }
      if ($State.procId) { $windows += @([WindowsComputerUseNative]::VisiblePopups([uint32]$State.procId) | Where-Object { $State.popups -notcontains $_ }) }
      $note = Stop-InputHold $windows
      if ($note) { $Result['userInput'] = $note }
    }
  }
}

# Put the pointer back if it is still where DSH left it, and give the
# foreground back (see the section note). Adds pointer/foreground to the
# result, saying what was done.
function Complete-BorrowedInput {
  param([hashtable]$State, [System.Collections.IDictionary]$Result)
  $target = if ($State.target) { $State.target } else { [WindowsComputerUseNative]::GetForegroundWindow().ToInt64() }
  if ($target) { $script:InputWindow = @{ series = $script:WcuSeries; hwnd = [int64]$target; at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() } }
  if ($State.drain) {
    $front = [WindowsComputerUseNative]::GetForegroundWindow()
    if (Test-InputWindow $front.ToInt64() $State.target $State) {
      # WM_NULL can return ahead of pending SendInput events. Wait for a paint
      # on the receiving thread, bounded to avoid holding up a busy app.
      $paint = [WindowsComputerUseNative]::RequestPaint($front)
      $limit = if ($paint) { 1200 } else { 150 }
      $watch = [Diagnostics.Stopwatch]::StartNew()
      while ($watch.ElapsedMilliseconds -lt $limit -and [WindowsComputerUseNative]::GetForegroundWindow() -eq $front) {
        if ($paint -and -not [WindowsComputerUseNative]::PaintPending($front)) { break }
        Start-Sleep -Milliseconds 15
      }
      if (-not $paint -or [WindowsComputerUseNative]::PaintPending($front)) { $Result['inputQueue'] = 'unconfirmed' }
    }
  }
  if ($null -ne $State.moved) {
    $now = New-Object WindowsComputerUseNative+POINT
    [void][WindowsComputerUseNative]::GetCursorPos([ref]$now)
    if ($now.x -eq $State.moved.x -and $now.y -eq $State.moved.y) {
      [void][WindowsComputerUseNative]::SetCursorPos($State.cursor.x, $State.cursor.y)
      $Result['pointer'] = 'returned'
    } else { $Result['pointer'] = 'left where the user moved it' }
  }
  if (-not $State.borrowed) { return }
  if ($State.keep) { $Result['foreground'] = 'kept in front (activate:true)'; return }
  # Let the target handle the input before deciding.
  if (-not $State.drain) {
    $ignored = [UIntPtr]::Zero
    for ($i = 0; $i -lt 2; $i++) { [void][WindowsComputerUseNative]::SendMessageTimeout([IntPtr]$State.target, 0, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 1000, [ref]$ignored) }
  }
  $front = [WindowsComputerUseNative]::GetForegroundWindow().ToInt64()
  if (-not (Test-InputWindow $front $State.target $State)) { $Result['foreground'] = 'left: another window is in front now'; return }
  $opened = @([WindowsComputerUseNative]::VisiblePopups([uint32]$State.procId) | Where-Object { $State.popups -notcontains $_ })
  if ([WindowsComputerUseNative]::InMenuMode([IntPtr]$State.target) -or $opened.Count) { $Result['foreground'] = 'kept in front: a menu, list or dialog it opened is showing'; return }
  if (-not ([WindowsComputerUseNative]::IsWindow([IntPtr]$State.user) -and [WindowsComputerUseNative]::IsWindowVisible([IntPtr]$State.user))) { $Result['foreground'] = 'kept in front: the window that was in front is gone'; return }
  $Result['foreground'] = if ([WindowsComputerUseNative]::GiveForeground([IntPtr]$State.user)) { 'returned' } else { 'kept in front: Windows refused to switch back' }
}

