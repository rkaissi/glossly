namespace Glossly.Helper;

/// <summary>An error with a stable code that is sent back to the app as {code, message}.</summary>
internal sealed class HelperException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
