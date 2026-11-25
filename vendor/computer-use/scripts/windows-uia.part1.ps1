param(
  [Parameter(Mandatory = $false)]
  [string]$Action,
  [switch]$Persistent
)

$ErrorActionPreference = "Stop"
$loader = Join-Path $PSScriptRoot 'native-loader.ps1'
if ([IO.File]::Exists($loader)) { . $loader }
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$script:BackendStartupWatch = [System.Diagnostics.Stopwatch]::StartNew()
$script:BackendStage = 'start'
function Write-BackendStage {
  param([string]$Stage)
  $script:BackendStage = $Stage
  if ([string]$env:WCU_BACKEND_TRACE -eq '1') {
    [Console]::Error.WriteLine(('stage={0} elapsedMs={1}' -f $Stage, $script:BackendStartupWatch.ElapsedMilliseconds))
  }
}

# ============================================================================
# Win Computer Use — Windows desktop engine for the dsh-computer-use-win MCP server
#
# Modes:
#   -One-shot:  windows-uia.ps1 -Action <name>        (args: JSON on stdin)
#   -Persistent: windows-uia.ps1 -Persistent          (args: JSON lines on stdin,
#                one JSON line response per line on stdout; keeps the process
#                alive so repeated actions skip PowerShell startup, assembly
#                loading and C# compilation)
# ============================================================================

function Get-InputObject {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return [pscustomobject]@{}
  }
  return $raw | ConvertFrom-Json
}

function Get-Prop {
  param([object]$Object, [string]$Name, [object]$Default = $null)
  if ($null -eq $Object) { return $Default }
  if ($Object -is [System.Collections.IDictionary]) {
    if ($Object.Contains($Name) -and $null -ne $Object[$Name]) { return $Object[$Name] }
    return $Default
  }
  $prop = $Object.PSObject.Properties[$Name]
  if ($null -eq $prop) { return $Default }
  if ($null -eq $prop.Value) { return $Default }
  return $prop.Value
}

function Get-ViewMode {
  param([object]$InputObject, [string]$Default = "control")
  $mode = ("" + (Get-Prop $InputObject "viewMode" $Default)).Trim().ToLowerInvariant()
  switch ($mode) {
      "raw" { return "raw" }
      "control" { return "control" }
      "content" { return "content" }
      default { throw "viewMode must be one of: raw, control, content." }
  }
}

function Get-DetailLevel {
  param([object]$InputObject, [string]$Default = "compact")
  $level = ("" + (Get-Prop $InputObject "detailLevel" $Default)).Trim().ToLowerInvariant()
  switch ($level) {
      "compact" { return "compact" }
      "full" { return "full" }
      default { throw "detailLevel must be one of: compact, full." }
  }
}

function Get-ViewCondition {
  param([string]$ViewMode = "control", [bool]$IncludeOffscreen = $false, [switch]$SkipOffscreenFilter)
  $condition = switch ($ViewMode) {
      "raw" { [System.Windows.Automation.Automation]::RawViewCondition }
      "content" { [System.Windows.Automation.Automation]::ContentViewCondition }
      default { [System.Windows.Automation.Automation]::ControlViewCondition }
  }
  if ($null -eq $condition) {
    $condition = [System.Windows.Automation.Condition]::TrueCondition
  }
  if (-not $IncludeOffscreen -and -not $SkipOffscreenFilter) {
    $visible = New-Object System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::IsOffscreenProperty), $false
    $condition = New-Object System.Windows.Automation.AndCondition -ArgumentList $condition, $visible
  }
  return $condition
}

# ----------------------------------------------------------------------------
# Native P/Invoke surface. Compiled once to a cached DLL (keyed by a hash of
# this source) so restarted processes skip the ~hundreds-of-ms C# compile.
# ----------------------------------------------------------------------------
$script:WcuCs = @'
using System;
using System.Runtime.InteropServices;

