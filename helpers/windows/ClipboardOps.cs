using System.Runtime.InteropServices;
using static Glossly.Helper.Win32;

namespace Glossly.Helper;

/// <summary>
/// Clipboard access with a full snapshot and restore. Every public method restores the
/// user's original clipboard in a finally block, including on errors.
/// </summary>
internal static class ClipboardOps
{
    // GDI handle formats cannot be copied as raw memory; CF_DIB/CF_DIBV5 carry the same image.
    private static readonly HashSet<uint> SkipFormats = new() { 2, 3, 9, 14, 0x0080, 0x0082, 0x0083, 0x008E };

    private sealed record Snapshot(List<(uint Format, byte[] Data)> Entries);

    private static readonly Lazy<uint[]> PrivacyFormats = new(() => new[]
    {
        RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing"),
        RegisterClipboardFormat("CanIncludeInClipboardHistory"),
        RegisterClipboardFormat("CanUploadToCloudClipboard"),
    });

    private static T OnSta<T>(Func<T> fn)
    {
        T? result = default;
        Exception? error = null;
        var t = new Thread(() =>
        {
            try { result = fn(); } catch (Exception e) { error = e; }
        });
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();
        if (error != null) throw error;
        return result!;
    }

    private static void Open()
    {
        for (int i = 0; i < 20; i++)
        {
            if (OpenClipboard(IntPtr.Zero)) return;
            Thread.Sleep(10);
        }
        throw new HelperException("clipboard_busy", "Could not open the clipboard");
    }

    private static Snapshot Take()
    {
        var entries = new List<(uint, byte[])>();
        Open();
        try
        {
            uint fmt = 0;
            while ((fmt = EnumClipboardFormats(fmt)) != 0)
            {
                if (SkipFormats.Contains(fmt)) continue;
                var h = GetClipboardData(fmt);
                if (h == IntPtr.Zero) continue;
                var size = (long)GlobalSize(h);
                if (size <= 0 || size > 64 * 1024 * 1024) continue;
                var p = GlobalLock(h);
                if (p == IntPtr.Zero) continue;
                try
                {
                    var bytes = new byte[size];
                    Marshal.Copy(p, bytes, 0, (int)size);
                    entries.Add((fmt, bytes));
                }
                finally { GlobalUnlock(h); }
            }
        }
        finally { CloseClipboard(); }
        return new Snapshot(entries);
    }

    private static void SetBytes(uint fmt, byte[] data)
    {
        var h = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)Math.Max(data.Length, 1));
        var p = GlobalLock(h);
        Marshal.Copy(data, 0, p, data.Length);
        GlobalUnlock(h);
        if (SetClipboardData(fmt, h) == IntPtr.Zero) GlobalFree(h);
    }

    private static void Restore(Snapshot snap)
    {
        Open();
        try
        {
            EmptyClipboard();
            foreach (var (fmt, data) in snap.Entries) SetBytes(fmt, data);
        }
        finally { CloseClipboard(); }
    }

    private static string? ReadText()
    {
        Open();
        try
        {
            var h = GetClipboardData(CF_UNICODETEXT);
            if (h == IntPtr.Zero) return null;
            var p = GlobalLock(h);
            try { return Marshal.PtrToStringUni(p); }
            finally { GlobalUnlock(h); }
        }
        finally { CloseClipboard(); }
    }

    private static void WriteText(string text)
    {
        Open();
        try
        {
            EmptyClipboard();
            SetBytes(CF_UNICODETEXT, System.Text.Encoding.Unicode.GetBytes(text + "\0"));
            // Keep our temporary clipboard content out of Win+V history and cloud sync.
            var formats = PrivacyFormats.Value;
            SetBytes(formats[0], new byte[] { 0 });
            SetBytes(formats[1], BitConverter.GetBytes(0));
            SetBytes(formats[2], BitConverter.GetBytes(0));
        }
        finally { CloseClipboard(); }
    }

    public static (string Text, bool Restored) CopySelection(int timeoutMs) => OnSta(() =>
    {
        Input.ReleaseModifiers();
        var snap = Take();
        string text = "";
        bool restored = false;
        try
        {
            uint before = GetClipboardSequenceNumber();
            Input.Chord(VK_CONTROL, VK_C);
            var deadline = Environment.TickCount64 + timeoutMs;
            while (Environment.TickCount64 < deadline && GetClipboardSequenceNumber() == before) Thread.Sleep(5);
            if (GetClipboardSequenceNumber() != before)
            {
                Thread.Sleep(10);
                text = ReadText() ?? "";
            }
        }
        finally
        {
            try { Restore(snap); restored = true; }
            catch (Exception e) { Console.Error.WriteLine($"clipboard restore failed: {e.GetType().Name}"); }
        }
        return (text, restored);
    });

    public static bool PasteText(string text, int settleMs) => OnSta(() =>
    {
        Input.ReleaseModifiers();
        var snap = Take();
        try
        {
            WriteText(text);
            Input.Chord(VK_CONTROL, VK_V);
            // Apps read the clipboard asynchronously after Ctrl+V; restoring too early pastes the old content.
            Thread.Sleep(settleMs);
        }
        finally
        {
            Restore(snap);
        }
        return true;
    });
}
