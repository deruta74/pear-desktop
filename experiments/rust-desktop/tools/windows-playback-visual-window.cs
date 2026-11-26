using System;
using System.Runtime.InteropServices;
using System.Text;

public static class PearFixtureWindow
{
    public const int KnownClientWidth = 1028;
    public const int KnownClientHeight = 680;
    public const int PlayX = 321;
    public const int PlayY = 340;

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

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

    [DllImport("kernel32.dll")]
    private static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder name, int count);

    [DllImport("user32.dll")]
    private static extern bool ClientToScreen(IntPtr window, ref Point point);

    [DllImport("user32.dll")]
    private static extern bool ScreenToClient(IntPtr window, ref Point point);

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(Point point);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr window, uint message, UIntPtr buttons, IntPtr coordinates,
        uint flags, uint timeoutMs, out UIntPtr result);

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

    private static IntPtr HitPlay(
        IntPtr window, uint expectedProcess, uint browserProcess, uint session, out IntPtr coordinates)
    {
        const uint getRoot = 2;
        coordinates = IntPtr.Zero;
        ClientRect bounds = GetVerifiedClient(window, expectedProcess);
        var point = new Point { X = PlayX, Y = PlayY };
        if (bounds.Right != KnownClientWidth || bounds.Bottom != KnownClientHeight ||
            !ProcessIdToSessionId(expectedProcess, out uint ownerSession) || ownerSession != session ||
            !ClientToScreen(window, ref point))
        {
            return IntPtr.Zero;
        }

        IntPtr target = WindowFromPoint(point);
        var name = new StringBuilder(128);
        if (target == IntPtr.Zero || target == window || GetAncestor(target, getRoot) != window ||
            GetWindowThreadProcessId(target, out uint owner) == 0 || owner != browserProcess ||
            !ProcessIdToSessionId(owner, out uint targetSession) || targetSession != session ||
            GetClassName(target, name, name.Capacity) <= 0 || name.ToString() != "Chrome_RenderWidgetHostHWND" ||
            !ScreenToClient(target, ref point) || !GetClientRect(target, out ClientRect client) ||
            point.X < 0 || point.X >= client.Right || point.Y < 0 || point.Y >= client.Bottom)
        {
            return IntPtr.Zero;
        }

        coordinates = new IntPtr((point.Y << 16) | point.X);
        return target;
    }

    public static string ClickFixturePlay(IntPtr window, uint expectedProcess, uint browserProcess, uint session)
    {
        const uint leftButtonDown = 0x0201;
        const uint leftButtonUp = 0x0202;
        const uint blockAbortAndErrorOnExit = 0x23;
        IntPtr target = HitPlay(window, expectedProcess, browserProcess, session, out IntPtr coordinates);
        if (target == IntPtr.Zero)
        {
            return "hit-test-inconclusive";
        }
        if (SendMessageTimeout(target, leftButtonDown, (UIntPtr)1, coordinates,
                blockAbortAndErrorOnExit, 1000, out _) == IntPtr.Zero)
        {
            return "mouse-down-inconclusive";
        }

        // Recheck the actual hit before release. Never dispatch through the system pointer.
        if (HitPlay(window, expectedProcess, browserProcess, session, out IntPtr release) != target ||
            release != coordinates)
        {
            return "release-hit-test-inconclusive";
        }
        return SendMessageTimeout(target, leftButtonUp, UIntPtr.Zero, release,
            blockAbortAndErrorOnExit, 1000, out _) != IntPtr.Zero ? "dispatched" : "mouse-up-inconclusive";
    }
}
