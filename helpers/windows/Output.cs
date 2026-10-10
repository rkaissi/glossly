using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Glossly.Helper;

/// <summary>
/// Single writer for stdout. Responses and events are queued and written by one thread, so
/// lines never interleave and the mouse hook callback never blocks on a full pipe.
/// </summary>
internal static class Output
{
    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
    };

    private static readonly BlockingCollection<string> Queue = new();
    private static readonly Thread Writer = new(Run) { IsBackground = true, Name = "stdout-writer" };

    public static void Start() => Writer.Start();

    private static void Run()
    {
        using var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { NewLine = "\n" };
        foreach (var line in Queue.GetConsumingEnumerable())
        {
            stdout.WriteLine(line);
            stdout.Flush();
        }
    }

    public static void Ok(JsonNode? id, object? result)
    {
        var o = new JsonObject
        {
            ["id"] = id?.DeepClone(),
            ["ok"] = true,
            ["result"] = JsonSerializer.SerializeToNode(result, Json),
        };
        Queue.Add(o.ToJsonString(Json));
    }

    public static void Error(JsonNode? id, string code, string message)
    {
        var o = new JsonObject
        {
            ["id"] = id?.DeepClone(),
            ["ok"] = false,
            ["error"] = new JsonObject { ["code"] = code, ["message"] = message },
        };
        Queue.Add(o.ToJsonString(Json));
    }

    public static void Event(string name, object? fields = null)
    {
        var o = fields == null ? new JsonObject() : JsonSerializer.SerializeToNode(fields, Json)!.AsObject();
        o.Insert(0, "event", name);
        Queue.Add(o.ToJsonString(Json));
    }

    /// <summary>Waits briefly for queued lines to be written before the process exits.</summary>
    public static void Drain(int timeoutMs = 500)
    {
        Queue.CompleteAdding();
        Writer.Join(timeoutMs);
    }
}
