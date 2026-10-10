param([long]$hwnd, [int]$wparam)
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr SendMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);'
[void][W.U]::SendMessage([System.IntPtr]$hwnd, 0x86, [System.IntPtr]$wparam, [System.IntPtr]0); "sent"
