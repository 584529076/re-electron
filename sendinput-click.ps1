param(
    [string]$WindowTitle = 'RxAi',
    [int]$X,
    [int]$Y,
    [string]$Output = ".test-screenshots/after.png"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Define Win32 INPUT struct for SendInput (more reliable than SetCursorPos)
$src = @'
using System;
using System.Runtime.InteropServices;
public class SI {
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public MOUSEINPUT mi;
    }
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
Add-Type $src

Add-Type @'
using System.Runtime.InteropServices;
public class CR {
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, public int Y; }
}
'@

$hwnd = [IntPtr]::Zero
$rect = New-Object SI+RECT
$cb = [SI+EnumWindowsProc]{
    param($h, $l)
    $sb = New-Object System.Text.StringBuilder 256
    [SI]::GetWindowText($h, $sb, 256) | Out-Null
    $t = $sb.ToString()
    if ($t -match [regex]::Escape($WindowTitle) -and [SI]::IsWindowVisible($h)) {
        $script:hwnd = $h
        [SI]::GetWindowRect($h, [ref]$script:rect) | Out-Null
        return $false
    }
    return $true
}
[SI]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($script:hwnd -eq [IntPtr]::Zero) { [Console]::Out.WriteLine("not found"); exit 1 }

[SI]::ShowWindow($script:hwnd, 9) | Out-Null
Start-Sleep -Milliseconds 200
[SI]::SetForegroundWindow($script:hwnd) | Out-Null
Start-Sleep -Milliseconds 1000

# Build absolute mouse move via SendInput
# MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_MOVE = 0x0001
# MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004
# Convert to absolute coords (0-65535 range)
# Get screen dimensions first
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$screenW = $screen.Width
$screenH = $screen.Height
$absX = [int](($X * 65535) / $screenW)
$absY = [int](($Y * 65535) / $screenH)
[Console]::Out.WriteLine("Screen: ${screenW}x${screenH} target=($X,$Y) abs=($absX,$absY)")

# Move via SendInput absolute
$moveInput = New-Object SI+INPUT
$moveInput.type = 0  # INPUT_MOUSE
$moveInput.mi.dx = $absX
$moveInput.mi.dy = $absY
$moveInput.mi.dwFlags = 0x8001  # ABSOLUTE | MOVE
$null = [SI]::SendInput(1, [SI+INPUT[]]($moveInput), [System.Runtime.InteropServices.Marshal]::SizeOf([type]"SI+INPUT"))

Start-Sleep -Milliseconds 300

$pt = New-Object CR+POINT
[CR]::GetCursorPos([ref]$pt) | Out-Null
[Console]::Out.WriteLine("After move: cursor at ($($pt.X),$($pt.Y))")

# Click via SendInput
$downInput = New-Object SI+INPUT
$downInput.type = 0
$downInput.mi.dwFlags = 0x0002  # LEFTDOWN
$null = [SI]::SendInput(1, [SI+INPUT[]]($downInput), [System.Runtime.InteropServices.Marshal]::SizeOf([type]"SI+INPUT"))

Start-Sleep -Milliseconds 80

$upInput = New-Object SI+INPUT
$upInput.type = 0
$upInput.mi.dwFlags = 0x0004  # LEFTUP
$null = [SI]::SendInput(1, [SI+INPUT[]]($upInput), [System.Runtime.InteropServices.Marshal]::SizeOf([type]"SI+INPUT"))

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
