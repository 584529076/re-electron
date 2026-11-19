# click.ps1 — 找窗口 + 最大化 + 点击坐标（修复绝对坐标问题）
param(
    [Parameter(Mandatory=$true)][string]$WindowTitle,
    [int]$X,
    [int]$Y,
    [string]$Action = "click",  # click, doubleclick, screenshot
    [string]$Output = "",
    [int]$MaxDim = 1400
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -Namespace W -Name P -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left, Top, Right, Bottom; }
'@

Add-Type @'
using System.Runtime.InteropServices;
public class Mouse {
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, int extra);
}
'@

$script:hwnd = [IntPtr]::Zero
$script:rect = $null
$cb = [W.P+EnumWindowsProc] {
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    $sb = New-Object System.Text.StringBuilder 256
    [W.P]::GetWindowText($hWnd, $sb, 256) | Out-Null
    $title = $sb.ToString()
    if ($title -match [regex]::Escape($WindowTitle) -and [W.P]::IsWindowVisible($hWnd)) {
        $r = New-Object W.P+RECT
        [W.P]::GetWindowRect($hWnd, [ref]$r) | Out-Null
        $script:hwnd = $hWnd
        $script:rect = $r
        return $false
    }
    return $true
}
[W.P]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($script:hwnd -eq [IntPtr]::Zero) {
    Write-Output "Window '$WindowTitle' not found"
    exit 1
}

# 最大化（SW_MAXIMIZE = 3）
[W.P]::ShowWindow($script:hwnd, 3) | Out-Null
[W.P]::SetForegroundWindow($script:hwnd) | Out-Null
Start-Sleep -Milliseconds 1500

# 重新获取窗口 rect（最大化后）
$rect = New-Object W.P+RECT
[W.P]::GetWindowRect($script:hwnd, [ref]$rect) | Out-Null
$wx = $rect.Left
$wy = $rect.Top
$ww = $rect.Right - $rect.Left
$wh = $rect.Bottom - $rect.Top
Write-Output "Window: $WindowTitle hwnd=$($script:hwnd) pos=($wx,$wy) size=($ww,$wh)"

if ($Action -eq "screenshot") {
    # 截屏（仅窗口区域）
    $src = New-Object System.Drawing.Bitmap $ww, $wh
    $g = [System.Drawing.Graphics]::FromImage($src)
    $g.CopyFromScreen($wx, $wy, 0, 0, (New-Object System.Drawing.Size($ww, $wh)))
    $g.Dispose()
    $scale = 1.0
    if ($ww -gt $MaxDim -or $wh -gt $MaxDim) {
        $scale = [Math]::Min($MaxDim / $ww, $MaxDim / $wh)
    }
    $dstW = [int]($ww * $scale)
    $dstH = [int]($wh * $scale)
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
} else {
    # 计算绝对坐标
    $absX = $wx + $X
    $absY = $wy + $Y

    # 先 SetCursorPos 移动光标（用绝对坐标）
    [W.P]::SetCursorPos($absX, $absY) | Out-Null
    Start-Sleep -Milliseconds 200

    # mouse_event 用相对位移（0,0 = 不移动）— 这样 SetCursorPos 的绝对位置生效
    # MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004
    [Mouse]::mouse_event(0x0002, 0, 0, 0, 0)
    Start-Sleep -Milliseconds 100
    [Mouse]::mouse_event(0x0004, 0, 0, 0, 0)
    if ($Action -eq "doubleclick") {
        Start-Sleep -Milliseconds 200
        [Mouse]::mouse_event(0x0002, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 100
        [Mouse]::mouse_event(0x0004, 0, 0, 0, 0)
    }
    Write-Output "Clicked ($Action) at absolute ($absX, $absY)"
}