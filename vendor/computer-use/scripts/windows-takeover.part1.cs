// Original Windows UI for DSH. Uses only framework APIs; no input is synthesized.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Threading;
using System.IO.MemoryMappedFiles;
using System.Security.Principal;
#if WCU_CORE
using System.Text.Json;
#else
using System.Web.Script.Serialization;
#endif
using System.Windows.Forms;

namespace DshTakeover {
  // PowerShell 7 uses modern .NET, where System.Web's serializer is unavailable.
  // Keep the command dictionary's primitive/array shapes identical on both runtimes.
  internal sealed class CommandJson {
#if WCU_CORE
    public string Serialize(object value) { return JsonSerializer.Serialize(value); }
    public T Deserialize<T>(string text) {
      using (var document = JsonDocument.Parse(text)) return (T)ConvertValue(document.RootElement);
    }
    static object ConvertValue(JsonElement value) {
      switch (value.ValueKind) {
        case JsonValueKind.Object:
          var map = new Dictionary<string,object>();
          foreach (var entry in value.EnumerateObject()) map.Add(entry.Name, ConvertValue(entry.Value));
          return map;
        case JsonValueKind.Array:
          var items = new List<object>();
          foreach (var entry in value.EnumerateArray()) items.Add(ConvertValue(entry));
          return items.ToArray();
        case JsonValueKind.String: return value.GetString();
        case JsonValueKind.Number:
          long integer;
          if (value.TryGetInt64(out integer)) return integer;
          return value.GetDouble();
        case JsonValueKind.True: return true;
        case JsonValueKind.False: return false;
        default: return null;
      }
    }
#else
    readonly JavaScriptSerializer inner = new JavaScriptSerializer();
    public string Serialize(object value) { return inner.Serialize(value); }
    public T Deserialize<T>(string text) { return inner.Deserialize<T>(text); }
#endif
  }
  // The words drawn here arrive with each command, in the DSH interface
  // language (mcp/overlay-strings.mjs, #74). A missing key shows as itself.
  internal static class Words {
    static Dictionary<string,object> current = new Dictionary<string,object>();
    internal static void Use(object strings) { var table = strings as Dictionary<string,object>; if (table != null) current = table; }
    internal static string Get(string key) { object value; return current.TryGetValue(key, out value) && value is string ? (string)value : key; }
    internal static string Format(string key, params object[] values) {
      try { return String.Format(System.Globalization.CultureInfo.InvariantCulture, Get(key), values); }
      catch (FormatException) { return Get(key); }
    }
  }
  public static class Host {
    public static void Run(string eventName, bool testMode) {
      try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); Native.SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
      Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
      Application.EnableVisualStyles();
      using (var context = new Controller(eventName, testMode)) Application.Run(context);
    }
  }

  internal static class Native {
    internal delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] internal struct Key { public uint vk, scan, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] internal struct Point { public int x, y; public Point(int a,int b) {x=a;y=b;} }
    [StructLayout(LayoutKind.Sequential)] internal struct Size { public int cx, cy; public Size(int a,int b) {cx=a;cy=b;} }
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { public int left,top,right,bottom; internal Rectangle Bounds { get { return Rectangle.FromLTRB(left,top,right,bottom); } } }
    [StructLayout(LayoutKind.Sequential)] internal struct MonitorInfo { public uint size; public Rect bounds,work; public uint flags; }
    internal delegate bool MonitorCallback(IntPtr monitor,IntPtr dc,IntPtr rectangle,IntPtr data);
    [StructLayout(LayoutKind.Sequential, Pack=1)] internal struct Blend { public byte op, flags, alpha, format; }
    [StructLayout(LayoutKind.Sequential)] internal struct IconInfo { public bool icon; public int hotX, hotY; public IntPtr mask, color; }
    [DllImport("user32.dll", SetLastError=true)] internal static extern bool GetIconInfo(IntPtr icon, out IconInfo info);
    [DllImport("user32.dll")] internal static extern IntPtr LoadCursor(IntPtr instance, IntPtr name);
    [DllImport("user32.dll")] internal static extern uint GetDpiForSystem();
    [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] internal static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", SetLastError=true)] internal static extern bool SystemParametersInfo(uint action, uint param, out int value, uint ini);
    [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", SetLastError=true)] internal static extern IntPtr SetWindowsHookEx(int id, Hook callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] internal static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] internal static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] internal static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("imm32.dll")] internal static extern IntPtr ImmGetDefaultIMEWnd(IntPtr window);
    [DllImport("user32.dll")] internal static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    // The input method of the window in front is open in native (non-Latin)
    // conversion mode: WM_IME_CONTROL to its thread's default IME window
    // (IMC_GETOPENSTATUS, IMC_GETCONVERSIONMODE). Null when it does not answer.
    internal static bool? ImeNative() {
      IntPtr front = GetForegroundWindow();
      if (front == IntPtr.Zero) return null;
      IntPtr ime = ImmGetDefaultIMEWnd(front);
      if (ime == IntPtr.Zero) return false;
      IntPtr open, mode;
      if (SendMessageTimeout(ime, 0x283, new IntPtr(5), IntPtr.Zero, 2, 100, out open) == IntPtr.Zero) return null;
      if (open == IntPtr.Zero) return false;
      if (SendMessageTimeout(ime, 0x283, new IntPtr(1), IntPtr.Zero, 2, 100, out mode) == IntPtr.Zero) return null;
      return (mode.ToInt64() & 1) != 0;
    }
    [DllImport("user32.dll",SetLastError=true)] internal static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] internal static extern IntPtr MonitorFromPoint(Point point, uint flags);
    [DllImport("user32.dll",SetLastError=true)] internal static extern bool EnumDisplayMonitors(IntPtr dc,IntPtr clip,MonitorCallback callback,IntPtr data);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] internal static extern bool GetMonitorInfo(IntPtr monitor,ref MonitorInfo info);
    [DllImport("shcore.dll")] internal static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
    [DllImport("user32.dll")] internal static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] internal static extern int SetWindowLong(IntPtr window,int index,int value);
    [DllImport("user32.dll")] internal static extern bool SetWindowDisplayAffinity(IntPtr window, uint affinity);
    internal static bool ApplyDisplayAffinity(Form window, bool visible){if(window==null||!window.IsHandleCreated)return true;bool ok=SetWindowDisplayAffinity(window.Handle,visible?0u:0x11u);if(!ok&&!visible&&window.Visible)window.Hide();return ok;}
    [DllImport("dwmapi.dll")] internal static extern int DwmFlush();
    [DllImport("user32.dll")] internal static extern bool GetWindowDisplayAffinity(IntPtr window, out uint affinity);
    [DllImport("user32.dll")] internal static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
    [StructLayout(LayoutKind.Sequential)] internal struct ScrollInfo {public uint size,mask;public int minimum,maximum;public uint page;public int position,track;}
    [StructLayout(LayoutKind.Sequential,Pack=4)] internal struct ParagraphFormat {
      public uint size,mask;public short numbering,reserved;public int startIndent,rightIndent,offset;public short alignment,tabCount;
      [MarshalAs(UnmanagedType.ByValArray,SizeConst=32)] public int[] tabs;
      public int spaceBefore,spaceAfter,lineSpacing;public short style;public byte lineRule,outline;
      public short shadingWeight,shadingStyle,numberingStart,numberingStyle,numberingTab,borderSpace,borderWidth,borders;
    }
    [DllImport("user32.dll")] internal static extern bool GetScrollInfo(IntPtr window,int bar,ref ScrollInfo info);
    [DllImport("user32.dll")] internal static extern IntPtr SendMessage(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
    [DllImport("user32.dll",EntryPoint="SendMessageW")] internal static extern IntPtr SendPointMessage(IntPtr window,uint message,IntPtr wParam,ref Point point);
    [DllImport("user32.dll",EntryPoint="SendMessageW")] internal static extern IntPtr SendParagraphMessage(IntPtr window,uint message,IntPtr wParam,ref ParagraphFormat format);
    [DllImport("user32.dll")] internal static extern bool PrintWindow(IntPtr window,IntPtr dc,uint flags);
    [DllImport("user32.dll")] internal static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] internal static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] internal static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] internal static extern IntPtr SelectObject(IntPtr dc, IntPtr value);
    [DllImport("gdi32.dll")] internal static extern bool DeleteObject(IntPtr value);
    [DllImport("gdi32.dll")] internal static extern bool DeleteDC(IntPtr dc);
    [DllImport("user32.dll", SetLastError=true)] internal static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr screenDc, ref Point destination, ref Size size, IntPtr sourceDc, ref Point source, uint key, ref Blend blend, uint flags);
    [StructLayout(LayoutKind.Sequential)] internal struct Msg { public IntPtr window; public uint message; public IntPtr wParam, lParam; public uint time; public Point point; public uint extra; }
    [DllImport("user32.dll")] internal static extern int GetMessage(out Msg message, IntPtr window, uint first, uint last);
    [DllImport("user32.dll")] internal static extern bool PeekMessage(out Msg message, IntPtr window, uint first, uint last, uint remove);
    [DllImport("user32.dll")] internal static extern bool PostThreadMessage(uint thread, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] internal static extern uint GetCurrentThreadId();
    internal static Rectangle[] ActiveDisplays() {
      var result=new List<Rectangle>();
      if(!EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,delegate(IntPtr monitor,IntPtr dc,IntPtr rect,IntPtr data){
        var info=new MonitorInfo {size=(uint)Marshal.SizeOf(typeof(MonitorInfo))};
        if(GetMonitorInfo(monitor,ref info)&&info.bounds.right>info.bounds.left&&info.bounds.bottom>info.bounds.top)result.Add(info.bounds.Bounds);
        return true;
      },IntPtr.Zero))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"Could not enumerate active displays");
      result.Sort(delegate(Rectangle a,Rectangle b){int x=a.Left.CompareTo(b.Left);return x!=0?x:a.Top.CompareTo(b.Top);});
      return result.ToArray();
    }
    internal static Rectangle DisplayFromPoint(Point point) {
      var info=new MonitorInfo {size=(uint)Marshal.SizeOf(typeof(MonitorInfo))};
      if(!GetMonitorInfo(MonitorFromPoint(point,2),ref info))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"Could not locate pointer display");
      return info.bounds.Bounds;
    }
    internal static string DisplayIdentity(Rectangle bounds) {
      IntPtr monitor=MonitorFromPoint(new Point(bounds.Left+bounds.Width/2,bounds.Top+bounds.Height/2),2);
      uint x=96,y=96;try{if(GetDpiForMonitor(monitor,0,out x,out y)!=0)x=y=96;}catch(EntryPointNotFoundException){}
      return bounds.ToString()+"/"+monitor.ToInt64()+"/"+x+"/"+y;
    }
    internal static float ScaleForDisplay(Rectangle bounds) {
      IntPtr monitor = MonitorFromPoint(new Point(bounds.Left + bounds.Width / 2, bounds.Top + bounds.Height / 2), 2);
      uint x = 96, y = 96;
      try { if (GetDpiForMonitor(monitor, 0, out x, out y) == 0 && x > 0) return Math.Max(1f, Math.Min(3f, x / 96f)); }
      catch (EntryPointNotFoundException) { }
      return Math.Max(1f, Math.Min(2f, bounds.Width / 1920f));
    }
    internal static void KeepOnTop(IntPtr window) { SetWindowPos(window,new IntPtr(-1),0,0,0,0,0x213); }
  }

  // Where the user's own mouse last moved, for the overlay's lock button. A
  // low-level hook records local and remote-desktop mouse movement. Only
  // injected movement bearing DSH's input marker is skipped; remote tools
  // also set LLMHF_INJECTED. SetCursorPos never reaches the hook.
  // The hook stores one number, so system input never waits on the overlay.
  internal sealed class PointerWatch : IDisposable {
    readonly Native.Hook callback;
    readonly ManualResetEvent ready = new ManualResetEvent(false);
    IntPtr hook; volatile uint threadId; long packed; volatile bool seen, testFed, disposed;
    internal PointerWatch() {
      callback = OnMouse;
      new Thread(Run) { IsBackground = true, Name = "DSH overlay pointer" }.Start();
      ready.WaitOne(2000);
    }
    internal bool Active { get { return hook != IntPtr.Zero; } }
    void Run() {
      Native.Msg message; Native.PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
      threadId = Native.GetCurrentThreadId();
      if (disposed) { ready.Set(); return; }
      hook = Native.SetWindowsHookEx(14, callback, Native.GetModuleHandle(null), 0);
      ready.Set();
      if (hook == IntPtr.Zero) return;
      try { if (!disposed) while (Native.GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { } }
      finally { Native.UnhookWindowsHookEx(hook); hook = IntPtr.Zero; }
    }
    IntPtr OnMouse(int code, IntPtr message, IntPtr data) {
      if (code >= 0 && !testFed) Record(message.ToInt32(), data);
      return Native.CallNextHookEx(hook, code, message, data);
    }
    // MSLLHOOKSTRUCT: pt.x at 0, pt.y at 4, flags at 12 (1 = injected, 2 = injected from a lower integrity level).
    void Record(int kind, IntPtr data) {
      if (kind != 0x200) return;
      int flags=Marshal.ReadInt32(data,12);
      ulong extra=IntPtr.Size==8?unchecked((ulong)Marshal.ReadInt64(data,24)):unchecked((uint)Marshal.ReadInt32(data,20));
      if((flags&0x03)==1&&extra==(ulong)KeyboardWatch.InputMarker){seen=false;return;}
      Interlocked.Exchange(ref packed, ((long)Marshal.ReadInt32(data, 0) << 32) | (uint)Marshal.ReadInt32(data, 4));
      seen = true;
    }
    // Tests feed the same parser a hook record built in memory, so no real input is needed.
    internal void TestFeed(int x, int y, int flags, ulong extra) {
      testFed = true; IntPtr data = Marshal.AllocHGlobal(32);
      try { for (int offset = 0; offset < 32; offset += 4) Marshal.WriteInt32(data, offset, 0); Marshal.WriteInt32(data, 0, x); Marshal.WriteInt32(data, 4, y); Marshal.WriteInt32(data, 12, flags); if(IntPtr.Size==8)Marshal.WriteInt64(data,24,unchecked((long)extra));else Marshal.WriteInt32(data,20,unchecked((int)extra)); Record(0x200, data); }
      finally { Marshal.FreeHGlobal(data); }
    }
    internal bool Latest(out Native.Point point) {
      long value = Interlocked.Read(ref packed); point = new Native.Point((int)(value >> 32), (int)value);
      return seen;
    }
    public void Dispose() { disposed = true; if (threadId != 0) Native.PostThreadMessage(threadId, 0x12, IntPtr.Zero, IntPtr.Zero); }
  }


  // The keyboard callback owns a dedicated message pump. Drawing and pipe
  // writes never run on this thread. Session changes reinstall the hook via
  // Reinstall(); readiness is cleared if replacement fails.
  internal sealed class KeyboardWatch : IDisposable {
    internal static readonly uint InputMarker = ParseInputMarker();
    static uint ParseInputMarker() {
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
    internal static bool OwnInput(uint flags, UIntPtr extra){return (flags&0x10u)!=0&&(flags&0x02u)==0&&extra.ToUInt64()==(ulong)InputMarker;}
    readonly Native.Hook callback;
    readonly EventWaitHandle available;
    readonly ManualResetEvent started = new ManualResetEvent(false);
    readonly Func<int,bool,bool,bool> handle;
    IntPtr hook; uint threadId; volatile bool disposed;
    internal KeyboardWatch(string eventName, Func<int,bool,bool,bool> onKey) {
      handle=onKey;callback=OnKey;
      available=new EventWaitHandle(false,EventResetMode.ManualReset,eventName+"-ready");
      new Thread(Run){IsBackground=true,Name="DSH stop keyboard"}.Start();
      if(!started.WaitOne(3000)||!Active)throw new InvalidOperationException("Could not start the stop keyboard listener");
    }
    internal bool Active {get{return hook!=IntPtr.Zero&&!disposed;}}
    void ReplaceHook(){
      var next=Native.SetWindowsHookEx(13,callback,Native.GetModuleHandle(null),0);
      if(next==IntPtr.Zero){available.Reset();return;}
      var old=hook;hook=next;available.Set();
      if(old!=IntPtr.Zero)Native.UnhookWindowsHookEx(old);
    }
    void Run(){
      Native.Msg message;Native.PeekMessage(out message,IntPtr.Zero,0,0,0);threadId=Native.GetCurrentThreadId();
      try{
        ReplaceHook();started.Set();
        while(!disposed&&Native.GetMessage(out message,IntPtr.Zero,0,0)>0){if(message.message==0x8001)ReplaceHook();else if(message.message==0x8002)handle(0x1B,false,true);}
      }finally{available.Reset();if(hook!=IntPtr.Zero)Native.UnhookWindowsHookEx(hook);hook=IntPtr.Zero;}
    }
    IntPtr OnKey(int code,IntPtr message,IntPtr data){
      if(code>=0){int kind=message.ToInt32();if(kind==0x100||kind==0x104||kind==0x101||kind==0x105){
        var key=(Native.Key)Marshal.PtrToStructure(data,typeof(Native.Key));
        if(handle((int)key.vk,OwnInput(key.flags,key.extra),kind==0x100||kind==0x104))return new IntPtr(1);
      }}
      return Native.CallNextHookEx(hook,code,message,data);
    }
    internal void Reinstall(){if(threadId!=0&&!disposed)Native.PostThreadMessage(threadId,0x8001,IntPtr.Zero,IntPtr.Zero);}
    internal void TestStop(){Native.PostThreadMessage(threadId,0x8002,IntPtr.Zero,IntPtr.Zero);}
    public void Dispose(){disposed=true;available.Reset();if(threadId!=0)Native.PostThreadMessage(threadId,0x12,IntPtr.Zero,IntPtr.Zero);}
  }

  // A generation counter cannot be cleared by another helper starting a new
  // operation. Every live helper retains the mapping and polls on its own thread.
  // Local keyboard cancellation never waits for this cross-process publication.
  internal sealed class StopBus : IDisposable {
    readonly Mutex mutex;
    readonly MemoryMappedFile mapping;
    readonly MemoryMappedViewAccessor view;
    readonly ManualResetEvent closing = new ManualResetEvent(false);
    readonly object gate = new object();
    readonly Thread thread;
    readonly Action stopped;
    long seen;
    bool disposed;
    internal StopBus(string name, Action onStop) {
      stopped=onStop;
      mutex=new Mutex(false,name+"-lock");
      mapping=MemoryMappedFile.CreateOrOpen(name,8);
      view=mapping.CreateViewAccessor(0,8);
      if(!Read(false))throw new InvalidOperationException("Could not initialize shared stop listener");
      thread=new Thread(Run){IsBackground=true,Name="DSH shared stop"};thread.Start();
    }
    bool Acquire(int timeout) {
      try{return mutex.WaitOne(timeout);}catch(AbandonedMutexException){return true;}
    }
    bool Read(bool notify) {
      bool changed=false;
      lock(gate){
        if(disposed||!Acquire(250))return false;
        try{long next=view.ReadInt64(0);changed=next!=seen;seen=next;}
        finally{mutex.ReleaseMutex();}
      }
      if(changed&&notify)stopped();
      return true;
    }
    void Run(){
      while(!closing.WaitOne(40)){
        try{if(!Read(true))stopped();}catch{stopped();return;}
      }
    }
    internal void Publish(){
      ThreadPool.QueueUserWorkItem(_=>{
        try{
          lock(gate){
            if(disposed)return;
            if(!Acquire(250)){stopped();return;}
            try{seen=unchecked(view.ReadInt64(0)+1);view.Write(0,seen);}
            finally{mutex.ReleaseMutex();}
          }
        }catch{stopped();}
      });
    }
    public void Dispose(){
      closing.Set();thread.Join(2000);
      lock(gate){disposed=true;view.Dispose();mapping.Dispose();mutex.Dispose();}
      closing.Dispose();
    }
  }

  internal sealed class Controller : ApplicationContext {
    readonly Control dispatcher = new Control();
    readonly EventWaitHandle cancel;
    readonly KeyboardWatch keyboard;
    readonly StopBus stopBus;
    readonly object keyState=new object();
    // The user's last letter (pinyin and other input-method text) and last key
    // that commits or cancels it (space, Enter, a digit, punctuation, Esc,
    // Tab), as positions in the stream of their keys; when that letter came,
    // in milliseconds of composeClock.
    readonly System.Diagnostics.Stopwatch composeClock = System.Diagnostics.Stopwatch.StartNew();
    long keyCount, letterAt = -1, letterIndex = -1, commitIndex = -1;
    bool? testIme;
    readonly bool testMode;
    readonly CommandJson json = new CommandJson();
    readonly List<Frame> frames = new List<Frame>();
    PointerFrame pointer;
    ProgressFrame progress;
    PointerWatch pointerWatch;
    Native.Point? testOverlayCursor;
    DateTime progressPreviewUntil=DateTime.MinValue;
    bool progressCloseWhenIdle;
    string lastTurnKey="",dismissedTurnKey;
    bool progressSettingEnabled=true;
    volatile bool progressAvailable;
    int progressKey,progressModifiers;
    Native.Point? testPointerPoint;
    Rectangle[] displays=new Rectangle[0],testDisplays;
    string displaySignature="";
    DateTime nextDisplayPoll=DateTime.MinValue;
    int displayRevision;
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    volatile bool armed, paused, shuttingDown;
    bool previewOnly;
    readonly HashSet<int> physicalDown = new HashSet<int>(), swallowed = new HashSet<int>();
    string stopShortcut = "";
    int stopKey, stopModifiers;
    DateTime hideAt = DateTime.MaxValue;
    bool indicator = true, cursorIndicator = true, remoteVisible = true;
    int captureDepth;
    int cursorError;
    string text = "", hint = "", position = "top";
    int idleMs = 800;

    internal Controller(string eventName, bool tests) {
      testMode = tests;
      cancel = new EventWaitHandle(false, EventResetMode.ManualReset, eventName);
      var handle = dispatcher.Handle;
      cancel.Reset();
      string group=tests?(Environment.GetEnvironmentVariable("WCU_TEST_STOP_GROUP")??eventName+"-test-stop"):
        "Local\\DSH-WCU-AllStop-v1-"+WindowsIdentity.GetCurrent().User.Value;
      stopBus=new StopBus(group,()=>{if(armed&&!paused&&!shuttingDown)Stop("shared-stop",false);});
      keyboard=new KeyboardWatch(eventName,HandleKey);
      timer.Interval = 35;
      timer.Tick += delegate {
        // A window the user is moving or resizing goes once they are done.
        if(progress!=null&&progressPreviewUntil!=DateTime.MaxValue&&DateTime.UtcNow>progressPreviewUntil&&!progress.Adjusting){progressPreviewUntil=DateTime.MinValue;CloseProgress();}
        if(progressCloseWhenIdle&&progress!=null&&!progress.Adjusting)CloseProgress();
        TrackProgressPointer();

        double elapsed = hideAt == DateTime.MaxValue ? -1 : (DateTime.UtcNow - hideAt).TotalMilliseconds;
        if (elapsed >= 160) { HideFrames(); HidePointer(); armed = false; hideAt = DateTime.MaxValue; SyncTimer(); return; }
        byte alpha = elapsed >= 0 ? (byte)Math.Max(0, 255 * (1 - elapsed / 160)) : (byte)255;
        if(armed&&!paused)RefreshDisplays(false);
        UpdatePointer(alpha);
        if (elapsed >= 0) foreach (var frame in frames) frame.Present(alpha);
        SyncTimer();
      };
      SyncTimer();
      SystemEventsSubscribe();
      new Thread(ReadCommands) { IsBackground = true, Name = "DSH takeover control" }.Start();
      RefreshDisplays(true);
      // The Windows process id: under WSL the server sees only the id of the
      // interop process that started this one (#79).
      Emit(new { kind = "ready", hookActive = keyboard.Active, monitors = displays.Length, pid = System.Diagnostics.Process.GetCurrentProcess().Id });
    }
    void SyncTimer() {
      bool active = !shuttingDown && (armed || hideAt != DateTime.MaxValue || frames.Count > 0 || pointer != null || progress != null);
      if (active && !timer.Enabled) timer.Start();
      else if (!active && timer.Enabled) timer.Stop();
    }

    void SystemEventsSubscribe() { Microsoft.Win32.SystemEvents.DisplaySettingsChanged += DisplaysChanged; Microsoft.Win32.SystemEvents.SessionSwitch += SessionChanged; Microsoft.Win32.SystemEvents.UserPreferenceChanged += PreferencesChanged; }
    // A pointer size or scheme change arrives as a preference change; measure the arrow again.
    void PreferencesChanged(object sender,Microsoft.Win32.UserPreferenceChangedEventArgs args) {
      if (shuttingDown) return;
      try { dispatcher.BeginInvoke((Action)PointerFrame.ForgetPointerSize); } catch (InvalidOperationException) { }
    }
    void SessionChanged(object sender,Microsoft.Win32.SessionSwitchEventArgs args) {
      lock(keyState){physicalDown.Clear();swallowed.Clear();}
      if(keyboard!=null)keyboard.Reinstall();
      DisplaysChanged(sender,EventArgs.Empty);
    }
    void DisplaysChanged(object sender, EventArgs args) {
      if (shuttingDown) return;
      try { dispatcher.BeginInvoke((Action)delegate { RefreshDisplays(true); UpdatePointer(255); SyncTimer(); }); } catch (InvalidOperationException) { }
    }
    bool RefreshDisplays(bool force) {
      if(!force&&DateTime.UtcNow<nextDisplayPoll)return false;
      nextDisplayPoll=DateTime.UtcNow.AddMilliseconds(500);
      Rectangle[] next=testMode&&testDisplays!=null?testDisplays:Native.ActiveDisplays();
      string signature=String.Join(";",Array.ConvertAll(next,delegate(Rectangle r){return Native.DisplayIdentity(r);}));
      if(signature==displaySignature){foreach(var frame in frames)Native.KeepOnTop(frame.Handle);if(pointer!=null)Native.KeepOnTop(pointer.Handle);return false;}
      displays=next;displaySignature=signature;displayRevision++;
      HideFrames();HidePointer();
      if(armed&&!paused&&indicator)ShowFrames();
      return true;
    }
    void ConfigureVisibility(bool visible) {
      remoteVisible=visible;
      ApplyCaptureVisibility();
    }
    void ApplyCaptureVisibility() {
      bool visible=remoteVisible&&captureDepth==0;
      foreach(var frame in frames)frame.SetRemoteVisible(visible);
      if(pointer!=null)pointer.SetRemoteVisible(visible);
      if(progress!=null)Native.ApplyDisplayAffinity(progress,visible);
    }
    void Emit(object value) { lock (json) { Console.Out.WriteLine(json.Serialize(value)); Console.Out.Flush(); } }
    void ReadCommands() {
      try {
        string line;
        while ((line = Console.ReadLine()) != null) {
          var command = new CommandJson().Deserialize<Dictionary<string,object>>(line);
          if(Get(command,"command","")=="cancel_input"){
            cancel.Set();object id;command.TryGetValue("id",out id);if(id!=null)Emit(new {id=id,ok=true});continue;
          }
          if(Get(command,"command","")=="input_state"){
            object id;command.TryGetValue("id",out id);Emit(new {id=id,ok=true,composing=Composing()});continue;
          }
          dispatcher.BeginInvoke((Action)(() => Dispatch(command)));
        }
      } catch (Exception error) { Console.Error.WriteLine(error.Message); }
      finally { try { cancel.Set(); } catch (ObjectDisposedException) { } try { dispatcher.BeginInvoke((Action)(() => ExitThread())); } catch (InvalidOperationException) { } }
    }
    static T Get<T>(Dictionary<string,object> command, string name, T fallback) {
      object value; return command.TryGetValue(name, out value) ? (T)Convert.ChangeType(value, typeof(T)) : fallback;
    }
    void Dispatch(Dictionary<string,object> command) {
      object id; command.TryGetValue("id", out id);
      try {
        bool consumed = false;
        string action = Get(command, "command", "");
        object strings; if (command.TryGetValue("strings", out strings)) Words.Use(strings);
        if(action=="capture_begin"){
          captureDepth++;ApplyCaptureVisibility();
          if (captureDepth == 1 && remoteVisible && (frames.Count > 0 || pointer != null || progress != null)) Native.DwmFlush();
        } else if(action=="capture_end"){
          captureDepth=Math.Max(0,captureDepth-1);ApplyCaptureVisibility();
        } else if (action == "begin" || action == "preview") {
          if (paused) throw new InvalidOperationException("COMPUTER_USE_STOPPED_BY_USER");
          string prevShortcut = stopShortcut;
          ConfigureShortcut(Get(command, "stopShortcut", stopShortcut));
          bool nextIndicator = Get(command, "indicatorEnabled", true);
          ConfigureVisibility(Get(command,"remoteIndicatorVisible",true));
          cursorIndicator = Get(command, "cursorIndicatorEnabled", true);
          string nextText = Get(command, "indicatorText", Words.Get("indicatorDefault")), nextPosition = Get(command, "indicatorPosition", "top"), nextHint = Words.Get("stopHint");
          bool rebuild = nextIndicator != indicator || nextText != text || nextHint != hint || nextPosition != position || prevShortcut != stopShortcut || frames.Count == 0;
          indicator = nextIndicator; text = nextText; hint = nextHint; position = nextPosition;
          idleMs = Math.Max(200, Math.Min(3000, Get(command, "indicatorIdleMs", 800)));
          bool alreadyArmed=armed;
          armed=true;previewOnly=action=="preview"&&!alreadyArmed;
          hideAt=previewOnly?DateTime.UtcNow.AddMilliseconds(1800):DateTime.MaxValue;
          bool displaysRebuilt=RefreshDisplays(true);
          if (!indicator) HideFrames();
          else if (rebuild&&!displaysRebuilt) { HideFrames(); ShowFrames(); }
          else foreach (var frame in frames) frame.Present(255);
          UpdatePointer(255);
        } else if (action == "progress") {
          bool enabled=Get(command,"enabled",false),preview=Get(command,"preview",false);
          object supplied;
          var data=command.TryGetValue("progress",out supplied)?supplied as Dictionary<string,object>:null;
          var settings=command.TryGetValue("settings",out supplied)?supplied as Dictionary<string,object>:null;
          bool settingEnabled=settings==null||Get(settings,"progressOverlayEnabled",true);
          if(progressSettingEnabled&&!settingEnabled){progressPreviewUntil=DateTime.MinValue;dismissedTurnKey=null;}
          progressSettingEnabled=settingEnabled;
          if(preview){dismissedTurnKey=null;progressPreviewUntil=DateTime.UtcNow.AddSeconds(60);}
          if(!enabled){lastTurnKey="";dismissedTurnKey=null;}
          else if(!preview){
            string explicitKey=Get(command,"turnKey","");
            long startedAt=ProgressFrame.Whole(data,"startedAt");
            string currentTurnKey=explicitKey!=""?explicitKey:(startedAt>0?startedAt.ToString():"active");
            lastTurnKey=currentTurnKey;
            if(dismissedTurnKey!=null&&currentTurnKey!=dismissedTurnKey)dismissedTurnKey=null;
            if(dismissedTurnKey!=null){Emit(new {id=id,ok=true,progressVisible=false});return;}
          }
          bool leavingPreview=enabled&&!preview&&progressPreviewUntil!=DateTime.MaxValue&&progressPreviewUntil!=DateTime.MinValue;
          if(enabled&&!preview)progressPreviewUntil=DateTime.MaxValue;
          if(!enabled&&(progressPreviewUntil==DateTime.MaxValue||DateTime.UtcNow>=progressPreviewUntil)){if(progress!=null&&progress.Adjusting)progressCloseWhenIdle=true;else CloseProgress();}
          else {
            progressCloseWhenIdle=false;
            bool fresh=progress==null;
            if(fresh){progress=new ProgressFrame(delegate(Dictionary<string,object> patch,Dictionary<string,object> baseline){Emit(new {kind="progress-layout",patch=patch,@base=baseline});},delegate {
              bool wasPreview=(progressPreviewUntil!=DateTime.MinValue&&progressPreviewUntil!=DateTime.MaxValue&&DateTime.UtcNow<progressPreviewUntil)||(progress!=null&&progress.IsPreview);
              progressPreviewUntil=DateTime.MinValue;
              if(!wasPreview&&lastTurnKey!="")dismissedTurnKey=lastTurnKey;
              CloseProgress();
            });progressAvailable=true;}
            progress.Configure(settings,Get(command,"remoteIndicatorVisible",true));
            lock(keyState){int savedKey=stopKey,savedModifiers=stopModifiers;string savedShortcut=stopShortcut;
            ConfigureShortcut(settings!=null?Get(settings,"progressLockShortcut",""):"");progressKey=stopKey;progressModifiers=stopModifiers;
            stopKey=savedKey;stopModifiers=savedModifiers;stopShortcut=savedShortcut;}
            if(enabled)progress.UpdateProgress(data);
            if(fresh)progress.Show();
            // The adjustment preview unlocks only while it lasts; the saved lock
            // state is untouched unless the user toggles it themselves.
            if(preview)progress.BeginPreview();else if(leavingPreview)progress.EndPreview();
          }
        } else if(action=="test_progress_close"&&testMode){
          if(progress!=null)progress.RequestClose();
        } else if(action=="test_progress_layout"&&testMode){
          if(progress==null)throw new InvalidOperationException("No progress window");
          progress.Bounds=new Rectangle(Get(command,"x",100),Get(command,"y",100),Get(command,"width",500),Get(command,"height",350));progress.EmitLayout();
        } else if (action == "test_render_progress" && testMode) {
          if(progress==null)throw new InvalidOperationException("No progress window");
          Emit(new {id=id,ok=true,capture=progress.CaptureProgress(Get(command,"path",""),Get(command,"screen",false))});return;
        } else if(action=="test_progress_scroll"&&testMode){
          if(progress!=null){if(Get(command,"wheel",false))progress.ScrollWheel(Get(command,"delta",120));else progress.ScrollLines(Get(command,"lines",0));}
        } else if(action=="test_progress_dpi"&&testMode){
          if(progress!=null)progress.TestDpi((float)Get(command,"scale",1.0));
        } else if(action=="test_progress_scrollbar"&&testMode){
          if(progress!=null)progress.TestScrollbar(Get(command,"x",0),Get(command,"y",0),Get(command,"endY",0));
        } else if(action=="test_progress_hittest"&&testMode){
          if(progress==null)throw new InvalidOperationException("No progress window");
          Emit(new {id=id,ok=true,hit=progress.TestHitAt(Get(command,"x",20),Get(command,"y",20))});return;
        } else if(action=="test_progress_close_click"&&testMode){
          if(progress!=null)progress.TestCloseClick();
        } else if(action=="test_progress_lock_click"&&testMode){
          if(progress!=null)progress.TestLockClick();
        } else if(action=="test_progress_pointer"&&testMode){
          // Feed actual hook flags and extra-info through the real parser.
          // Existing injected test records default to the plugin's marker.
          testOverlayCursor=new Native.Point(Get(command,"x",0),Get(command,"y",0));
          int flags=Get(command,"hookFlags",-1);
          if(flags>=0){if(pointerWatch==null)pointerWatch=new PointerWatch();pointerWatch.TestFeed(Get(command,"x",0),Get(command,"y",0),flags,(ulong)Get<long>(command,"extra",(flags&1)!=0?(long)(ulong)KeyboardWatch.InputMarker:0L));}
          TrackProgressPointer();
        } else if(action=="test_progress_backdrop"&&testMode){
          if(progress!=null)progress.ShowTestBackdrop();
        } else if(action=="test_progress_resize_redraw"&&testMode){
          if(progress!=null)progress.TestResizeRedraw(Get(command,"enabled",true));
        } else if(action=="test_block_ui_stop"&&testMode){
          new Thread(()=>{Thread.Sleep(80);keyboard.TestStop();}){IsBackground=true}.Start();
          Thread.Sleep(Get(command,"milliseconds",500));
        } else if (action == "configure") {
          string prevShortcut = stopShortcut;
          ConfigureShortcut(Get(command, "stopShortcut", ""));
          ConfigureVisibility(Get(command,"remoteIndicatorVisible",remoteVisible));
          cursorIndicator = Get(command, "cursorIndicatorEnabled", cursorIndicator); UpdatePointer(255);
          if (prevShortcut != stopShortcut && armed && !paused && indicator && frames.Count > 0) { HideFrames(); ShowFrames(); }
        } else if (action == "end") {
          hideAt = DateTime.UtcNow.AddMilliseconds(idleMs);
        } else if (action == "stop") {
          Stop("user");
        } else if (action == "resume") {
          paused = false; armed = false; cancel.Reset(); HideFrames(); HidePointer(); hideAt = DateTime.MaxValue;
        } else if (action == "close") {
          cancel.Set(); ExitThread();
        } else if (action == "test_key" && testMode) {
          bool injected=Get(command,"injected",false);
          uint flags=(uint)Get<long>(command,"flags",injected?0x10L:0L);
          ulong extra=(ulong)Get<long>(command,"extra",injected?(long)(ulong)KeyboardWatch.InputMarker:0L);
          consumed = HandleKey(Get(command, "vk", 0), KeyboardWatch.OwnInput(flags,new UIntPtr(extra)), Get(command, "down", true));
        } else if (action == "test_ime" && testMode) {
          object native; testIme = command.TryGetValue("native", out native) && native != null ? (bool?)Convert.ToBoolean(native) : null;
        } else if (action == "test_render" && testMode) {
          using (var image = Frame.Draw(1200, 675, Get(command, "indicatorText", text), Get(command, "indicatorPosition", "top"), Get(command, "stopShortcut", stopShortcut), 0f)) image.Save(Get(command, "path", ""), ImageFormat.Png);
        } else if (action == "test_render_pointer" && testMode) {
          float zoom=(float)Get(command,"scale",2.0);
          using (var image = PointerFrame.Draw(zoom, false, false)) {
            using (var graphics = Graphics.FromImage(image)) Cursors.Arrow.Draw(graphics, new Rectangle((int)(24*zoom),(int)(24*zoom),(int)(16*zoom),(int)(16*zoom)));
            image.Save(Get(command, "path", ""), ImageFormat.Png);
          }
        } else if (action == "test_pointer_source" && testMode) {
          testPointerPoint=new Native.Point(Get(command,"x",200),Get(command,"y",200)); UpdatePointer(255);
        } else if (action == "test_pointer_layout" && testMode) {
          var bounds = PointerFrame.LayoutForPoint(new Native.Point(Get(command,"x",0),Get(command,"y",0)), new Rectangle(Get(command,"left",0),Get(command,"top",0),Get(command,"width",1920),Get(command,"height",1080)), (float)Get(command,"scale",1.0));
          Emit(new { id=id,ok=true,left=bounds.X,top=bounds.Y,width=bounds.Width,height=bounds.Height }); return;
        } else if(action=="test_displays"&&testMode) {
          object supplied;if(!command.TryGetValue("displays",out supplied)||!(supplied is System.Collections.IEnumerable))throw new ArgumentException("Displays array required");
          var next=new List<Rectangle>();
          foreach(var item in (System.Collections.IEnumerable)supplied){var r=item as Dictionary<string,object>;if(r==null)throw new ArgumentException("Display object required");int width=Get(r,"width",0),height=Get(r,"height",0);if(width<64||height<64||width>8192||height>8192)throw new ArgumentException("Invalid test display size");next.Add(new Rectangle(Get(r,"left",0),Get(r,"top",0),width,height));}
          testDisplays=next.ToArray();nextDisplayPoll=DateTime.MinValue;
        } else if(action=="test_restore_displays"&&testMode) {
          testDisplays=null;nextDisplayPoll=DateTime.MinValue;
        } else if (action != "status") throw new InvalidOperationException("Unknown takeover command");
        ApplyCaptureVisibility();
        SyncTimer();
        if (testMode || action == "status") {
          Native.Point livePoint; bool liveCursorAvailable=Native.GetCursorPos(out livePoint);
          Emit(new { id = id, ok = true, armed = armed, paused = paused, cancelled = cancel.WaitOne(0), consumed = consumed, uiWindowCount=Application.OpenForms.Count, stopShortcut = stopShortcut, windows = frames.Count, progressVisible=progress!=null, progressWindow=progress!=null?progress.Handle.ToInt64():0, progressClickThrough=progress!=null&&progress.ClickThrough, progressContent=progress!=null?progress.Content:null, progressLocked=progress!=null&&progress.Locked, progressHover=progress!=null?progress.HoverStatus():null, pointerWatchActive=pointerWatch!=null&&pointerWatch.Active, progressReading=progress!=null?progress.ReadingStatus():null, progressOpacity=progress!=null?progress.BackgroundOpacity:0, progressBounds=progress!=null?new {x=progress.Left,y=progress.Top,width=progress.Width,height=progress.Height}:null, remoteIndicatorVisible=remoteVisible, overlayCaptureExcluded=frames.Count>0&&frames.TrueForAll(frame=>frame.CaptureExcluded), overlayClickThrough=frames.Count>0&&frames.TrueForAll(frame=>frame.ClickThrough), displayRevision=displayRevision, displays=Array.ConvertAll(displays,r=>new {left=r.Left,top=r.Top,width=r.Width,height=r.Height}), overlayBounds=frames.ConvertAll(frame=>new {left=frame.DisplayBounds.Left,top=frame.DisplayBounds.Top,width=frame.DisplayBounds.Width,height=frame.DisplayBounds.Height}), cursorError = cursorError, liveCursorAvailable = liveCursorAvailable, pointerSource = testPointerPoint.HasValue ? "test-seam" : "windows", pointerVisible = pointer != null, pointerClickThrough = pointer != null && pointer.ClickThrough, pointerCaptureExcluded = pointer != null && pointer.CaptureExcluded, foreground = Native.GetForegroundWindow().ToInt64() });
        } else {
          Emit(new { id = id, ok = true, armed = armed, paused = paused, cancelled = cancel.WaitOne(0) });
        }
      } catch (Exception error) { Emit(new { id = id, ok = false, error = error.Message }); }
    }
    // Under keyState. Shortcuts (Ctrl, Alt, Win) and Shift+letter (Latin
    // capitals) neither start nor end input-method text.
    void TrackComposition(int vk) {
      int held = 0; foreach (int key in physicalDown) if (key != vk) held |= Modifier(key);
      if ((held & 11) != 0) return;
      keyCount++;
      bool letter = (vk >= 0x41 && vk <= 0x5A) || vk == 0xDE || vk == 0xBA;
      if (letter) { if ((held & 4) == 0) { letterIndex = keyCount; letterAt = composeClock.ElapsedMilliseconds; } return; }
      bool commit = vk == 0x20 || vk == 0x0D || vk == 0x1B || vk == 0x09 || (vk >= 0x30 && vk <= 0x39) || (vk >= 0x60 && vk <= 0x69) || (vk >= 0xBB && vk <= 0xC0) || (vk >= 0xDB && vk <= 0xDD);
      if (commit) commitIndex = keyCount;
    }
    // The user is in the middle of input-method text: a letter came last,
    // within 4 s, and the window in front has its input method in native mode
    // (or does not say). Low disruption waits for it before borrowing input.
    bool Composing() {
      long letter, commit, at, now = composeClock.ElapsedMilliseconds;
      lock (keyState) { letter = letterIndex; commit = commitIndex; at = letterAt; }
      if (letter < 0 || letter < commit || now - at > 4000) return false;
      bool? native = testMode && testIme.HasValue ? testIme : Native.ImeNative();
      return native != false;
    }
    static int Modifier(int vk) {
      if (vk == 0x11 || vk == 0xA2 || vk == 0xA3) return 1;
      if (vk == 0x12 || vk == 0xA4 || vk == 0xA5) return 2;
      if (vk == 0x10 || vk == 0xA0 || vk == 0xA1) return 4;
      if (vk == 0x5B || vk == 0x5C) return 8;
      return 0;
    }
    void ConfigureShortcut(string shortcut) {
      int nextKey = 0, nextModifiers = 0;
      if (shortcut.Length > 0) {
        string[] parts = shortcut.Split('+');
        for (int i = 0; i < parts.Length - 1; i++) {
          int flag = parts[i] == "Ctrl" ? 1 : parts[i] == "Alt" ? 2 : parts[i] == "Shift" ? 4 : parts[i] == "Win" ? 8 : 0;
          if (flag == 0 || (nextModifiers & flag) != 0) throw new ArgumentException("Invalid stop shortcut modifiers");
          nextModifiers |= flag;
        }
        string key = parts[parts.Length - 1]; int number;
        if (key.Length == 1 && ((key[0] >= 'A' && key[0] <= 'Z') || (key[0] >= '0' && key[0] <= '9'))) nextKey = key[0];
        else if (key.StartsWith("F") && int.TryParse(key.Substring(1), out number) && number >= 1 && number <= 24) nextKey = 0x6F + number;
        else {
          var common = new Dictionary<string,int> { {"Space",0x20},{"Enter",0x0D},{"Tab",0x09},{"Backspace",0x08},{"Delete",0x2E},{"Insert",0x2D},{"Home",0x24},{"End",0x23},{"PageUp",0x21},{"PageDown",0x22},{"Up",0x26},{"Down",0x28},{"Left",0x25},{"Right",0x27},{"Pause",0x13},{"CapsLock",0x14},{"NumLock",0x90},{"ScrollLock",0x91} };
          if (!common.TryGetValue(key, out nextKey)) throw new ArgumentException("Invalid stop shortcut key");
        }
      }
      lock(keyState){stopShortcut = shortcut; stopKey = nextKey; stopModifiers = nextModifiers;}
    }
    bool HandleKey(int vk, bool ownInput, bool down) { lock(keyState) {
      if (ownInput) return false;
      if (!down) { physicalDown.Remove(vk); return swallowed.Remove(vk); }
      physicalDown.Add(vk);
      TrackComposition(vk);
      if (swallowed.Contains(vk)) return true;
      int modifiers = 0; foreach (int key in physicalDown) modifiers |= Modifier(key);
      if(progressAvailable&&progressKey!=0&&vk==progressKey&&modifiers==progressModifiers&&!(armed&&!paused&&vk==stopKey&&modifiers==stopModifiers)){
        swallowed.Add(vk);if(dispatcher.InvokeRequired)dispatcher.BeginInvoke((Action)(()=>{if(progress!=null)progress.SetLocked(!progress.Locked,true);}));else progress.SetLocked(!progress.Locked,true);return true;
      }
      if (!armed || paused) return false;
      if (vk != 0x1B && (stopKey == 0 || vk != stopKey || modifiers != stopModifiers)) return false;
      swallowed.Add(vk);
      // Signal the worker first, before any rendering or pipe activity.
      cancel.Set(); Stop(vk == 0x1B ? "escape" : "shortcut"); return true;
    }}
    void Stop(string reason, bool broadcast=true) {
      cancel.Set();paused=true;armed=false;
      if(broadcast)stopBus.Publish();
      Action draw=()=>{hideAt=DateTime.MaxValue;HideFrames();HidePointer();SyncTimer();};
      if(dispatcher.InvokeRequired){
        try{dispatcher.BeginInvoke(draw);}catch(InvalidOperationException){}
        ThreadPool.QueueUserWorkItem(_=>Emit(new {kind="stopped",reason=reason}));
      }else{draw();Emit(new {kind="stopped",reason=reason});}
    }
    void ShowFrames() {
      foreach (var bounds in displays) { var frame = new Frame(bounds, text, position, remoteVisible&&captureDepth==0, stopShortcut, Native.ScaleForDisplay(bounds)); frames.Add(frame); frame.Show(); frame.Present(255); }
    }
    void HideFrames() { foreach (var frame in frames) frame.Dispose(); frames.Clear(); }
    void UpdatePointer(byte alpha) {
      if (!armed || paused || !cursorIndicator) { HidePointer(); return; }
      Native.Point point;
      if(testMode&&testPointerPoint.HasValue)point=testPointerPoint.Value;
      else if (!Native.GetCursorPos(out point)) { cursorError=Marshal.GetLastWin32Error(); HidePointer(); return; }
      cursorError=0;
      if (pointer == null) { pointer = new PointerFrame(remoteVisible&&captureDepth==0); pointer.Update(point, alpha); pointer.Show(); }
      else pointer.Update(point, alpha);
    }
    void HidePointer() { if (pointer != null) { pointer.Dispose(); pointer = null; } }
    void CloseProgress() {
      progressAvailable=false;
      progressCloseWhenIdle=false;
      if(progress!=null){progress.Dispose();progress=null;}
      if(pointerWatch!=null){pointerWatch.Dispose();pointerWatch=null;}
      SyncTimer();
    }
    // The overlay's lock button answers the user's own pointer only. The hook
    // runs only while a locked (or hover-unlocked) overlay is on screen.
    void TrackProgressPointer() {
      if(progress==null||progress.IsDisposed||!progress.IsHandleCreated)return;
      bool watching=progress.WantsPointer;
      if(watching&&pointerWatch==null)pointerWatch=new PointerWatch();
      else if(!watching&&pointerWatch!=null){pointerWatch.Dispose();pointerWatch=null;}
      if(!watching)return;
      Native.Point cursor,moved;
      if(testMode&&testOverlayCursor.HasValue)cursor=testOverlayCursor.Value;
      else if(!Native.GetCursorPos(out cursor))return;
      // The cursor must still be where the user's last local/remote move left it;
      // DSH moving it elsewhere (SetCursorPos) breaks the match.
      bool userPointer=pointerWatch.Latest(out moved)&&Math.Abs(moved.x-cursor.x)<=2&&Math.Abs(moved.y-cursor.y)<=2;
      progress.TrackPointer(cursor,userPointer);
    }
    protected override void Dispose(bool disposing) {
      if (disposing && !shuttingDown) {
        shuttingDown = true; cancel.Set(); timer.Stop(); timer.Dispose(); HideFrames(); HidePointer(); CloseProgress();
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged -= DisplaysChanged;
        Microsoft.Win32.SystemEvents.SessionSwitch -= SessionChanged;
        Microsoft.Win32.SystemEvents.UserPreferenceChanged -= PreferencesChanged;
        stopBus.Dispose();keyboard.Dispose();
        dispatcher.Dispose(); cancel.Dispose();
      }
      base.Dispose(disposing);
    }
  }

