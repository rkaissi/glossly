param([long]$hwnd, [int]$attr, [int]$value)
Add-Type -Namespace W -Name D -MemberDefinition '[DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(System.IntPtr h, int a, ref int v, int s);'
$v = $value; $r = [W.D]::DwmSetWindowAttribute([System.IntPtr]$hwnd, $attr, [ref]$v, 4); "hr=$r"
