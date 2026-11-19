# screenshot.ps1 — 截屏 + 缩放 (干净版)
param(
    [Parameter(Mandatory=$true)][string]$Output,
    [int]$DelayMs = 500,
    [int]$MaxDim = 1600
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Start-Sleep -Milliseconds $DelayMs

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$srcW = $screen.Width
$srcH = $screen.Height

# 先截全屏
$src = New-Object System.Drawing.Bitmap $srcW, $srcH
$g = [System.Drawing.Graphics]::FromImage($src)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$g.Dispose()

# 计算目标尺寸
$scale = 1.0
if ($srcW -gt $MaxDim -or $srcH -gt $MaxDim) {
    $scale = [Math]::Min($MaxDim / $srcW, $MaxDim / $srcH)
}
$dstW = [int]($srcW * $scale)
$dstH = [int]($srcH * $scale)

# 缩放
$dst = New-Object System.Drawing.Bitmap $dstW, $dstH
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($src, 0, 0, $dstW, $dstH)
$g.Dispose()
$src.Dispose()

# 保存
$dir = Split-Path $Output -Parent
if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$dst.Save($Output, [System.Drawing.Imaging.ImageFormat]::Png)
$dst.Dispose()

Write-Output "Saved: $Output ($dstW x $dstH)"