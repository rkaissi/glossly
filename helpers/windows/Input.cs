using System.Runtime.InteropServices;
using static Glossly.Helper.Win32;

namespace Glossly.Helper;

internal static class Input
{
    // Marks our synthetic input so it can be told apart from the user's.
    public static readonly IntPtr Signature = new(0x474C5359);

    private static readonly ushort[] Modifiers = { VK_MENU, VK_CONTROL, VK_SHIFT, VK_LWIN, VK_RWIN, VK_SPACE };

    private static INPUT Key(ushort vk, bool up) => new()
    {
        type = INPUT_KEYBOARD,
        U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, dwFlags = up ? KEYEVENTF_KEYUP : 0, dwExtraInfo = Signature } },
    };

    private static void Send(params INPUT[] inputs) => SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());

    private static bool IsDown(ushort vk) => (GetAsyncKeyState(vk) & 0x8000) != 0;

    /// <summary>
    /// The hotkey (Ctrl+Alt+Space) is usually still held when we act. Wait briefly for the
    /// user to let go; if they don't, release the keys ourselves so Ctrl+C is not Ctrl+Alt+C.
    /// </summary>
    public static void ReleaseModifiers(int waitMs = 350)
    {
        var deadline = Environment.TickCount64 + waitMs;
        while (Environment.TickCount64 < deadline && Modifiers.Any(IsDown)) Thread.Sleep(10);

        var held = Modifiers.Where(IsDown).ToList();
        if (held.Count == 0) return;

        var inputs = new List<INPUT>();
        // An unassigned key between Alt down and Alt up stops apps from opening their menu bar.
        if (held.Contains(VK_MENU)) { inputs.Add(Key(VK_NONAME_DUMMY, false)); inputs.Add(Key(VK_NONAME_DUMMY, true)); }
        foreach (var vk in held) inputs.Add(Key(vk, true));
        Send(inputs.ToArray());
        Thread.Sleep(15);
    }

    public static void Chord(ushort modifier, ushort key)
    {
        Send(Key(modifier, false), Key(key, false), Key(key, true), Key(modifier, true));
    }

    /// <summary>Lets this process take the foreground (Windows only allows it right after input).</summary>
    public static void TapDummyKey()
    {
        Send(Key(VK_NONAME_DUMMY, false), Key(VK_NONAME_DUMMY, true));
    }
}
