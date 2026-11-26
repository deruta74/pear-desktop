using System;
using System.Runtime.InteropServices;
using System.Text;

public static class PearFixtureWindow
{
    [StructLayout(LayoutKind.Sequential)]
    public struct ClientRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder title, int count);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr window, uint command);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr window, out ClientRect rect);

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr window, IntPtr target, uint flags);

    public static ClientRect GetVerifiedClient(IntPtr window, uint expectedProcess)
    {
        const uint getRoot = 2;
        const uint getOwner = 4;
        var title = new StringBuilder(128);

        if (window == IntPtr.Zero ||
            GetWindowThreadProcessId(window, out uint processId) == 0 ||
            processId != expectedProcess ||
            GetAncestor(window, getRoot) != window ||
            GetWindow(window, getOwner) != IntPtr.Zero ||
            !IsWindowVisible(window) || IsIconic(window) ||
            GetWindowText(window, title, title.Capacity) <= 0 ||
            title.ToString() != "Pear Desktop Rust Preview" ||
            !GetClientRect(window, out ClientRect rect) ||
            rect.Left != 0 || rect.Top != 0 ||
            rect.Right < 400 || rect.Bottom < 300 ||
            rect.Right > 4096 || rect.Bottom > 2160)
        {
            return default;
        }

        return rect;
    }

    public static bool CaptureClient(IntPtr window, uint expectedProcess, IntPtr target, ClientRect bounds)
    {
        const uint clientOnly = 1;
        const uint renderFullContent = 2;
        ClientRect before = GetVerifiedClient(window, expectedProcess);
        if (before.Right == 0 || before.Right != bounds.Right || before.Bottom != bounds.Bottom)
        {
            return false;
        }

        // Paint this HWND into the supplied memory bitmap. No display DC is used.
        if (!PrintWindow(window, target, clientOnly | renderFullContent))
        {
            return false;
        }

        ClientRect after = GetVerifiedClient(window, expectedProcess);
        return after.Right == bounds.Right && after.Bottom == bounds.Bottom;
    }
}
