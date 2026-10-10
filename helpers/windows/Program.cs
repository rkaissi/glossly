using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Glossly.Helper;

/// <summary>
/// JSON lines over stdin/stdout. One request per line, handled one at a time, one response
/// line per request. Unsolicited events carry "event" and no "id". See helpers/protocol.md.
/// Exits when stdin closes. Never writes selection or context text to stderr.
/// </summary>
internal static class Program
{
    public const string Version = "0.1.0";
    public const int ProtocolVersion = 1;

    private static int Main()
    {
        Output.Start();
        using var uia = new Uia();
        Baseline.Start(uia);
        using var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));

        Output.Event("ready", new { Version, Protocol = ProtocolVersion, Pid = Environment.ProcessId });

        string? line;
        while ((line = stdin.ReadLine()) != null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonNode? id = null;
            string cmd = "?";
            try
            {
                var req = JsonNode.Parse(line) as JsonObject ?? throw new HelperException("bad_request", "Request must be a JSON object");
                id = req["id"];
                cmd = req["cmd"]?.GetValue<string>() ?? throw new HelperException("bad_request", "Missing cmd");
                Output.Ok(id, Dispatch(uia, cmd, req));
            }
            catch (HelperException e)
            {
                Output.Error(id, e.Code, e.Message);
            }
            catch (JsonException)
            {
                Output.Error(id, "bad_request", "Invalid JSON");
            }
            catch (InvalidOperationException)
            {
                Output.Error(id, "bad_request", "An argument has the wrong type");
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"{cmd}: {e.GetType().Name}");
                Output.Error(id, "internal", e.GetType().Name);
            }
        }

        MouseHook.SetMouseEvents(false);
        MouseHook.SetInputWatch(false);
        Output.Drain();
        return 0;
    }

    private static object? Dispatch(Uia uia, string cmd, JsonObject req) => cmd switch
    {
        "ping" => new { Pong = true, Version, Protocol = ProtocolVersion },
        "selection" => uia.Selection(Int(req, "max_chars", 20_000, 1, 200_000)),
        "context" => uia.Context(Int(req, "before", 500, 0, 5_000), Int(req, "after", 500, 0, 5_000)),
        "context_container" => uia.ContextContainer(Int(req, "max_chars", 8_000, 100, 50_000)),
        "foreground" => Focus.Foreground(),
        "popups_near" => new { Popups = uia.PopupsNear(RectArg(req, "bounds"), PidsArg(req, "exclude_pids"), OptBool(req, "all_windows")) },
        "baseline" => Baseline.Get(PidsArg(req, "exclude_pids"), Int(req, "wait_ms", 150, 0, 1_000)),
        "copy_fallback" => CopyFallback(uia, Int(req, "timeout_ms", 120, 10, 2_000)),
        "restore_focus" => Focus.Restore(Long(req, "handle")),
        "window_corners" => Focus.Corners(Long(req, "handle"), Str(req, "corners")),
        "paste" => Paste(Str(req, "text"), Int(req, "settle_ms", 250, 0, 2_000)),
        "mouse_hook" => SetMouse(Bool(req, "enabled")),
        "input_watch" => SetInputWatch(Bool(req, "enabled")),
        _ => throw new HelperException("unknown_command", $"Unknown command: {cmd}"),
    };

    private static object CopyFallback(Uia uia, int timeoutMs)
    {
        if (uia.FocusedIsPassword()) throw new HelperException("password_field", "Focused element is a password field");
        var (text, restored) = ClipboardOps.CopySelection(timeoutMs);
        return new { Text = text, Method = "copy", ClipboardRestored = restored };
    }

    private static object Paste(string text, int settleMs)
    {
        ClipboardOps.PasteText(text, settleMs);
        return new { Pasted = true };
    }

    private static object SetMouse(bool enabled)
    {
        MouseHook.SetMouseEvents(enabled);
        return new { Enabled = enabled };
    }

    private static object SetInputWatch(bool enabled)
    {
        MouseHook.SetInputWatch(enabled);
        return new { Enabled = enabled };
    }

    // ---- argument parsing ----

    private static int Int(JsonObject o, string key, int def, int min, int max)
    {
        var n = o[key];
        if (n == null) return def;
        return Math.Clamp(n.GetValue<int>(), min, max);
    }

    private static long Long(JsonObject o, string key) =>
        o[key]?.GetValue<long>() ?? throw new HelperException("bad_request", $"Missing {key}");

    private static bool Bool(JsonObject o, string key) =>
        o[key]?.GetValue<bool>() ?? throw new HelperException("bad_request", $"Missing {key}");

    private static bool OptBool(JsonObject o, string key) => o[key]?.GetValue<bool>() ?? false;

    private static string Str(JsonObject o, string key) =>
        o[key]?.GetValue<string>() ?? throw new HelperException("bad_request", $"Missing {key}");

    private static Rect RectArg(JsonObject o, string key)
    {
        var b = o[key] as JsonObject ?? throw new HelperException("bad_request", $"Missing {key}");
        int Get(string k) => b[k]?.GetValue<int>() ?? throw new HelperException("bad_request", $"Missing {key}.{k}");
        return new Rect(Get("x"), Get("y"), Get("w"), Get("h"));
    }

    private static HashSet<int> PidsArg(JsonObject o, string key)
    {
        var set = new HashSet<int>();
        if (o[key] is JsonArray arr)
            foreach (var n in arr) if (n != null) set.Add(n.GetValue<int>());
        return set;
    }
}
