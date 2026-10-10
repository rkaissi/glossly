using System.Diagnostics;
using System.Drawing;
using System.Text.Json.Serialization;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.Core.Patterns;
using FlaUI.UIA3;
using static Glossly.Helper.Win32;

namespace Glossly.Helper;

internal sealed record Rect(int X, int Y, int W, int H)
{
    public static Rect From(Rectangle r) => new(r.X, r.Y, r.Width, r.Height);
    [JsonIgnore] public bool IsEmpty => W <= 0 || H <= 0;
}

internal sealed record SelectionResult(string Text, string Method, Rect? Bounds, bool IsEditable, bool IsPassword, string ControlType, bool Truncated);
internal sealed record ContextResult(string Before, string After);
internal sealed record ContainerResult(string Text, int SelectionStart, int SelectionLength, string Source, string ContainerType);
internal sealed record Popup(string Source, string Kind, Rect Bounds);

/// <summary>
/// UI Automation reads. Must be used from one MTA thread (the main thread, which processes
/// requests one at a time). Never logs any text it reads.
/// </summary>
internal sealed class Uia : IDisposable
{
    private const int MaxWalk = 25;
    private const int PopupBudgetMs = 80;

    private readonly UIA3Automation _automation;
    private readonly ITreeWalker _walker;
    private readonly HashSet<IntPtr> _nudged = new();

    public Uia()
    {
        _automation = new UIA3Automation
        {
            ConnectionTimeout = TimeSpan.FromMilliseconds(1000),
            TransactionTimeout = TimeSpan.FromMilliseconds(1000),
        };
        _walker = _automation.TreeWalkerFactory.GetControlViewWalker();
    }

    public void Dispose() => _automation.Dispose();

    private sealed record Located(AutomationElement Element, ITextPattern Pattern, ITextRange Range, AutomationElement Origin);

    // ---- selection ----

    public SelectionResult Selection(int maxChars)
    {
        bool justNudged = NudgeChromium(GetForegroundWindow());
        var result = ReadSelection(maxChars);
        if (justNudged && result.Text.Length == 0 && !result.IsPassword)
        {
            // Chromium builds its accessibility tree on first contact; give it one more try.
            Thread.Sleep(150);
            result = ReadSelection(maxChars);
        }
        return result;
    }

    private SelectionResult ReadSelection(int maxChars)
    {
        var focused = Safe(() => _automation.FocusedElement());
        if (focused != null && IsPassword(focused))
            return new SelectionResult("", "uia", null, true, true, TypeName(focused), false);

        var loc = Locate(focused, requireText: true) ?? LocateAtCursor(requireText: true);
        if (loc == null)
        {
            var origin = focused;
            return new SelectionResult("", "uia", null, origin != null && IsEditable(origin), false, origin != null ? TypeName(origin) : "none", false);
        }

        if (IsPassword(loc.Element) || IsPassword(loc.Origin))
            return new SelectionResult("", "uia", null, true, true, TypeName(loc.Element), false);

        var text = loc.Range.GetText(maxChars + 1) ?? "";
        bool truncated = text.Length > maxChars;
        if (truncated) text = text[..maxChars];

        return new SelectionResult(
            text,
            "uia",
            Bounds(loc.Range),
            IsEditable(loc.Origin) || IsEditable(loc.Element),
            false,
            TypeName(loc.Element),
            truncated);
    }

    public bool FocusedIsPassword()
    {
        var focused = Safe(() => _automation.FocusedElement());
        return focused != null && IsPassword(focused);
    }

    /// <summary>
    /// Walks up from <paramref name="start"/> to the nearest element with a TextPattern and,
    /// if <paramref name="requireText"/>, a non-empty selection.
    /// </summary>
    private Located? Locate(AutomationElement? start, bool requireText)
    {
        var el = start;
        for (int i = 0; el != null && i < MaxWalk; i++)
        {
            var pattern = Safe(() => el.Patterns.Text.PatternOrDefault);
            if (pattern != null)
            {
                var ranges = Safe(() => pattern.GetSelection());
                if (ranges is { Length: > 0 })
                {
                    var range = ranges[0];
                    if (!requireText || !string.IsNullOrEmpty(Safe(() => range.GetText(1))))
                        return new Located(el, pattern, range, start!);
                }
            }
            var current = el;
            el = Safe(() => _walker.GetParent(current));
        }
        return null;
    }

    private Located? LocateAtCursor(bool requireText)
    {
        GetCursorPos(out var p);
        var at = Safe(() => _automation.FromPoint(new Point(p.X, p.Y)));
        return at == null ? null : Locate(at, requireText);
    }

    private Located? LocateCurrent()
    {
        var focused = Safe(() => _automation.FocusedElement());
        if (focused != null && IsPassword(focused)) throw new HelperException("password_field", "Focused element is a password field");
        var loc = Locate(focused, requireText: true) ?? LocateAtCursor(requireText: true);
        if (loc != null && (IsPassword(loc.Element) || IsPassword(loc.Origin)))
            throw new HelperException("password_field", "Selection is in a password field");
        return loc;
    }

