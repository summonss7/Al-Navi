param([int]$W = 1200, [int]$H = 700, [int]$X = 100, [int]$Y = 80, [string]$Title = "Al-Navi")
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinResize2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }

  public static string FindAndResize(string titlePart, int x, int y, int w, int hh) {
    IntPtr found = IntPtr.Zero;
    EnumProc cb = (h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (sb.ToString().IndexOf(titlePart, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    };
    EnumWindows(cb, IntPtr.Zero);
    if (found == IntPtr.Zero) return "window not found";
    RECT r;
    GetWindowRect(found, out r);
    string before = (r.R - r.L) + "x" + (r.B - r.T);
    MoveWindow(found, x, y, w, hh, true);
    System.Threading.Thread.Sleep(200);
    GetWindowRect(found, out r);
    return "before " + before + " after " + (r.R - r.L) + "x" + (r.B - r.T);
  }
}
'@
[WinResize2]::FindAndResize($Title, $X, $Y, $W, $H)
