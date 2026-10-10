using System.Drawing;
using System.Diagnostics;
using static Glossly.Helper.Win32;

namespace Glossly.Helper;

internal sealed record BaselineResult(bool Available, List<Popup> Popups, long AgeMs, long Ms);

/// <summary>
/// The obstacles on screen at each left mouse-down: every popup-like window screen-wide, plus
/// the toolbar probes around the press point. A selection toolbar only appears after the press,
/// so the app ignores anything that matches this snapshot. It is taken on its own thread, so it
/// never delays requests, and the hook callback only hands it the point.
/// </summary>
internal static class Baseline
{
    private static readonly object Gate = new();
    private static readonly AutoResetEvent Signal = new(false);
    private static Uia? _uia;

    // Guarded by Gate.
    private static POINT _pendingPt;
    private static int _requested;
    private static int _taken;
    private static List<Popup>? _popups;
    private static long _takenTick;
    private static long _ms;
    private static POINT _lastPressPt;
    private static uint _lastPressTime;

    public static void Start(Uia uia)
    {
        _uia = uia;
        new Thread(Run) { IsBackground = true, Name = "baseline" }.Start();
    }

    /// <summary>Called from the mouse hook on a left press. Never blocks.</summary>
    public static void OnPress(POINT pt, uint time)
    {
        lock (Gate)
        {
            // The second press of a double-click keeps the first press's snapshot: the app may
            // already be showing its toolbar for the first click's word.
            bool second = _requested > 0 && time - _lastPressTime <= GetDoubleClickTime()
                && Math.Max(Math.Abs(pt.X - _lastPressPt.X), Math.Abs(pt.Y - _lastPressPt.Y)) <= 4;
            _lastPressPt = pt;
            _lastPressTime = time;
            if (second) return;
            _pendingPt = pt;
            _requested++;
        }
        Signal.Set();
    }

    private static void Run()
    {
        while (true)
        {
            Signal.WaitOne();
            POINT pt;
            int seq;
            lock (Gate)
            {
                if (_taken == _requested) continue;
                pt = _pendingPt;
                seq = _requested;
            }
            var sw = Stopwatch.StartNew();
            List<Popup> popups;
            try
            {
                popups = _uia!.PopupsNear(new Rect(pt.X - 1, pt.Y - 10, 2, 20), new HashSet<int>(), allWindows: true, ProbesAround(pt));
            }
            catch
            {
                popups = new List<Popup>();
            }
            lock (Gate)
            {
                _popups = popups;
                _taken = seq;
                _takenTick = Environment.TickCount64;
                _ms = sw.ElapsedMilliseconds;
                Monitor.PulseAll(Gate);
            }
        }
    }

    /// <summary>
    /// The check after mouse-up probes 18 px outside the selected line's box, which is not known
    /// at the press: the press can be anywhere inside a line up to about 50 px tall. So probe a
    /// column above and below the press point that covers every such spot, or static chrome next
    /// to the first or last line (Notepad's menu bar) would look new. This runs off the request
    /// thread, so the extra probes cost nothing there.
    /// </summary>
    private static Point[] ProbesAround(POINT pt)
    {
        var points = new List<Point>();
        foreach (int dy in new[] { 20, 30, 40, 52, 66 })
        {
            points.Add(new Point(pt.X, pt.Y - dy));
            points.Add(new Point(pt.X, pt.Y + dy));
        }
        return points.ToArray();
    }

    /// <summary>
    /// The snapshot for the latest press, waiting up to <paramref name="waitMs"/> if it is still
    /// being taken. Not available before the first press or if the wait ran out.
    /// </summary>
    public static BaselineResult Get(HashSet<int> excludePids, int waitMs)
    {
        var deadline = Environment.TickCount64 + waitMs;
        lock (Gate)
        {
            while (_taken < _requested)
            {
                long left = deadline - Environment.TickCount64;
                if (left <= 0) break;
                Monitor.Wait(Gate, (int)left);
            }
            if (_popups == null || _taken < _requested) return new BaselineResult(false, new List<Popup>(), 0, 0);
            var popups = _popups.Where(p => !excludePids.Contains(p.Pid)).ToList();
            return new BaselineResult(true, popups, Environment.TickCount64 - _takenTick, _ms);
        }
    }
}
