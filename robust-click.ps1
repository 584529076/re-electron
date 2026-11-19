param(
    [string]$WindowTitle = 'RxAi',
    [int]$X,
    [int]$Y,
    [string]$Output = ".test-screenshots/after.png"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -Namespace W -Name RG -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@

Add-Type @'
using System.Runtime.InteropServices;
public class MG {
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, int extra);
}
'@

$hwnd = [IntPtr]::Zero
$rect = New-Object W.RG+RECT
$cb = [W.RG+EnumWindowsProc]{
    param($h, $l)
    $sb = New-Object System.Text.StringBuilder 256
    [W.RG]::GetWindowText($h, $sb, 256) | Out-Null
    $t = $sb.ToString()
    if ($t -match [regex]::Escape($WindowTitle) -and [W.RG]::IsWindowVisible($h)) {
        $script:hwnd = $h
        [W.RG]::GetWindowRect($h, [ref]$script:rect) | Out-Null
        return $false
    }
    return $true
}
[W.RG]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($script:hwnd -eq [IntPtr]::Zero) { [Console]::Out.WriteLine("not found"); exit 1 }

[Console]::Out.WriteLine("hwnd=$($script:hwnd) rect=($($rect.Left),$($rect.Top))-$($rect.Right),$($rect.Bottom)")

# Ensure window is foreground (ShowWindow SW_RESTORE=9 in case minimized)
[W.RG]::ShowWindow($script:hwnd, 9) | Out-Null
Start-Sleep -Milliseconds 300
[W.RG]::SetForegroundWindow($script:hwnd) | Out-Null
Start-Sleep -Milliseconds 800

# Verify foreground via foreground window API
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FG {
    [DllImport(""user32.dll"")] public static extern IntPtr GetForegroundWindow();
    [DllImport(""user32.dll"")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
}
"@
$fg = [FG]::GetForegroundWindow()
$sb2 = New-Object Text.StringBuilder 256
[FG]::GetWindowText($fg, $sb2, 256) | Out-Null
[Console]::Out.WriteLine("FG hwnd=$fg title='$($sb2.ToString())'")

# Move cursor and click with stronger delays
[W.RG]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 400

# Click twice quickly (some apps register first click as hover)
[MG]::mouse_event(0x0002, 0, 0, 0, 0)   # LEFTDOWN
Start-Sleep -Milliseconds 60
[MG]::mouse_event(0x0004, 0, 0, 0, 0)   # LEFTUP
Start-Sleep -Milliseconds 400

[Console]::Out.WriteLine("Clicked at ($X, $Y)")
Start-Sleep -Milliseconds 1500

# Now screenshot the window area
$wx = $rect.Left
$wy = $rect.Top
$ww = $rect.Right - $rect.Left
$wh = $rect.Bottom - $rect.Top
$src = New-Object System.Drawing.Bitmap $ww, $wh
$g = [System.Drawing.Graphics]::FromImage($src)
$g.CopyFromScreen($wx, $wy, 0, 0, (New-Object System.Drawing.Size($ww, $wh)))
$g.Dispose()

$dir = Split-Path $Output -Parent
if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$src.Save($Output, [System.Drawing.Imaging.ImageFormat]::Png)
$src.Dispose()

[Console]::Out.WriteLine("Saved $Output (${ww}x${wh})")
