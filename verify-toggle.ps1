param(
    [string]$WindowTitle = 'RxAi',
    [int]$X = 2040,
    [int]$Y = 380,
    [string]$AfterAction = "screenshot",  # click, doubleclick, screenshot
    [string]$Output = ".test-screenshots/after-click.png"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -Namespace W -Name PF -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@

Add-Type @'
using System.Runtime.InteropServices;
public class MF {
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, int extra);
}
'@

$hwnd = [IntPtr]::Zero
$rect = New-Object W.PF+RECT
$cb = [W.PF+EnumWindowsProc]{
    param($h, $l)
    $sb = New-Object System.Text.StringBuilder 256
    [W.PF]::GetWindowText($h, $sb, 256) | Out-Null
    $t = $sb.ToString()
    if ($t -match [regex]::Escape($WindowTitle) -and [W.PF]::IsWindowVisible($h)) {
        $script:hwnd = $h
        [W.PF]::GetWindowRect($h, [ref]$script:rect) | Out-Null
        return $false
    }
    return $true
}
[W.PF]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($script:hwnd -eq [IntPtr]::Zero) { [Console]::Out.WriteLine("not found"); exit 1 }

[Console]::Out.WriteLine("hwnd=$($script:hwnd) rect=($($rect.Left),$($rect.Top))-$($rect.Right),$($rect.Bottom)")

# Bring to foreground WITHOUT maximizing (to preserve position)
[W.PF]::SetForegroundWindow($script:hwnd) | Out-Null
Start-Sleep -Milliseconds 600

if ($AfterAction -eq "screenshot") {
    # Just screenshot the wizard area
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
} else {
    # Click at absolute screen coords
    [W.PF]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 200
    [MF]::mouse_event(0x0002, 0, 0, 0, 0)
    Start-Sleep -Milliseconds 80
    [MF]::mouse_event(0x0004, 0, 0, 0, 0)
    [Console]::Out.WriteLine("Clicked at ($X, $Y)")
    Start-Sleep -Milliseconds 1500
}
