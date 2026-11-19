param(
    [Parameter(Mandatory=$true)][string]$Output,
    [string]$WindowTitle = 'RxAi'
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WF {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$hwnd = [IntPtr]::Zero
$rect = New-Object WF+RECT
$cb = [WF+EnumWindowsProc]{
    param($h, $l)
    $sb = New-Object Text.StringBuilder 256
    [WF]::GetWindowText($h, $sb, 256) | Out-Null
    $t = $sb.ToString()
    if ($t -match [regex]::Escape($WindowTitle) -and [WF]::IsWindowVisible($h)) {
        $script:hwnd = $h
        [WF]::GetWindowRect($h, [ref]$script:rect) | Out-Null
        return $false
    }
    return $true
}
[WF]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($script:hwnd -eq [IntPtr]::Zero) { Write-Host "not found"; exit 1 }

$wx = $rect.Left
$wy = $rect.Top
$ww = $rect.Right - $rect.Left
$wh = $rect.Bottom - $rect.Top
[Console]::Out.WriteLine("hwnd=$($script:hwnd) rect=($wx,$wy)-$($rect.Right),$($rect.Bottom) size=${ww}x${wh}")

[WF]::SetForegroundWindow($script:hwnd) | Out-Null
Start-Sleep -Milliseconds 800

# Just capture the wizard right half (where the toggle is)
# Wizard area starts ~80px from left of window, spans ~1440 wide
# Toggle should be at right edge, top of wizard (around y_offset 100-130 from window top)
$captureX = $wx + $ww - 700  # Right 700px
$captureY = $wy
$captureW = 700
$captureH = 200

$src = New-Object System.Drawing.Bitmap $captureW, $captureH
$g = [System.Drawing.Graphics]::FromImage($src)
$g.CopyFromScreen($captureX, $captureY, 0, 0, (New-Object System.Drawing.Size($captureW, $captureH)))
$g.Dispose()

$dir = Split-Path $Output -Parent
if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$src.Save($Output, [System.Drawing.Imaging.ImageFormat]::Png)
$src.Dispose()

[Console]::Out.WriteLine("Saved $Output (${captureW}x${captureH}) from screen ($captureX,$captureY)")
