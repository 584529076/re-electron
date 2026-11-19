# focus-and-screenshot.ps1 — 聚焦到 electron 窗口并截图
param(
    [Parameter(Mandatory=$true)][string]$Output,
    [int]$DelayMs = 500,
    [int]$MaxDim = 1400
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")]
    public static extern int MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

# 找 ReAI 工作台窗口
$signature = @'
[DllImport("user32.dll", CharSet = CharSet.Auto)]
public static extern int GetWindowTextLength(IntPtr hWnd);
[DllImport("user32.dll", CharSet = CharSet.Auto)]
public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")]
public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
'@
Add-Type -Name W -Namespace U -MemberDefinition $signature

$found = $null
$callback = {
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    $sb = New-Object System.Text.StringBuilder 256
    [U.W]::GetWindowText($hWnd, $sb, 256) | Out-Null
    $title = $sb.ToString()
    if ($title -match 'ReAI' -and [WinAPI]::IsWindowVisible($hWnd)) {
        $script:found = @{ Hwnd = $hWnd; Title = $title }
        return $false
    }
    return $true
}
[U.W]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null

if ($found) {
    Write-Output "Found window: $($found.Title) (hwnd=$($found.Hwnd))"
    # 移动到屏幕左上角以便截图完整
    [WinAPI]::MoveWindow($found.Hwnd, 0, 0, 1280, 800, $true) | Out-Null
    [WinAPI]::SetForegroundWindow($found.Hwnd) | Out-Null
    Start-Sleep -Milliseconds 800
} else {
    Write-Output "ReAI window not found"
}

# 截屏
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$srcW = $screen.Width
$srcH = $screen.Height
$src = New-Object System.Drawing.Bitmap $srcW, $srcH
$g = [System.Drawing.Graphics]::FromImage($src)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$g.Dispose()

$scale = 1.0
if ($srcW -gt $MaxDim -or $srcH -gt $MaxDim) {
    $scale = [Math]::Min($MaxDim / $srcW, $MaxDim / $srcH)
}
$dstW = [int]($srcW * $scale)
$dstH = [int]($srcH * $scale)
$dst = New-Object System.Drawing.Bitmap $dstW, $dstH
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($src, 0, 0, $dstW, $dstH)
$g.Dispose()
$src.Dispose()

$dir = Split-Path $Output -Parent
if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$dst.Save($Output, [System.Drawing.Imaging.ImageFormat]::Png)
$dst.Dispose()

Write-Output "Saved: $Output ($dstW x $dstH)"