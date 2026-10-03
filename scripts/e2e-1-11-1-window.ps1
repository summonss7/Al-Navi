param([string]$action)
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win {
  public delegate bool CB(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(CB cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  public struct RECT { public int L, T, R, B; }
  // The real target is the top-level "Tauri Window" (a "Tao Thread Event
  // Target" helper also shows up first in enumeration once the window is
  // iconic — WM_CLOSE posted there is silently ignored).
  public static IntPtr FindTop(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint wp; GetWindowThreadProcessId(h, out wp);
      if (wp == pid && GetParent(h) == IntPtr.Zero) {
        StringBuilder c = new StringBuilder(64);
        GetClassName(h, c, 64);
        if (c.ToString() == "Tauri Window") { found = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
function Hwnd() {
  foreach ($i in 1..60) {
    $procs = Get-Process -Name "Al-Navi" -ErrorAction SilentlyContinue
    if (-not $procs -and $i -gt 6) { return $null }
    foreach ($p in $procs) {
      $h = [Win]::FindTop([uint32]$p.Id)
      if ($h -ne [IntPtr]::Zero) { return $h }
    }
    Start-Sleep -Milliseconds 500
  }
  return $null
}
switch ($action) {
  "rect" {
    $h = Hwnd
    if (-not $h) { Write-Output '{"error":"no window"}'; exit 1 }
    $r = New-Object Win+RECT
    [Win]::GetWindowRect($h, [ref]$r) | Out-Null
    Write-Output ('{{"w":{0},"h":{1},"x":{2},"y":{3}}}' -f ($r.R - $r.L), ($r.B - $r.T), $r.L, $r.T)
  }
  "min" {
    $h = Hwnd
    if (-not $h) { Write-Output '{"error":"no window"}'; exit 1 }
    [Win]::ShowWindow($h, 6) | Out-Null
    Write-Output '{"ok":true}'
  }
  "close" {
    $h = Hwnd
    if (-not $h) { Write-Output '{"error":"no window"}'; exit 1 }
    [Win]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Write-Output '{"ok":true}'
  }
  default { Write-Output '{"error":"unknown action"}'; exit 1 }
}
