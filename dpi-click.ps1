param(
    [string]$WindowTitle = 'RxAi',
    [int]$X,
    [int]$Y,
    [string]$Output = ".test-screenshots/after.png"
)

# Set DPI awareness (Per-Monitor V2) so coordinates match physical pixels
$src = @'
using System;
using System.Runtime.InteropServices;
public class DPI {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    public static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);
}
'@
Add-Type $src

[DPI]::SetProcessDpiAwarenessContext([DPI]::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) | Out-Null

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -Namespace W -Name DK -MemberDefinition @'
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
public class MK {
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, int extra);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
'@

$hwnd = [IntPtr]::Zero
$rect = New-Object W.DK+RECT
$cb = [W.DK+EnumWindowsProc]{
    param($h, $l)
    $sb = New-Object System.Text.StringBuilder 256
    [W.DK]::GetWindowText($h, $sb, 256) | Out-Null
    $t = $sb.ToString()
    if ($t -match [regex]::Escape($WindowTitle) -and [W.DK]::IsWindowVisible($h)) {
        $script:hwnd = $h
        [W.DK]::GetWindowRect($h, [ref]$script:rect) | Out-Null
        return $false
    }
    return $true
}
[W.DK]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($script:hwnd -eq [IntPtr]::Zero) { [Console]::Out.WriteLine("not found"); exit 1 }

[W.DK]::ShowWindow($script:hwnd, 9) | Out-Null
Start-Sleep -Milliseconds 200
[W.DK]::SetForegroundWindow($script:hwnd) | Out-Null
Start-Sleep -Milliseconds 1000

$ok = [W.DK]::SetCursorPos($X, $Y)
Start-Sleep -Milliseconds 200

# Also try via System.Windows.Forms.Cursor (sometimes works when Win32 fails)
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($X, $Y)
Start-Sleep -Milliseconds 200

$pt = New-Object MK+POINT
[MK]::GetCursorPos([ref]$pt) | Out-Null
[Console]::Out.WriteLine("hwnd=$($script:hwnd) SetCursorPos($X,$Y) ok=$ok actual=($($pt.X),$($pt.Y))")

# Move with mouse_event for redundancy (some apps need cursor moved, not just teleported)
[MK]::mouse_event(0x0001, 0, 1, 0, 0)  # MOUSEEVENTF_MOVE = 0x0001
Start-Sleep -Milliseconds 100

[MK]::mouse_event(0x0002, 0, 0, 0, 0)
Start-Sleep -Milliseconds 80
[MK]::mouse_event(0x0004, 0, 0, 0, 0)

[Console]::Out.WriteLine("Clicked")
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
