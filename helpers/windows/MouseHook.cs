using System.Runtime.InteropServices;
using static Glossly.Helper.Win32;

namespace Glossly.Helper;

/// <summary>
/// Mouse-only low-level hook, plus a keyboard-activity signal derived from GetLastInputInfo.
/// There is deliberately no keyboard hook: the app learns that "some non-mouse input happened",
/// never which keys were pressed. Touchpad, touchscreen, and pen input move the last-input time
/// without a mouse event (a resting finger, a two-finger scroll), so Raw Input tells the helper
/// when those devices sent something, and they count as the mouse (decision 56). Raw Input says
/// which device, never what it reported.
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
    private static readonly WinEventProc ForegroundProc = OnForeground;
    private static Thread? _thread;
    private static uint _threadId;
    private static IntPtr _touch; // the Raw Input window, made and destroyed on the hook thread

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

    /// <summary>Touch, pen, and touchpad input is registered with Raw Input and counts as the mouse.</summary>
    public static bool TouchWatched => _touch != IntPtr.Zero;

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
            else _touch = WatchTouch();
            ready.Set();
            if (hook == IntPtr.Zero) return;
            // Foreground changes arrive on this thread's message loop too (out of context).
            var fgHook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, ForegroundProc, 0, 0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
            try
            {
                while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
                {
                    // Touch counts as the mouse: only the time is kept.
                    if (msg.message == WM_INPUT) Interlocked.Exchange(ref _lastMouseTick, (uint)Environment.TickCount);
                    DispatchMessage(ref msg);
                }
            }
            finally
            {
                if (_touch != IntPtr.Zero) DestroyWindow(_touch);
                _touch = IntPtr.Zero;
                if (fgHook != IntPtr.Zero) UnhookWinEvent(fgHook);
                UnhookWindowsHookEx(hook);
            }
        }) { IsBackground = true, Name = "mouse-hook" };
        t.Start();
        ready.Wait();
        if (error != null) throw new HelperException("hook_failed", error);
        _thread = t;
    }

    /// <summary>
    /// A message-only window that receives Raw Input from touchpads, touchscreens, and pens, even
    /// in the background. Zero when it can't be made: the old behavior stays (touch reads as
    /// keyboard activity), which is no worse than before.
    /// </summary>
    private static IntPtr WatchTouch()
    {
        var hwnd = CreateWindowEx(0, "Message", null, 0, 0, 0, 0, 0, HWND_MESSAGE, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (hwnd == IntPtr.Zero) return IntPtr.Zero;
        var devices = new[] { HID_USAGE_TOUCH_PAD, HID_USAGE_TOUCH_SCREEN, HID_USAGE_PEN }
            .Select(u => new RAWINPUTDEVICE { usUsagePage = HID_USAGE_PAGE_DIGITIZER, usUsage = u, dwFlags = RIDEV_INPUTSINK, hwndTarget = hwnd })
            .ToArray();
        if (!RegisterRawInputDevices(devices, (uint)devices.Length, (uint)Marshal.SizeOf<RAWINPUTDEVICE>()))
        {
            DestroyWindow(hwnd);
            return IntPtr.Zero;
        }
        return hwnd;
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
                Baseline.OnPress(pt, info.time);
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

    /// <summary>Another window came to the front. Reported only while input_watch is on.</summary>
    private static void OnForeground(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        if (!_watchInput || hwnd == IntPtr.Zero) return;
        GetWindowThreadProcessId(hwnd, out uint pid);
        Output.Event("foreground", new { Handle = hwnd.ToInt64(), Pid = (int)pid });
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