public static class WindowsComputerUseNative {
  // Shared with the stop listener. Remote-control input without this marker
  // remains eligible for Esc / the configured stop shortcut.
  public static readonly uint InputMarker = ParseInputMarker();
  private static uint ParseInputMarker() {
    string raw = Environment.GetEnvironmentVariable("WCU_INPUT_MARKER");
    if (!String.IsNullOrEmpty(raw)) {
      string s = raw.Trim();
      uint parsed;
      if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) {
        if (uint.TryParse(s.Substring(2), System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out parsed) && parsed != 0u) return parsed;
      } else if (uint.TryParse(s, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out parsed) && parsed != 0u) return parsed;
    }
    return 0x44534857u;
  }
  [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);
  [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
  public static bool IsInputDesktopAvailable() {
    IntPtr d = OpenInputDesktop(0, false, 0x0100u);
    if (d == IntPtr.Zero) return false;
    CloseDesktop(d);
    return true;
  }

  private const uint ProcessQueryLimitedInformation = 0x1000, TokenQuery = 0x0008;
  private const uint StillActive = 259;
  private const int TokenIntegrityLevel = 25, ErrorInvalidParameter = 87, ErrorInsufficientBuffer = 122;
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, System.Text.StringBuilder path, ref uint length);
  [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, uint length, out uint required);

  public sealed class InputProcessIdentity {
    public bool Gone;
    public string ImagePath;
    public uint? Integrity;
    public bool TokenAccessDenied;
  }

  private static string GetImagePath(IntPtr process) {
    uint size = 512;
    var path = new System.Text.StringBuilder((int)size);
    if (QueryFullProcessImageNameW(process, 0, path, ref size)) return path.ToString();
    if (Marshal.GetLastWin32Error() != ErrorInsufficientBuffer) return null;
    size = 32768;
    path = new System.Text.StringBuilder((int)size);
    return QueryFullProcessImageNameW(process, 0, path, ref size) ? path.ToString() : null;
  }

  private static uint? GetProcessIntegrity(IntPtr process, out bool tokenAccessDenied) {
    tokenAccessDenied = false;
    IntPtr token;
    if (!OpenProcessToken(process, TokenQuery, out token)) {
      tokenAccessDenied = Marshal.GetLastWin32Error() == 5;
      return null;
    }
    try {
      uint size;
      GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out size);
      if (Marshal.GetLastWin32Error() != ErrorInsufficientBuffer || size < IntPtr.Size || size > 4096) return null;
      IntPtr data = Marshal.AllocHGlobal((int)size);
      try {
        if (!GetTokenInformation(token, TokenIntegrityLevel, data, size, out size)) return null;
        // TOKEN_MANDATORY_LABEL starts with the SID pointer in SID_AND_ATTRIBUTES.
        IntPtr sid = Marshal.ReadIntPtr(data);
        if (sid == IntPtr.Zero) return null;
        string label = new System.Security.Principal.SecurityIdentifier(sid).Value;
        const string integrityAuthority = "S-1-16-";
        uint rid;
        if (!label.StartsWith(integrityAuthority, StringComparison.Ordinal) ||
            !UInt32.TryParse(label.Substring(integrityAuthority.Length), out rid)) return null;
        return rid;
      } finally { Marshal.FreeHGlobal(data); }
    } finally { CloseHandle(token); }
  }

  public static uint? ReadCurrentIntegrity() {
    bool ignored;
    return GetProcessIntegrity(GetCurrentProcess(), out ignored);
  }

  public static InputProcessIdentity ReadInputProcess(uint pid, bool checkImage) {
    // Use a single query-only handle for the image, token and liveness of the
    // same process. No permission to write to or modify the target is requested.
    IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, pid);
    if (process == IntPtr.Zero)
      return new InputProcessIdentity { Gone = Marshal.GetLastWin32Error() == ErrorInvalidParameter };
    try {
      var identity = new InputProcessIdentity { ImagePath = checkImage ? GetImagePath(process) : null };
      identity.Integrity = GetProcessIntegrity(process, out identity.TokenAccessDenied);
      uint exitCode;
      if (!GetExitCodeProcess(process, out exitCode)) return new InputProcessIdentity();
      if (exitCode != StillActive) return new InputProcessIdentity { Gone = true };
      return identity;
    } finally { CloseHandle(process); }
  }

  private static INPUT KeyInput(int key, bool up) {
    var input = new INPUT(); input.type=1; input.U.ki.wVk=(ushort)key;
    input.U.ki.dwFlags=(up?2u:0u) | ((key>=0x21&&key<=0x2E)?1u:0u);
    input.U.ki.dwExtraInfo=new IntPtr((long)(ulong)InputMarker); return input;
  }
  public static INPUT[] KeyChordPacket(string[] keys, int heldModifiers) {
    int modifiers=0, main=0, mainCount=0;
    foreach(string raw in keys) {
      string key=(raw??"").Trim().ToLowerInvariant();
      if(key=="ctrl"||key=="control"){modifiers|=2;continue;}
      if(key=="alt"||key=="option"){modifiers|=4;continue;}
      if(key=="shift"){modifiers|=1;continue;}
      if(key=="win"||key=="windows"||key=="cmd"||key=="meta")throw new ArgumentException("The Windows key is blocked by design.");
      mainCount++;
      switch(key) {
        case "enter":case "return":main=0x0D;break;
        case "tab":main=9;break;
        case "esc":case "escape":main=0x1B;break;
        case "backspace":case "bs":case "bksp":main=8;break;
        case "delete":case "del":main=0x2E;break;
        case "home":main=0x24;break;case "end":main=0x23;break;
        case "pageup":case "pgup":main=0x21;break;case "pagedown":case "pgdn":main=0x22;break;
        case "up":main=0x26;break;case "down":main=0x28;break;case "left":main=0x25;break;case "right":main=0x27;break;
        case "space":main=0x20;break;case "insert":case "ins":main=0x2D;break;
        case "capslock":main=0x14;break;case "numlock":main=0x90;break;case "scrolllock":main=0x91;break;
        case "pause":case "break":main=0x13;break;case "printscreen":case "prtsc":main=0x2C;break;
        case "add":main=0x6B;break;case "subtract":main=0x6D;break;case "multiply":main=0x6A;break;case "divide":main=0x6F;break;
        default:
          int number;
          if(key.Length>1&&key[0]=='f'&&int.TryParse(key.Substring(1),out number)&&number>=1&&number<=24)main=0x6F+number;
          else if(key.Length==1){int mapped=VkKeyScanW(key[0]);if(mapped==-1)throw new ArgumentException("Key cannot be mapped in the active keyboard layout.");main=mapped&255;modifiers|=(mapped>>8)&7;}
          else throw new ArgumentException("Unsupported key: "+key);
          break;
      }
    }
    if(mainCount!=1)throw new ArgumentException("Exactly one non-modifier key is required.");
    if((heldModifiers&~modifiers)!=0)throw new InvalidOperationException("COMPUTER_USE_MODIFIERS_HELD: Release other modifiers before this chord; no input was sent.");
    var packet=new System.Collections.Generic.List<INPUT>();
    int[] bits={2,4,1}, codes={0x11,0x12,0x10};
    for(int i=0;i<bits.Length;i++)if((modifiers&bits[i])!=0&&(heldModifiers&bits[i])==0)packet.Add(KeyInput(codes[i],false));
    packet.Add(KeyInput(main,false));packet.Add(KeyInput(main,true));
    for(int i=bits.Length-1;i>=0;i--)if((modifiers&bits[i])!=0&&(heldModifiers&bits[i])==0)packet.Add(KeyInput(codes[i],true));
    return packet.ToArray();
  }
  public static bool SendKeyChord(string[] keys) {
    int held=0;
    if((GetAsyncKeyState(0x10)&0x8000)!=0)held|=1;
    if((GetAsyncKeyState(0x11)&0x8000)!=0)held|=2;
    if((GetAsyncKeyState(0x12)&0x8000)!=0)held|=4;
    if((GetAsyncKeyState(0x5B)&0x8000)!=0||(GetAsyncKeyState(0x5C)&0x8000)!=0)held|=8;
    INPUT[] packet=KeyChordPacket(keys,held);ThrowIfCancelled();
    uint sent=SendInput((uint)packet.Length,packet,Marshal.SizeOf(typeof(INPUT)));
    if(sent==(uint)packet.Length)return true;
    // Undo only our own still-held keys after a partial packet. Never release
    // modifiers the user was already holding, or replay the accepted prefix.
    var down=new System.Collections.Generic.List<int>();
    for(int i=0;i<(int)sent;i++){int vk=packet[i].U.ki.wVk;if((packet[i].U.ki.dwFlags&2)==0)down.Add(vk);else down.Remove(vk);}
    for(int i=down.Count-1;i>=0;i--)SendInput(1,new[]{KeyInput(down[i],true)},Marshal.SizeOf(typeof(INPUT)));
    return false;
  }
  private static System.Threading.EventWaitHandle cancellation;
  private static System.Diagnostics.Process stopListener;
  private static System.Threading.EventWaitHandle stopReady;
  public static void SetStopListener(int processId) {
    if (stopListener != null && stopListener.Id == processId) return;
    if (stopListener != null) stopListener.Dispose();
    stopListener = null;
    if (processId <= 0) return;
    try { stopListener = System.Diagnostics.Process.GetProcessById(processId); }
    catch (ArgumentException) { throw new OperationCanceledException("COMPUTER_USE_STOP_LISTENER_UNAVAILABLE"); }
  }
  public static void ThrowIfCancelled() {
    string name = Environment.GetEnvironmentVariable("WCU_CANCEL_EVENT");
    if (String.IsNullOrEmpty(name)) return;
    if (stopListener != null && stopListener.HasExited) throw new OperationCanceledException("COMPUTER_USE_STOP_LISTENER_UNAVAILABLE");
    if (cancellation == null) {
      try { cancellation = System.Threading.EventWaitHandle.OpenExisting(name); }
      catch (System.Threading.WaitHandleCannotBeOpenedException) { throw new OperationCanceledException("COMPUTER_USE_STOP_LISTENER_UNAVAILABLE"); }
    }
    if (cancellation.WaitOne(0)) throw new OperationCanceledException("COMPUTER_USE_STOPPED_BY_USER");
    string ready=Environment.GetEnvironmentVariable("WCU_READY_EVENT");
    if(!String.IsNullOrEmpty(ready)){
      if(stopReady==null)try{stopReady=System.Threading.EventWaitHandle.OpenExisting(ready);}catch(System.Threading.WaitHandleCannotBeOpenedException){throw new OperationCanceledException("COMPUTER_USE_STOP_LISTENER_UNAVAILABLE");}
      if(!stopReady.WaitOne(0))throw new OperationCanceledException("COMPUTER_USE_STOP_LISTENER_UNAVAILABLE");
    }
  }
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);

  public const int MOUSEEVENTF_MOVE = 0x0001;
  public const int MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const int MOUSEEVENTF_LEFTUP = 0x0004;
  public const int MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const int MOUSEEVENTF_RIGHTUP = 0x0010;
  public const int MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  public const int MOUSEEVENTF_MIDDLEUP = 0x0040;
  public const int MOUSEEVENTF_WHEEL = 0x0800;
  public const int MOUSEEVENTF_HWHEEL = 0x01000;

  // SM_XVIRTUALSCREEN / SM_YVIRTUALSCREEN / SM_CXVIRTUALSCREEN / SM_CYVIRTUALSCREEN
  [DllImport("user32.dll")]
  public static extern int GetSystemMetrics(int nIndex);

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public INPUTUNION U;
  }
  [DllImport("user32.dll")]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  // Send a button or wheel event at the CURRENT pointer position. Movement is
  // done with SetCursorPos (raw screen coords, matching the UIA/screenshot
  // space), not with MOUSEEVENTF_ABSOLUTE: on multi-monitor / high-DPI setups
  // the ABSOLUTE 0..65535 normalization against SM_CXVIRTUALSCREEN silently
  // mis-maps (observed: X exactly halved), so we never position via SendInput.
  public static uint SendMouseEvent(int x, int y, uint flags, int data) {
    MOUSEINPUT mi = new MOUSEINPUT();
    mi.dx = 0; mi.dy = 0; mi.mouseData = (uint)data;
    mi.dwFlags = flags; // button/wheel only; caller positioned via SetCursorPos
    mi.time = 0; mi.dwExtraInfo = new IntPtr((long)(ulong)InputMarker);
    INPUT[] inputs = new INPUT[1];
    inputs[0].type = 0; // INPUT_MOUSE
    inputs[0].U.mi = mi;
    return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
  }

  // Absolute coordinates require VIRTUALDESK and pixel-center normalization.
  // Omitting VIRTUALDESK maps a multi-monitor point to the primary display.
  public static INPUT[] ClickPacket(int x, int y, int left, int top,
      int width, int height, uint down, uint up) {
    if (width <= 0 || height <= 0 || width > 65536 || height > 65536 ||
        (long)x < left || (long)x >= (long)left + width ||
        (long)y < top || (long)y >= (long)top + height)
      throw new ArgumentOutOfRangeException("point", "Point or virtual screen cannot be mapped exactly.");
    INPUT[] packet = new INPUT[3];
    packet[0].type = packet[1].type = packet[2].type = 0;
    packet[0].U.mi.dx = (int)(((2L * ((long)x - left) + 1) * 65536) / (2L * width));
    packet[0].U.mi.dy = (int)(((2L * ((long)y - top) + 1) * 65536) / (2L * height));
    packet[0].U.mi.dwFlags = 0x0001 | 0x8000 | 0x4000;
    packet[1].U.mi.dwFlags = down;
    packet[2].U.mi.dwFlags = up;
    for(int i=0;i<packet.Length;i++)packet[i].U.mi.dwExtraInfo=new IntPtr((long)(ulong)InputMarker);
    return packet;
  }

  public static uint SendClick(int x, int y, uint down, uint up) {
    INPUT[] packet = ClickPacket(x, y, GetSystemMetrics(76), GetSystemMetrics(77),
      GetSystemMetrics(78), GetSystemMetrics(79), down, up);
    ThrowIfCancelled();
    uint sent = SendInput(3, packet, Marshal.SizeOf(typeof(INPUT)));
    // A partial batch can leave the button down. Release it before reporting
    // failure; never replay the click, which might already have taken effect.
    if (sent == 2) SendMouseEvent(0, 0, up, 0);
    return sent;
  }

  public const uint KEYEVENTF_UNICODE = 0x0004;

  // Synthesize the text as Unicode key events (KEYEVENTF_UNICODE). No clipboard
  // is touched, so this also works on password fields and other controls that
  // reject paste. The target control must be foreground + focused. Returns
  // false if any input event was dropped or the target lost focus.
  public static bool SendUnicodeText(string text, IntPtr front, IntPtr focus) {
    if (string.IsNullOrEmpty(text)) return true;
    var chars = text.ToCharArray();
    var inputs = new INPUT[chars.Length * 2];
    int n = 0;
    foreach (char ch in chars) {
      // press
      inputs[n].type = 1; // INPUT_KEYBOARD
      inputs[n].U.ki.wVk = 0;
      inputs[n].U.ki.wScan = ch;
      inputs[n].U.ki.dwFlags = KEYEVENTF_UNICODE;
      inputs[n].U.ki.time = 0;
      inputs[n].U.ki.dwExtraInfo = new IntPtr((long)(ulong)InputMarker);
      n++;
      // release
      inputs[n].type = 1;
      inputs[n].U.ki.wVk = 0;
      inputs[n].U.ki.wScan = ch;
      inputs[n].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      inputs[n].U.ki.time = 0;
      inputs[n].U.ki.dwExtraInfo = new IntPtr((long)(ulong)InputMarker);
      n++;
    }
    int sent = 0;
    int size = Marshal.SizeOf(typeof(INPUT));
    while (sent < n) {
      ThrowIfCancelled();
      if (GetForegroundWindow() != front || FocusedWindow(front) != focus) return false;
      int chunk = Math.Min(64, n - sent);
      if (sent + chunk < n && Char.IsHighSurrogate(chars[(sent + chunk) / 2 - 1]) &&
          Char.IsLowSurrogate(chars[(sent + chunk) / 2])) chunk -= 2;
      var slice = new INPUT[chunk];
      Array.Copy(inputs, sent, slice, 0, chunk);
      uint ok = SendInput((uint)chunk, slice, size);
      if (ok != (uint)chunk) return false;
      sent += chunk;
    }
    return true;
  }

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll")]
  public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);


  public delegate bool EnumWindowsCallback(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr data);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder text, int count);
  public static IntPtr[] TopLevelWindows() {
    var result = new System.Collections.Generic.List<IntPtr>();
    EnumWindows(delegate(IntPtr hwnd, IntPtr data) { result.Add(hwnd); return true; }, IntPtr.Zero);
    return result.ToArray();
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct LaunchStartup {
    public int Size;
    public string Reserved, Desktop, Title;
    public uint X,Y,Width,Height,Columns,Rows,Fill,Flags;
    public ushort Show,ReservedSize;
    public IntPtr ReservedData,Input,Output,Error;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct LaunchProcess {
    public IntPtr Process,Thread;
    public uint ProcessId,ThreadId;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcess(string application, System.Text.StringBuilder command,
    IntPtr processAttrs, IntPtr threadAttrs, bool inheritHandles, uint flags,
    IntPtr environment, string directory, ref LaunchStartup startup, out LaunchProcess process);
  public static uint StartBackgroundProgram(string executable, string arguments, string directory) {
    var startup = new LaunchStartup { Size=Marshal.SizeOf(typeof(LaunchStartup)) };
    var command = new System.Text.StringBuilder("\"" + executable + "\" " + arguments);
    LaunchProcess process;
    // Inherit the desktop and environment, but never the MCP stdio handles.
    if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false,
        0x08000000, IntPtr.Zero, directory, ref startup, out process))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    CloseHandle(process.Thread);
    CloseHandle(process.Process);
    return process.ProcessId;
  }

  // Chromium hosts (Electron, Chrome/Edge, CEF, WebView2) draw each page in a
  // Chrome_RenderWidgetHostHWND child window, possibly owned by another process.
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsCallback callback, IntPtr data);
  public static IntPtr[] ChromiumRenderers(IntPtr window, int max) {
    var result = new System.Collections.Generic.List<IntPtr>();
    var name = new System.Text.StringBuilder(64);
    EnumChildWindows(window, delegate(IntPtr hwnd, IntPtr data) {
      name.Length = 0;
      GetClassName(hwnd, name, name.Capacity);
      if (name.ToString() == "Chrome_RenderWidgetHostHWND" && IsWindowVisible(hwnd)) result.Add(hwnd);
      return result.Count < max;
    }, IntPtr.Zero);
    return result.ToArray();
  }

  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, UIntPtr wParam,
    IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
  public static bool IsResponsive(IntPtr hwnd) {
    UIntPtr result;
    // WM_NULL, SMTO_BLOCK | SMTO_ABORTIFHUNG. Never enter the UIA provider here.
    return IsWindow(hwnd) && SendMessageTimeout(hwnd, 0, UIntPtr.Zero,
      IntPtr.Zero, 3, 200, out result) != IntPtr.Zero;
  }

  public const byte VK_MENU = 0x12;
  public const uint KEYEVENTF_KEYUP = 0x0002;

  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();

  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int left; public int top; public int right; public int bottom; }

  // DWMWA_EXTENDED_FRAME_BOUNDS = 9: the real window rect without the invisible
  // drop-shadow margin DWM adds to GetWindowRect.
  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);

  // PW_RENDERFULLCONTENT = 2: asks DirectComposition-backed windows to render.
  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint nFlags);

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int x; public int y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out POINT p);

  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_NOACTIVATE = 0x0010;

  // ---- background (message-queue) input path ----
  // PostMessage delivers to the target window's message queue WITHOUT touching
  // the system input queue: the user's foreground stays untouched. Classic
  // Win32/Edit controls honor these; Chromium/Electron/UWP content often drops
  // them (that is the documented 'background_unavailable' case).
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern bool PostMessageW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);

  [DllImport("user32.dll")]
  public static extern short VkKeyScanW(char ch);

  // WM_* message ids
  public const uint WM_MOUSEMOVE = 0x0200;
  public const uint WM_LBUTTONDOWN = 0x0201;
  public const uint WM_LBUTTONUP = 0x0202;
  public const uint WM_LBUTTONDBLCLK = 0x0203;
  public const uint WM_RBUTTONDOWN = 0x0204;
  public const uint WM_RBUTTONUP = 0x0205;
  public const uint WM_MBUTTONDOWN = 0x0207;
  public const uint WM_MBUTTONUP = 0x0208;
  public const uint WM_CHAR = 0x0102;
  public const uint WM_KEYDOWN = 0x0100;
  public const uint WM_KEYUP = 0x0101;
  public const uint WM_CLOSE = 0x0010;
  // MK_* mouse key state words (wParam for mouse messages)
  public const int MK_LBUTTON = 0x0001;
  public const int MK_RBUTTON = 0x0002;
  public const int MK_MBUTTON = 0x0010;

  // Pack client-area x/y into the LPARAM for mouse messages.
  public static IntPtr MakeLParam(int x, int y) {
    return new IntPtr((y & 0xFFFF) << 16 | (x & 0xFFFF));
  }

  // ---- less takeover: give the foreground and the pointer back ----
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [StructLayout(LayoutKind.Sequential)]
  public struct GUITHREADINFO { public int cbSize; public uint flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern IntPtr ReadMessageText(IntPtr hwnd, uint msg, UIntPtr wParam, System.Text.StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", ExactSpelling = true)]
  private static extern IntPtr ReadMessageSelection(IntPtr hwnd, uint msg, out uint start, out uint end, uint flags, uint timeout, out UIntPtr result);
  public const uint BM_CLICK = 0x00F5, EM_SETSEL = 0x00B1, EM_REPLACESEL = 0x00C2;
  public const uint WM_GETTEXTLENGTH = 0x000E, WM_HSCROLL = 0x0114, WM_VSCROLL = 0x0115;

  public static string ReadEditText(IntPtr hwnd, int capacity) {
    var text = new System.Text.StringBuilder(capacity);
    UIntPtr length;
    // WM_GETTEXT, with one extra slot to detect a truncated read.
    if (ReadMessageText(hwnd, 0x000D, new UIntPtr((uint)capacity), text, 3, 100, out length) == IntPtr.Zero ||
        length.ToUInt64() >= (ulong)(capacity - 1)) return null;
    return text.ToString();
  }

  public static int[] ReadEditSelection(IntPtr hwnd) {
    uint start, end;
    UIntPtr ignored;
    // EM_GETSEL writes both UTF-16 offsets. Some superclassed edits do not
    // populate both offsets in the packed return value.
    if (ReadMessageSelection(hwnd, 0x00B0, out start, out end, 3, 100, out ignored) == IntPtr.Zero ||
        start > Int32.MaxValue || end > Int32.MaxValue) return null;
    return new int[] { (int)start, (int)end };
  }

  [DllImport("user32.dll")] private static extern bool InvalidateRect(IntPtr hwnd, IntPtr rect, bool erase);
  [DllImport("user32.dll")] private static extern bool GetUpdateRect(IntPtr hwnd, IntPtr rect, bool erase);
  [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hwnd, out RECT rect);

  // A thread gets WM_PAINT only when no posted message or input is waiting
  // for it. Request a repaint after queueing input: once the window's update
  // region is empty again, its thread has taken all of that input. A message
  // sent to the window cannot tell, since it is handled before queued input.
  public static bool RequestPaint(IntPtr hwnd) {
    RECT client;
    return hwnd != IntPtr.Zero && IsWindowVisible(hwnd) && GetClientRect(hwnd, out client) &&
      client.right > client.left && client.bottom > client.top && InvalidateRect(hwnd, IntPtr.Zero, false);
  }

  public static bool PaintPending(IntPtr hwnd) {
    return hwnd != IntPtr.Zero && GetUpdateRect(hwnd, IntPtr.Zero, false);
  }

  // The window with the keyboard focus in hwnd's thread. Each thread keeps its
  // own focus, also while its windows are in the background (zero when none).
  public static IntPtr FocusedWindow(IntPtr hwnd) {
    uint pid; uint thread = GetWindowThreadProcessId(hwnd, out pid);
    if (thread == 0) return IntPtr.Zero;
    var info = new GUITHREADINFO(); info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    return GetGUIThreadInfo(thread, ref info) ? info.hwndFocus : IntPtr.Zero;
  }

  // A menu, a system menu or a popup menu is open in the window's thread
  // (GUI_INMENUMODE | GUI_SYSTEMMENUMODE | GUI_POPUPMENUMODE).
  public static bool InMenuMode(IntPtr hwnd) {
    uint pid; uint thread = GetWindowThreadProcessId(hwnd, out pid);
    if (thread == 0) return false;
    var info = new GUITHREADINFO(); info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    return GetGUIThreadInfo(thread, ref info) && (info.flags & 0x1C) != 0;
  }

  // Hand the foreground to a window without pressing a key: this thread joins
  // the input of the thread in front, which may then pass the foreground on.
  public static bool GiveForeground(IntPtr hwnd) {
    IntPtr front = GetForegroundWindow();
    if (front == hwnd) return true;
    uint pid; uint frontThread = front == IntPtr.Zero ? 0 : GetWindowThreadProcessId(front, out pid);
    uint own = GetCurrentThreadId();
    bool attached = frontThread != 0 && frontThread != own && AttachThreadInput(own, frontThread, true);
    try { BringWindowToTop(hwnd); SetForegroundWindow(hwnd); }
    finally { if (attached) AttachThreadInput(own, frontThread, false); }
    return GetForegroundWindow() == hwnd;
  }

  // Visible top-level popup windows (WS_POPUP) of a process: a drop-down list,
  // a menu, a dialog. One that appears during an action was opened by it.
  public static long[] VisiblePopups(uint processId) {
    var result = new System.Collections.Generic.List<long>();
    EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pid == processId && IsWindowVisible(hwnd) && (GetWindowLong(hwnd, -16) & unchecked((int)0x80000000)) != 0) result.Add(hwnd.ToInt64());
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
}

// Low disruption (the default work mode) borrows the pointer and keyboard for
// a step without waiting for the user to stop. Meanwhile the user's own keys
// and mouse actions are held here and replayed to the user's window once the
// foreground and pointer are back, so nothing they type is lost or lands in
// DSH's window. Afterwards, while a window DSH worked in stays in front (a
// menu, list or dialog it opened, an app it started), the user's next key
// first gives the foreground back to their window and is replayed there; a
// click of theirs ends that. Esc always passes on to the stop listener. When
// Windows does not install the hooks, or drops one that answered too slowly,
// only this protection is lost.
public static class WcuInputHold {
  public const int Idle = 0, Holding = 1, Guarding = 2, Returning = 3;
  public static readonly uint ReplayMarker = unchecked(WindowsComputerUseNative.InputMarker + 1u);
  public struct Held { public bool Key, Up; public int Vk, Scan, Flags, X, Y, MouseData; public uint MouseFlags; }

  // The decisions, without Windows calls, so tests can drive them.
  public sealed class Core {
    public int State;
    public readonly System.Collections.Generic.List<Held> Queue = new System.Collections.Generic.List<Held>();
    public readonly System.Collections.Generic.HashSet<int> PreHeld = new System.Collections.Generic.HashSet<int>();
    public readonly System.Collections.Generic.HashSet<int> Keys = new System.Collections.Generic.HashSet<int>();
    public readonly System.Collections.Generic.HashSet<int> Buttons = new System.Collections.Generic.HashSet<int>();
    // Keys whose replayed press Windows has taken and whose replayed release
    // it has not: they read as down without being held by the user.
    public readonly System.Collections.Generic.HashSet<int> Replaying = new System.Collections.Generic.HashSet<int>();
    public int X, Y, KeyCount, MouseCount;
    public bool Moved;
    public void Reset(int x, int y) { Queue.Clear(); PreHeld.Clear(); Keys.Clear(); Buttons.Clear(); Replaying.Clear(); X = x; Y = y; Moved = false; KeyCount = 0; MouseCount = 0; }
    static bool Ours(bool injected, bool lowerIntegrity, ulong extra) {
      return injected && ((!lowerIntegrity && extra == (ulong)WindowsComputerUseNative.InputMarker) || extra == (ulong)ReplayMarker);
    }
    // A key (LLKHF flags: 0x01 extended, 0x02 injected at a lower integrity,
    // 0x10 injected). down: Windows reads the key as down already. In
    // Guarding, dshInFront: a window DSH worked in is in front and the user's
    // window is there to go back to. True: swallow the key.
    public bool Key(int vk, int scan, int flags, ulong extra, bool up, bool down, bool dshInFront, bool overdue) {
      bool injected = (flags & 0x10) != 0;
      if (injected && extra == (ulong)ReplayMarker) { if (up) Replaying.Remove(vk); else Replaying.Add(vk); return false; }
      if (Ours(injected, (flags & 0x02) != 0, extra)) return false;
      // Auto-repeat of a key the user pressed before the hold. A key whose
      // replay is under way also reads as down, and a typed character
      // (VK_PACKET, all characters on one code) never repeats.
      bool repeat = down && vk != 0xE7 && !Replaying.Contains(vk);
      if (State == Holding) {
        if (overdue || vk == 0x1B) return false;
        if (up) {
          if (Keys.Remove(vk)) { Add(vk, scan, flags, true); return true; }
          PreHeld.Remove(vk); return false;
        }
        // A key pressed before the hold: its repeats are dropped, its release passes.
        if (PreHeld.Contains(vk) || (repeat && !Keys.Contains(vk))) { PreHeld.Add(vk); return true; }
        Keys.Add(vk); KeyCount++; Add(vk, scan, flags, false); return true;
      }
      if (State == Guarding) {
        if (up || vk == 0x1B || !dshInFront) return false;
        State = Returning; Keys.Clear(); Keys.Add(vk); KeyCount = 1; Add(vk, scan, flags, false); return true;
      }
      if (State == Returning) {
        if (vk == 0x1B) return false;
        if (up) { if (Keys.Remove(vk)) { Add(vk, scan, flags, true); return true; } return false; }
        Keys.Add(vk); KeyCount++; Add(vk, scan, flags, false); return true;
      }
      return false;
    }
    // A mouse event (LLMHF flags: 0x01 injected, 0x02 injected at a lower
    // integrity). (x, y): where Windows would put the pointer; (cursorX,
    // cursorY): where it is. True: swallow the event.
    public bool Mouse(int message, int x, int y, int cursorX, int cursorY, int mouseData, int flags, ulong extra, bool overdue) {
      bool injected = (flags & 0x01) != 0;
      if (Ours(injected, (flags & 0x02) != 0, extra)) return false;
      int button = Button(message, mouseData);
      // A click of the user's own picks the window: the guard ends.
      if (State == Guarding) { if (button != 0 && Down(message)) State = Idle; return false; }
      if (State != Holding || overdue) return false;
      if (message == 0x200) {
        // A mouse moves the pointer by a distance; remote control, pens and touch place it.
        if (injected || (extra & 0xFFFFFF00UL) == 0xFF515700UL) { X = x; Y = y; } else { X += x - cursorX; Y += y - cursorY; }
        Moved = true; return true;
      }
      if (message == 0x20A || message == 0x20E) { MouseCount++; AddMouse(message, mouseData); return true; }
      if (button == 0) return false;
      if (Down(message)) { Buttons.Add(button); MouseCount++; AddMouse(message, mouseData); return true; }
      if (Buttons.Remove(button)) { AddMouse(message, mouseData); return true; }
      return false;
    }
    static bool Down(int message) { return message == 0x201 || message == 0x204 || message == 0x207 || message == 0x20B; }
    static int Button(int message, int mouseData) {
      switch (message) {
        case 0x201: case 0x202: return 1;
        case 0x204: case 0x205: return 2;
        case 0x207: case 0x208: return 3;
        case 0x20B: case 0x20C: return ((mouseData >> 16) & 0xFFFF) == 1 ? 4 : 5;
        default: return 0;
      }
    }
    void Add(int vk, int scan, int flags, bool up) { var held = new Held(); held.Key = true; held.Vk = vk; held.Scan = scan; held.Flags = flags; held.Up = up; Queue.Add(held); }
    void AddMouse(int message, int mouseData) {
      var held = new Held(); held.X = X; held.Y = Y;
      int high = (short)((mouseData >> 16) & 0xFFFF);
      switch (message) {
        case 0x201: held.MouseFlags = 0x0002; break;
        case 0x202: held.MouseFlags = 0x0004; break;
        case 0x204: held.MouseFlags = 0x0008; break;
        case 0x205: held.MouseFlags = 0x0010; break;
        case 0x207: held.MouseFlags = 0x0020; break;
        case 0x208: held.MouseFlags = 0x0040; break;
        case 0x20B: held.MouseFlags = 0x0080; held.MouseData = high & 0xFFFF; break;
        case 0x20C: held.MouseFlags = 0x0100; held.MouseData = high & 0xFFFF; break;
        case 0x20A: held.MouseFlags = 0x0800; held.MouseData = high; break;
        case 0x20E: held.MouseFlags = 0x1000; held.MouseData = high; break;
      }
      Queue.Add(held);
    }
  }

  // What Windows gets on replay, tagged so that neither hook holds it again.
  public static WindowsComputerUseNative.INPUT ToInput(Held held) {
    var input = new WindowsComputerUseNative.INPUT();
    if (held.Key) {
      // VK_PACKET: a character another program typed (KEYEVENTF_UNICODE).
      bool packet = held.Vk == 0xE7;
      input.type = 1;
      input.U.ki.wVk = (ushort)(packet ? 0 : held.Vk);
      input.U.ki.wScan = (ushort)held.Scan;
      input.U.ki.dwFlags = ((held.Flags & 0x01) != 0 && !packet ? 1u : 0u) | (held.Up ? 2u : 0u) | (packet ? 4u : 0u);
      input.U.ki.dwExtraInfo = new IntPtr((long)(ulong)ReplayMarker);
    } else {
      input.type = 0;
      input.U.mi.mouseData = unchecked((uint)held.MouseData);
      input.U.mi.dwFlags = held.MouseFlags;
      input.U.mi.dwExtraInfo = new IntPtr((long)(ulong)ReplayMarker);
    }
    return input;
  }

  public static readonly Core Decisions = new Core();
  static readonly object gate = new object();
  static IntPtr user, pendingUser;
  static System.Collections.Generic.HashSet<long> dshWindows = new System.Collections.Generic.HashSet<long>();
  static System.Collections.Generic.HashSet<long> before = new System.Collections.Generic.HashSet<long>(), pendingBefore;
  static System.Collections.Generic.HashSet<uint> dshProcesses = new System.Collections.Generic.HashSet<uint>();
  static DateTime since, guardUntil;
  static string notice;
  public const string GuardNote = "This window stays in front for now; if the user types before your next step, the foreground goes back to their window first.";

  public sealed class UserInput { public bool Held, Fullscreen; public int Notification; public long Foreground; }
  static readonly int[] Watched = { 0x01, 0x02, 0x04, 0x05, 0x06, 0x10, 0x11, 0x12, 0x5B, 0x5C };
  static bool AnyHeld() { foreach (int key in Watched) if ((GetAsyncKeyState(key) & 0x8000) != 0) return true; return false; }
  // Whether borrowing now would break what the user is doing: a modifier or a
  // mouse button down, or a full-screen app or presentation in front
  // (SHQueryUserNotificationState: 2 busy, 3 Direct3D full screen, 4 presentation mode).
  public static UserInput UserState() {
    var state = new UserInput();
    state.Held = AnyHeld();
    int value;
    if (SHQueryUserNotificationState(out value) == 0) { state.Notification = value; state.Fullscreen = value == 2 || value == 3 || value == 4; }
    state.Foreground = WindowsComputerUseNative.GetForegroundWindow().ToInt64();
    return state;
  }

  // Before DSH's input on the user's desktop: hold the user's input from now
  // on. target: the window DSH works in (0: the one in front). False when the
  // hooks are not there; the step then runs without this protection.
  public static bool Begin(long target) {
    var windows = TopLevelSet();
    uint pid = 0;
    if (target != 0) WindowsComputerUseNative.GetWindowThreadProcessId(new IntPtr(target), out pid);
    for (int waited = 0; ; waited += 10) {
      lock (gate) {
        if (Decisions.State != Returning || waited >= 1000) {
          WindowsComputerUseNative.POINT cursor;
          WindowsComputerUseNative.GetCursorPos(out cursor);
          // Coming from a guard, the user's window is still the one from before.
          if (Decisions.State != Guarding) {
            user = WindowsComputerUseNative.GetForegroundWindow(); before = windows;
            dshWindows = new System.Collections.Generic.HashSet<long>(); dshProcesses = new System.Collections.Generic.HashSet<uint>();
          }
          Decisions.Reset(cursor.x, cursor.y);
          if (target != 0) dshWindows.Add(target);
          if (pid != 0) dshProcesses.Add(pid);
          since = DateTime.UtcNow;
          Decisions.State = Holding;
          break;
        }
      }
      System.Threading.Thread.Sleep(10);
    }
    // A fresh pair: Windows may have dropped an older hook without a word.
    Request(UninstallMessage, true);
    if (!Request(InstallMessage, false)) {
      lock (gate) Decisions.State = Idle;
      Request(UninstallMessage, true);
      return false;
    }
    for (int key = 0x08; key <= 0xFE; key++) if (key != 0xE7 && (GetAsyncKeyState(key) & 0x8000) != 0) lock (gate) Decisions.PreHeld.Add(key);
    return true;
  }

  // During the hold, a modifier or button the user pressed before it may still
  // be down; its release passes. True once none is down.
  public static bool WaitForRelease(int milliseconds) {
    DateTime start = DateTime.UtcNow;
    while (AnyHeld()) {
      if ((DateTime.UtcNow - start).TotalMilliseconds >= milliseconds) return false;
      System.Threading.Thread.Sleep(10);
    }
    return true;
  }

  // After DSH's input, with the foreground and pointer given back: replay what
  // the user did meanwhile. windows: what DSH worked in (the target and the
  // menus, lists and dialogs it opened). A note for the result, or null.
  public static string End(long[] windows) {
    IntPtr target; bool hasKeys = false; int keys, mouse;
    lock (gate) {
      if (Decisions.State != Holding) return null;
      if (windows != null) foreach (long window in windows) if (window != 0) dshWindows.Add(window);
      if (Decisions.Keys.Count > 0) hasKeys = true;
      foreach (Held held in Decisions.Queue) if (held.Key) hasKeys = true;
      keys = Decisions.KeyCount; mouse = Decisions.MouseCount; target = user;
    }
    IntPtr front = WindowsComputerUseNative.GetForegroundWindow();
    bool there = Present(target), returned = false, deliver = true, elevated = false, guard;
    if (hasKeys && front != target) { returned = there && GiveBack(target); deliver = returned; }
    // Windows lets no program type into a window that runs at a higher
    // integrity level (an app run as administrator while DSH is not).
    if (hasKeys && deliver && there) {
      uint pid; WindowsComputerUseNative.GetWindowThreadProcessId(target, out pid);
      var identity = pid == 0 ? null : WindowsComputerUseNative.ReadInputProcess(pid, false);
      uint? own = WindowsComputerUseNative.ReadCurrentIntegrity();
      if (identity != null && identity.Integrity.HasValue && own.HasValue && identity.Integrity.Value > own.Value) { deliver = false; elevated = true; }
    }
    lock (gate) guard = !hasKeys && there && front != target && IsDsh(front);
    int dropped = Drain(deliver, Holding, guard ? Guarding : Idle);
    int x, y; bool moved;
    lock (gate) { moved = Decisions.Moved; x = Decisions.X; y = Decisions.Y; guardUntil = DateTime.UtcNow.AddMinutes(10); }
    if (moved) Place(x, y);
    if (!guard) Request(UninstallMessage, false);
    var parts = new System.Collections.Generic.List<string>();
    if (elevated) parts.Add("The user typed during this step in a window that runs as administrator; Windows lets DSH replay no keys there, so they were dropped.");
    else if (returned) parts.Add("The user was typing, so the foreground went back to their window and their keys went there; a menu or list this step opened may have closed.");
    else if (dropped > 0) parts.Add("The user typed during this step, but Windows kept this window in front, so their keys were dropped rather than sent here.");
    else if (keys + mouse > 0) parts.Add("The user's own input during this step was held and then replayed to their window.");
    if (guard) parts.Add(GuardNote);
    return parts.Count == 0 ? null : String.Join(" ", parts.ToArray());
  }

  // Before an action that may bring a window forward without real input (an
  // app DSH starts, activate_window, an element action whose app comes forward).
  public static void Snapshot() {
    var windows = TopLevelSet();
    IntPtr front = WindowsComputerUseNative.GetForegroundWindow();
    lock (gate) {
      if (Decisions.State == Guarding) { pendingUser = user; pendingBefore = before; }
      else if (Decisions.State == Idle) { pendingUser = front; pendingBefore = windows; }
    }
  }
  // After it: until the user clicks, DSH's next input step or ten minutes, a
  // key the user types while one of these windows, or a new window of these
  // processes, is in front goes to the user's own window instead.
  public static bool ArmGuard(long[] windows, long[] processes) {
    lock (gate) {
      if (pendingUser == IntPtr.Zero || (Decisions.State != Idle && Decisions.State != Guarding)) return false;
      if (Decisions.State == Idle) { dshWindows = new System.Collections.Generic.HashSet<long>(); dshProcesses = new System.Collections.Generic.HashSet<uint>(); }
      user = pendingUser; before = pendingBefore ?? new System.Collections.Generic.HashSet<long>(); pendingUser = IntPtr.Zero;
      if (windows != null) foreach (long window in windows) if (window != 0) dshWindows.Add(window);
      if (processes != null) foreach (long process in processes) if (process > 0) dshProcesses.Add((uint)process);
      Decisions.Reset(0, 0); Decisions.State = Guarding; guardUntil = DateTime.UtcNow.AddMinutes(10);
    }
    if (Request(InstallMessage, false)) return true;
    lock (gate) if (Decisions.State == Guarding) Decisions.State = Idle;
    return false;
  }

