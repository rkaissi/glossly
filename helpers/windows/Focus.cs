using System.Diagnostics;
using static Glossly.Helper.Win32;

namespace Glossly.Helper;

internal sealed record ForegroundResult(long Handle, int Pid, string ProcessName, string Title, string ClassName);
internal sealed record RestoreFocusResult(bool Restored, string Method);
internal sealed record WindowCornersResult(bool Applied);

internal static class Focus
{
    public static ForegroundResult Foreground()
    {
        var h = GetForegroundWindow();
        if (h == IntPtr.Zero) throw new HelperException("no_foreground", "No foreground window");
        GetWindowThreadProcessId(h, out uint pid);
        return new ForegroundResult(h.ToInt64(), (int)pid, ProcessName((int)pid), WindowTitle(h), ClassName(h));
    }

    /// <summary>
    /// Lower-case image name with ".exe". Uses the image path, which is cheap; Process.GetProcessById
    /// snapshots every process on the system and is only the fallback.
    /// </summary>
    public static string ProcessName(int pid)
    {
        var h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
        if (h != IntPtr.Zero)
        {
            try
            {
                var sb = new System.Text.StringBuilder(1024);
                uint size = (uint)sb.Capacity;
                if (QueryFullProcessImageName(h, 0, sb, ref size)) return Path.GetFileName(sb.ToString()).ToLowerInvariant();
            }
            finally { CloseHandle(h); }
        }
        try
        {
            using var p = Process.GetProcessById(pid);
            return p.ProcessName.ToLowerInvariant() + ".exe";
        }
        catch { return "unknown"; }
    }

    public static RestoreFocusResult Restore(long handle)
    {
        var h = new IntPtr(handle);
        if (!IsWindow(h)) throw new HelperException("window_gone", "The window no longer exists");
        if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
        if (GetForegroundWindow() == h) return new RestoreFocusResult(true, "already");

        Input.ReleaseModifiers();
        if (SetForegroundWindow(h) && Verify(h)) return new RestoreFocusResult(true, "direct");

        // Windows only lets a process take the foreground right after it received input.
        Input.TapDummyKey();
        if (SetForegroundWindow(h) && Verify(h)) return new RestoreFocusResult(true, "dummy_key");

        var fg = GetForegroundWindow();
        uint fgThread = GetWindowThreadProcessId(fg, out _);
        uint me = GetCurrentThreadId();
        bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
        try
        {
            BringWindowToTop(h);
            SetForegroundWindow(h);
        }
        finally
        {
            if (attached) AttachThreadInput(me, fgThread, false);
        }
        if (Verify(h)) return new RestoreFocusResult(true, "attach_thread_input");
        throw new HelperException("focus_failed", "Could not bring the window to the foreground");
    }

    private static bool Verify(IntPtr h, int timeoutMs = 200)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        while (true)
        {
            if (GetForegroundWindow() == h) return true;
            if (Environment.TickCount64 >= deadline) return false;
            Thread.Sleep(10);
        }
    }

    /// <summary>
    /// Sets DWM's corner preference on one of our own windows. Electron leaves transparent
    /// windows square; with "round", DWM rounds them (Windows 11) and draws its soft shadow.
    /// </summary>
    public static WindowCornersResult Corners(long handle, string corners)
    {
        var h = new IntPtr(handle);
        if (!IsWindow(h)) throw new HelperException("window_gone", "The window no longer exists");
        int pref = corners switch
        {
            "default" => 0,
            "none" => 1,
            "round" => 2,
            "small" => 3,
            _ => throw new HelperException("bad_request", "corners must be default, none, round, or small"),
        };
        return new WindowCornersResult(DwmSetWindowAttribute(h, DWMWA_WINDOW_CORNER_PREFERENCE, ref pref, sizeof(int)) == 0);
    }
}
