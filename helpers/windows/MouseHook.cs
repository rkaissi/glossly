using System.Runtime.InteropServices;
using static Glossly.Helper.Win32;

namespace Glossly.Helper;

/// <summary>
/// Mouse-only low-level hook, plus a keyboard-activity signal derived from GetLastInputInfo.
/// There is deliberately no keyboard hook: the app learns that "some non-mouse input happened",
/// never which keys were pressed.
/// </summary>
internal static class MouseHook
{
    private const int DragThresholdPx = 4;
    private const int WheelThrottleMs = 100;
    // GetLastInputInfo and the hook's timestamps come from the same tick counter but are not
    // updated at exactly the same moment.
    private const int MouseTickToleranceMs = 50;
    private const int InjectedQuietMs = 150;
    private const int PollMs = 50;

    private static readonly object Gate = new();
    private static readonly HookProc Proc = Callback; // kept alive for the hook's lifetime
    private static Thread? _thread;
    private static uint _threadId;

    private static volatile bool _emitMouse;
    private static volatile bool _watchInput;
    private static Thread? _pollThread;

    // Hook-thread state.
    private static POINT _downPt;
    private static uint _lastUpTime;
    private static POINT _lastUpPt;
    private static uint _lastWheelTime;
    private static long _lastMouseTick; // uint tick stored in a long for Interlocked

    public static void SetMouseEvents(bool enabled)
    {
        lock (Gate)
        {
            _emitMouse = enabled;
            UpdateHook();
        }
    }

    public static void SetInputWatch(bool enabled)
    {
        lock (Gate)
        {
            _watchInput = enabled;
            UpdateHook();
            if (enabled && _pollThread == null)
            {
                _pollThread = new Thread(PollLoop) { IsBackground = true, Name = "input-watch" };
                _pollThread.Start();
            }
        }
    }

    public static (bool Mouse, bool InputWatch) State => (_emitMouse, _watchInput);

    // The hook runs while either feature is on: input_watch needs mouse timestamps to tell
    // mouse input apart from keyboard input.
    private static void UpdateHook()
    {
        bool want = _emitMouse || _watchInput;
        if (want && _thread == null) StartHook();
        else if (!want && _thread != null) StopHook();
    }

    private static void StartHook()
    {
        string? error = null;
        using var ready = new ManualResetEventSlim();
        var t = new Thread(() =>
        {
            _threadId = GetCurrentThreadId();
            var hook = SetWindowsHookEx(WH_MOUSE_LL, Proc, GetModuleHandle(null), 0);
            if (hook == IntPtr.Zero) error = $"SetWindowsHookEx failed ({Marshal.GetLastWin32Error()})";
            ready.Set();
            if (hook == IntPtr.Zero) return;
            try
            {
                while (GetMessage(out _, IntPtr.Zero, 0, 0) > 0) { }
            }
            finally { UnhookWindowsHookEx(hook); }
        }) { IsBackground = true, Name = "mouse-hook" };
        t.Start();
        ready.Wait();
        if (error != null) throw new HelperException("hook_failed", error);
        _thread = t;
    }

    private static void StopHook()
    {
        PostThreadMessage(_threadId, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
        _thread!.Join(1000);
        _thread = null;
    }

    private static int Dist(POINT a, POINT b) => Math.Max(Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y));

    private static IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var info = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
            if ((IntPtr)(long)info.dwExtraInfo.ToUInt64() != Input.Signature)
            {
                Interlocked.Exchange(ref _lastMouseTick, info.time);
                if (_emitMouse) Handle((int)wParam, info);
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private static void Handle(int msg, MSLLHOOKSTRUCT info)
    {
        var pt = info.pt;
        switch (msg)
        {
            case WM_LBUTTONDOWN:
                _downPt = pt;
                Output.Event("mouse_down", new { X = pt.X, Y = pt.Y, Button = "left" });
                break;
            case WM_RBUTTONDOWN:
            case WM_MBUTTONDOWN:
            case WM_XBUTTONDOWN:
                Output.Event("mouse_down", new { X = pt.X, Y = pt.Y, Button = msg == WM_RBUTTONDOWN ? "right" : "other" });
                break;
            case WM_LBUTTONUP:
            {
                bool drag = Dist(pt, _downPt) > DragThresholdPx;
                bool dbl = !drag && _lastUpTime != 0
                    && info.time - _lastUpTime <= GetDoubleClickTime()
                    && Dist(pt, _lastUpPt) <= DragThresholdPx;
                _lastUpTime = drag ? 0 : info.time;
                _lastUpPt = pt;
                Output.Event("mouse_up", new { X = pt.X, Y = pt.Y, Drag = drag, Double = dbl });
                break;
            }
            case WM_MOUSEWHEEL:
            case WM_MOUSEHWHEEL:
                if (info.time - _lastWheelTime >= WheelThrottleMs)
                {
                    _lastWheelTime = info.time;
                    Output.Event("wheel");
                }
                break;
        }
    }

    private static void PollLoop()
    {
        var lii = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
        GetLastInputInfo(ref lii);
        uint seen = lii.dwTime;
        uint? pending = null;

        while (true)
        {
            Thread.Sleep(PollMs);
            if (!_watchInput) { pending = null; continue; }
            if (!GetLastInputInfo(ref lii)) continue;

            // Judge a new input tick one poll later, so the hook thread has had time to
            // record the matching mouse event if there was one.
            if (pending is uint tick)
            {
                pending = null;
                uint mouse = (uint)Interlocked.Read(ref _lastMouseTick);
                long sinceInjected = Environment.TickCount64 - Interlocked.Read(ref Input.LastInjectedTick);
                bool fromMouse = (int)(tick - mouse) <= MouseTickToleranceMs;
                if (!fromMouse && sinceInjected > InjectedQuietMs) Output.Event("keyboard_activity");
            }
            if (lii.dwTime != seen)
            {
                seen = lii.dwTime;
                pending = seen;
            }
        }
    }
}
