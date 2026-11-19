Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W3 {
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$cb = [W3+EnumWindowsProc]{
    param($h, $l)
    $sb = New-Object Text.StringBuilder 256
    [W3]::GetWindowText($h, $sb, 256) | Out-Null
    $t = $sb.ToString()
    if ([W3]::IsWindowVisible($h) -and $t.Length -gt 0) {
        $r = New-Object W3+RECT
        [W3]::GetWindowRect($h, [ref]$r) | Out-Null
        [Console]::Out.WriteLine("hwnd=" + $h + " title='" + $t + "' rect=(" + $r.Left + "," + $r.Top + ")-(" + $r.Right + "," + $r.Bottom + ") size=" + ($r.Right-$r.Left) + "x" + ($r.Bottom-$r.Top))
    }
    return $true
}
[W3]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
