# screenshot-window.ps1 — 找窗口并截屏（简版）
param(
    [Parameter(Mandatory=$true)][string]$Output,
    [string]$WindowTitle = 'ReAI',
    [int]$DelayMs = 500,
    [int]$MaxDim = 1400
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -Namespace W -Name PInvoke -MemberDefinition @'
[DllImport("user32.dll")]
public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")]
public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
[DllImport("user32.dll")]
public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")]
public static extern bool SetForegroundWindow(IntPtr hWnd);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")]
public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left, Top, Right, Bottom; }
'@

# 找窗口
$script:foundHwnd = [IntPtr]::Zero
$script:foundRect = $null
$cb = [W.PInvoke+EnumWindowsProc] {
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    $sb = New-Object System.Text.StringBuilder 256
    [W.PInvoke]::GetWindowText($hWnd, $sb, 256) | Out-Null
    $title = $sb.ToString()
    if ($title -match [regex]::Escape($WindowTitle) -and [W.PInvoke]::IsWindowVisible($hWnd)) {
        $rect = New-Object W.PInvoke+RECT
        [W.PInvoke]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
        $script:foundHwnd = $hWnd
        $script:foundRect = $rect
        return $false
    }
    return $true
}
[W.PInvoke]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($script:foundHwnd -ne [IntPtr]::Zero) {
    $r = $script:foundRect
    Write-Output "Window '$WindowTitle' hwnd=$($script:foundHwnd) rect=($($r.Left),$($r.Top))-($($r.Right),$($r.Bottom))"
    [W.PInvoke]::SetForegroundWindow($script:foundHwnd) | Out-Null
    Start-Sleep -Milliseconds 800

    # 截屏（仅窗口区域）
    $w = $r.Right - $r.Left
    $h = $r.Bottom - $r.Top
    $src = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($src)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $g.Dispose()

    # 缩放
    $scale = 1.0
    if ($w -gt $MaxDim -or $h -gt $MaxDim) {
        $scale = [Math]::Min($MaxDim / $w, $MaxDim / $h)
    }
    $dstW = [int]($w * $scale)
    $dstH = [int]($h * $scale)
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
    Write-Output "Window '$WindowTitle' not found"
}