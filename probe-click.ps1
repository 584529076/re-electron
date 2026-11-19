param(
    [string]$WindowTitle = 'RxAi',
    [int]$X,
    [int]$Y,
    [string]$Output = ".test-screenshots/probe.png"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -Namespace W -Name PR -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@

Add-Type @'
using System.Runtime.InteropServices;
public class MR {
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, int extra);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
'@

$hwnd = [IntPtr]::Zero
$rect = New-Object W.PR+RECT
$cb = [W.PR+EnumWindowsProc]{
    param($h, $l)
    $sb = New-Object System.Text.StringBuilder 256
    [W.PR]::GetWindowText($h, $sb, 256) | Out-Null
    $t = $sb.ToString()
    if ($t -match [regex]::Escape($WindowTitle) -and [W.PR]::IsWindowVisible($h)) {
        $script:hwnd = $h
        [W.PR]::GetWindowRect($h, [ref]$script:rect) | Out-Null
        return $false
    }
    return $true
}
[W.PR]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($script:hwnd -eq [IntPtr]::Zero) { [Console]::Out.WriteLine("not found"); exit 1 }

# ShowWindow SW_RESTORE=9 then SW_SHOW=5
[W.PR]::ShowWindow($script:hwnd, 9) | Out-Null
Start-Sleep -Milliseconds 200
[W.PR]::SetForegroundWindow($script:hwnd) | Out-Null
Start-Sleep -Milliseconds 1200

[Console]::Out.WriteLine("Window: $($script:hwnd) rect=($($rect.Left),$($rect.Top))-$($rect.Right),$($rect.Bottom)")

# Move cursor with explicit verification
$ok = [W.PR]::SetCursorPos($X, $Y)
Start-Sleep -Milliseconds 500

$pt = New-Object MR+POINT
[MR]::GetCursorPos([ref]$pt) | Out-Null
[Console]::Out.WriteLine("Cursor set to ($X,$Y), actual: ($($pt.X),$($pt.Y)) ok=$ok")

# Click
[MR]::mouse_event(0x0002, 0, 0, 0, 0)
Start-Sleep -Milliseconds 80
[MR]::mouse_event(0x0004, 0, 0, 0, 0)

[Console]::Out.WriteLine("Clicked at ($X, $Y)")
Start-Sleep -Milliseconds 1500

# Screenshot
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
