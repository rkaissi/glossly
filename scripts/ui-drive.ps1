# Drives the desktop for live UI checks: sends keys and mouse input, takes screenshots.
# Coordinates are physical pixels. Screenshots and the sample file go to $env:TEMP\glossly-live.
#
#   scripts/ui-drive.ps1 notepad            open a sample message in Notepad (a tab if Notepad is open) at 100,100
#
# `focus` taps Alt so SetForegroundWindow is allowed, which can leave Notepad showing its menu
# key tips; send `key Esc` and click into the text before `selectall`.
#   scripts/ui-drive.ps1 focus notepad      bring a process's window to the front
#   scripts/ui-drive.ps1 focustitle Glossly bring a window to the front by exact title (Electron windows)
#   scripts/ui-drive.ps1 selectall | hotkey (Ctrl+Alt+Space)
#   scripts/ui-drive.ps1 key Enter|Tab|Esc|Left|Right|<digit or letter>
#   scripts/ui-drive.ps1 type "text"        SendKeys syntax
#   scripts/ui-drive.ps1 drag "x1,y1,x2,y2" | move "x,y" | click "x,y"
#   scripts/ui-drive.ps1 shot <name>        full primary screen to <name>.png
#
# Run a whole sequence in one shell command: Cursor takes focus back between agent commands,
# which closes a focused bar and sends later keys to the wrong window.
param([string]$cmd, [string]$arg = '')
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class GlosslyDrive {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
}
"@
$W = [GlosslyDrive]
$W::SetProcessDPIAware() | Out-Null
$dir = Join-Path $env:TEMP 'glossly-live'
New-Item -ItemType Directory -Force $dir | Out-Null

function Key([byte]$vk, [bool]$up) { $W::keybd_event($vk, 0, $(if ($up) { 2 } else { 0 }), [UIntPtr]::Zero) }
function Tap([byte]$vk) { Key $vk $false; Start-Sleep -Milliseconds 30; Key $vk $true }
function Chord([byte[]]$mods, [byte]$vk) {
  foreach ($m in $mods) { Key $m $false }
  Tap $vk
  foreach ($m in $mods) { Key $m $true }
}
function Point([string]$s) { $s.Split(',') | ForEach-Object { [int]$_ } }

switch ($cmd) {
  'notepad' {
    $file = Join-Path $dir 'sample.txt'
    if (-not (Test-Path $file)) {
      Set-Content $file "Hi Rayan, thanks for the update on the launch plan. I'll send the revised budget by Friday, and can you confirm the venue booking with Sam Carter before the end of the week? Let me know if anything changes."
    }
    # Windows 11 Notepad opens the file as a tab in an existing window; never kill the user's Notepad.
    Start-Process notepad.exe $file
    Start-Sleep 2
    $p = Get-Process notepad | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
    $W::MoveWindow($p.MainWindowHandle, 100, 100, 1100, 600, $true) | Out-Null
  }
  'focus' {
    $p = Get-Process $arg | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
    $W::ShowWindow($p.MainWindowHandle, 9) | Out-Null
    # An Alt tap lets SetForegroundWindow succeed from a background process.
    Tap 0x12
    $W::SetForegroundWindow($p.MainWindowHandle) | Out-Null
  }
  'focustitle' {
    $h = $W::FindWindow([NullString]::Value, $arg)
    if ($h -eq [IntPtr]::Zero) { throw "No window titled '$arg'" }
    $W::ShowWindow($h, 9) | Out-Null
    Tap 0x12
    $W::SetForegroundWindow($h) | Out-Null
  }
  'selectall' { Chord @(0x11) 0x41 }
  'hotkey' { Chord @(0x11, 0x12) 0x20 }
  'key' {
    $map = @{ Enter = 0x0D; Tab = 0x09; Esc = 0x1B; Right = 0x27; Left = 0x25 }
    Tap $(if ($map.ContainsKey($arg)) { $map[$arg] } else { [byte][char]$arg.ToUpper() })
  }
  'type' { [System.Windows.Forms.SendKeys]::SendWait($arg) }
  'drag' {
    $c = Point $arg
    $W::SetCursorPos($c[0], $c[1]) | Out-Null; Start-Sleep -Milliseconds 50
    $W::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 50
    for ($i = 1; $i -le 10; $i++) {
      $W::SetCursorPos($c[0] + ($c[2] - $c[0]) * $i / 10, $c[1] + ($c[3] - $c[1]) * $i / 10) | Out-Null
      Start-Sleep -Milliseconds 20
    }
    $W::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  }
  'move' { $c = Point $arg; $W::SetCursorPos($c[0], $c[1]) | Out-Null }
  'click' {
    $c = Point $arg
    $W::SetCursorPos($c[0], $c[1]) | Out-Null; Start-Sleep -Milliseconds 50
    $W::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); $W::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  }
  'shot' {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save("$dir\$arg.png", [System.Drawing.Imaging.ImageFormat]::Png)
    "$dir\$arg.png"
  }
  default { throw "Unknown command: $cmd" }
}