    // ---- tier 1 context ----

    public ContextResult Context(int before, int after)
    {
        var loc = LocateCurrent() ?? throw new HelperException("no_selection", "No UI Automation selection found");
        return ContextAround(loc.Range, before, after, null);
    }

    // Providers may count "\r\n" as one character unit, so the moved ranges are read whole and
    // trimmed here rather than with GetText(n).
    private static ContextResult ContextAround(ITextRange sel, int before, int after, ITextRange? clip)
    {
        string b = "", a = "";
        if (before > 0)
        {
            var r = sel.Clone();
            r.MoveEndpointByRange(TextPatternRangeEndpoint.End, sel, TextPatternRangeEndpoint.Start);
            r.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, -before);
            if (clip != null && r.CompareEndpoints(TextPatternRangeEndpoint.Start, clip, TextPatternRangeEndpoint.Start) < 0)
                r.MoveEndpointByRange(TextPatternRangeEndpoint.Start, clip, TextPatternRangeEndpoint.Start);
            b = r.GetText(-1) ?? "";
            if (b.Length > before) b = b[^before..];
        }
        if (after > 0)
        {
            var r = sel.Clone();
            r.MoveEndpointByRange(TextPatternRangeEndpoint.Start, sel, TextPatternRangeEndpoint.End);
            r.MoveEndpointByUnit(TextPatternRangeEndpoint.End, TextUnit.Character, after);
            if (clip != null && r.CompareEndpoints(TextPatternRangeEndpoint.End, clip, TextPatternRangeEndpoint.End) > 0)
                r.MoveEndpointByRange(TextPatternRangeEndpoint.End, clip, TextPatternRangeEndpoint.End);
            a = r.GetText(-1) ?? "";
            if (a.Length > after) a = a[..after];
        }
        return new ContextResult(b, a);
    }

    // ---- tier 2 context ----

    public ContainerResult ContextContainer(int maxChars)
    {
        var loc = LocateCurrent() ?? throw new HelperException("no_selection", "No UI Automation selection found");
        var selText = loc.Range.GetText(maxChars) ?? "";
        int budget = Math.Max(0, maxChars - selText.Length);

        var (clip, type) = FindContainerRange(loc);
        if (clip != null)
        {
            // Center the selection, then give any side's unused share to the other side.
            int half = budget / 2;
            var first = ContextAround(loc.Range, half, half, clip);
            int spareBefore = half - first.Before.Length;
            int spareAfter = half - first.After.Length;
            var ctx = first;
            if (spareBefore > 0 && first.After.Length == half)
                ctx = ContextAround(loc.Range, first.Before.Length, half + spareBefore, clip);
            else if (spareAfter > 0 && first.Before.Length == half)
                ctx = ContextAround(loc.Range, half + spareAfter, first.After.Length, clip);
            return new ContainerResult(ctx.Before + selText + ctx.After, ctx.Before.Length, selText.Length, "container", type);
        }

        var t1 = ContextAround(loc.Range, 500, 500, null);
        return new ContainerResult(t1.Before + selText + t1.After, t1.Before.Length, selText.Length, "tier1", "none");
    }

    private (ITextRange? Range, string Type) FindContainerRange(Located loc)
    {
        var start = Safe(() => loc.Range.GetEnclosingElement());
        var el = start;
        for (int i = 0; el != null && i < MaxWalk; i++)
        {
            var ct = Safe(() => el.ControlType);
            if (ct is ControlType.Document or ControlType.List or ControlType.Pane)
            {
                var current = el;
                ITextRange? range = _automation.Compare(current, loc.Element)
                    ? Safe(() => loc.Pattern.DocumentRange)
                    : Safe(() => loc.Pattern.RangeFromChild(current));
                if (range != null && !string.IsNullOrEmpty(Safe(() => range.GetText(1))))
                    return (range, ct.ToString()!.ToLowerInvariant());
            }
            if (_automation.Compare(el, loc.Element)) break;
            var cur = el;
            el = Safe(() => _walker.GetParent(cur));
        }
        // The text provider itself is the best remaining container (Notepad, a plain document).
        var doc = Safe(() => loc.Pattern.DocumentRange);
        return doc != null ? (doc, "document") : (null, "none");
    }

    // ---- popups and toolbars near the selection ----

    public List<Popup> PopupsNear(Rect sel, HashSet<int> excludePids)
    {
        var sw = Stopwatch.StartNew();
        var found = new List<Popup>();
        var fg = GetForegroundWindow();
        var region = new Rect(sel.X - 200, sel.Y - 160, sel.W + 400, sel.H + 320);

        EnumWindows((h, _) =>
        {
            if (h == fg || !IsWindowVisible(h) || IsCloaked(h)) return true;
            long style = (long)GetWindowLongPtr(h, GWL_STYLE);
            long ex = (long)GetWindowLongPtr(h, GWL_EXSTYLE);
            bool popupLike = (style & WS_POPUP) != 0 || (ex & (WS_EX_TOOLWINDOW | WS_EX_TOPMOST)) != 0;
            if (!popupLike) return true;
            var cls = ClassName(h);
            if (cls is "Shell_TrayWnd" or "Shell_SecondaryTrayWnd" or "Progman" or "WorkerW") return true;
            if (!GetWindowRect(h, out var r)) return true;
            var rect = new Rect(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
            if (rect.W < 8 || rect.H < 8 || rect.W > 1400 || rect.H > 700) return true;
            if (!Intersects(rect, region)) return true;
            GetWindowThreadProcessId(h, out uint pid);
            if (excludePids.Contains((int)pid)) return true;
            found.Add(new Popup("window", (ex & WS_EX_TOOLWINDOW) != 0 ? "tool_window" : "popup_window", rect));
            return true;
        }, IntPtr.Zero);

        // In-page toolbars (Google Docs, Notion, web apps) are not separate windows.
        int cx = sel.X + sel.W / 2;
        var probes = new[]
        {
            new Point(cx, sel.Y - 18), new Point(cx, sel.Y + sel.H + 18),
            new Point(cx, sel.Y - 42), new Point(cx, sel.Y + sel.H + 42),
            new Point(sel.X + 10, sel.Y - 18), new Point(sel.X + sel.W - 10, sel.Y + sel.H + 18),
        };
        var seen = new HashSet<Rect>(found.Select(f => f.Bounds));
        foreach (var p in probes)
        {
            if (sw.ElapsedMilliseconds > PopupBudgetMs) break;
            var hit = Safe(() => _automation.FromPoint(p));
            var el = hit;
            for (int i = 0; el != null && i < 6; i++)
            {
                var ct = Safe(() => el.ControlType);
                string? kind = ct switch
                {
                    ControlType.ToolBar => "toolbar",
                    ControlType.Menu => "menu",
                    ControlType.MenuBar => "menu",
                    ControlType.ToolTip => "tooltip",
                    _ => null,
                };
                if (kind != null)
                {
                    var b = Safe(() => el.BoundingRectangle);
                    var rect = Rect.From(b);
                    if (!rect.IsEmpty && rect.H < 300 && seen.Add(rect)) found.Add(new Popup("uia", kind, rect));
                    break;
                }
                if (ct is ControlType.Window or ControlType.Document) break;
                var cur = el;
                el = Safe(() => _walker.GetParent(cur));
            }
        }
        return found;
    }

    private static bool Intersects(Rect a, Rect b) =>
        a.X < b.X + b.W && b.X < a.X + a.W && a.Y < b.Y + b.H && b.Y < a.Y + a.H;

    // ---- helpers ----

    /// <summary>
    /// Chromium and Electron apps only build their accessibility tree once they see an
    /// accessibility client. WM_GETOBJECT is the documented nudge. Returns true on first nudge.
    /// </summary>
    private bool NudgeChromium(IntPtr fg)
    {
        if (fg == IntPtr.Zero || !ClassName(fg).StartsWith("Chrome_WidgetWin_")) return false;
        if (!_nudged.Add(fg)) return false;
        if (_nudged.Count > 256) { _nudged.Clear(); _nudged.Add(fg); }

        void Nudge(IntPtr h)
        {
            SendMessageTimeout(h, WM_GETOBJECT, UIntPtr.Zero, OBJID_CLIENT, SMTO_ABORTIFHUNG, 100, out _);
            SendMessageTimeout(h, WM_GETOBJECT, UIntPtr.Zero, UIA_ROOT_OBJECT_ID, SMTO_ABORTIFHUNG, 100, out _);
        }
        Nudge(fg);
        EnumChildWindows(fg, (h, _) =>
        {
            if (ClassName(h) == "Chrome_RenderWidgetHostHWND") Nudge(h);
            return true;
        }, IntPtr.Zero);
        return true;
    }

    private static Rect? Bounds(ITextRange range)
    {
        var rects = Safe(() => range.GetBoundingRectangles());
        if (rects == null || rects.Length == 0) return null;
        int l = int.MaxValue, t = int.MaxValue, r = int.MinValue, b = int.MinValue;
        foreach (var x in rects)
        {
            if (x.Width <= 0 && x.Height <= 0) continue;
            l = Math.Min(l, x.Left); t = Math.Min(t, x.Top);
            r = Math.Max(r, x.Right); b = Math.Max(b, x.Bottom);
        }
        return l == int.MaxValue ? null : new Rect(l, t, r - l, b - t);
    }

    private static bool IsPassword(AutomationElement el) =>
        Safe(() => el.Properties.IsPassword.ValueOrDefault);

    private static bool IsEditable(AutomationElement el)
    {
        if (Safe(() => el.ControlType) == ControlType.Edit) return true;
        var vp = Safe(() => el.Patterns.Value.PatternOrDefault);
        return vp != null && !Safe(() => vp.IsReadOnly.ValueOrDefault, true);
    }

    private static string TypeName(AutomationElement el) =>
        (Safe(() => el.ControlType.ToString()) ?? "unknown").ToLowerInvariant();

    private static T? Safe<T>(Func<T> fn, T? fallback = default)
    {
        try { return fn(); }
        catch (Exception e) when (e is not HelperException) { return fallback; }
    }
}
