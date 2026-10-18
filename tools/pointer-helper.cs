using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

internal static class Program
{
    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(POINT point, uint flags);

    [DllImport("user32.dll")]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    [DllImport("shcore.dll")]
    private static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);

    [DllImport("shcore.dll")]
    private static extern int SetProcessDpiAwareness(int value);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    private const int VK_LBUTTON = 0x01;
    private const int VK_RBUTTON = 0x02;
    private const int VK_ESCAPE = 0x1B;

    private static readonly object OutputGate = new object();
    private static volatile bool armed;
    private static volatile bool cancelRequested;
    private static volatile bool quitRequested;

    private static void Emit(string line)
    {
        lock (OutputGate)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }

    private static bool IsDown(int virtualKey)
    {
        return (GetAsyncKeyState(virtualKey) & 0x8000) != 0;
    }

    // Emits the monitor that owns a physical point together with its effective
    // DPI. The Electron main process needs both values to map a high-DPI
    // physical click onto the DIP coordinate space used by screen bounds.
    private static string MonitorJson(POINT point)
    {
        IntPtr monitor = MonitorFromPoint(point, 2);
        MONITORINFO info = new MONITORINFO();
        info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info)) return "null";
        uint dpiX = 96;
        uint dpiY = 96;
        try { GetDpiForMonitor(monitor, 0, out dpiX, out dpiY); } catch { }
        int width = info.rcMonitor.Right - info.rcMonitor.Left;
        int height = info.rcMonitor.Bottom - info.rcMonitor.Top;
        return "{\"x\":" + info.rcMonitor.Left + ",\"y\":" + info.rcMonitor.Top +
            ",\"width\":" + width + ",\"height\":" + height + ",\"dpi\":" + dpiX + "}";
    }

    private static void ReadCommands()
    {
        try
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                switch (line.Trim().ToLowerInvariant())
                {
                    case "arm":
                        armed = true;
                        break;
                    case "cancel":
                        cancelRequested = true;
                        break;
                    case "quit":
                        quitRequested = true;
                        return;
                }
            }
        }
        catch
        {
            // Standard input closing means the host is gone.
        }
        quitRequested = true;
    }

    private static void Main(string[] args)
    {
        try
        {
            SetProcessDpiAwareness(2);
        }
        catch
        {
            try { SetProcessDPIAware(); } catch { }
        }

        Thread reader = new Thread(ReadCommands);
        reader.IsBackground = true;
        reader.Start();
        Emit("{\"type\":\"ready\"}");

        bool previousLeft = IsDown(VK_LBUTTON);
        bool previousRight = IsDown(VK_RBUTTON);
        bool hasStart = false;
        POINT start = new POINT();
        long deadline = 0;
        Stopwatch clock = Stopwatch.StartNew();
        bool simulated = args.Length == 5 && args[0] == "--simulate";
        bool simulatedDone = false;
        int simX1 = 0, simY1 = 0, simX2 = 0, simY2 = 0;
        if (simulated)
        {
            simulated = int.TryParse(args[1], out simX1) && int.TryParse(args[2], out simY1)
                && int.TryParse(args[3], out simX2) && int.TryParse(args[4], out simY2);
        }

        while (!quitRequested)
        {
            if (!armed)
            {
                hasStart = false;
                deadline = 0;
                cancelRequested = false;
                previousLeft = IsDown(VK_LBUTTON);
                previousRight = IsDown(VK_RBUTTON);
                Thread.Sleep(12);
                continue;
            }

            if (deadline == 0)
            {
                deadline = clock.ElapsedMilliseconds + 120000;
                previousLeft = IsDown(VK_LBUTTON);
                previousRight = IsDown(VK_RBUTTON);
            }

            if (simulated && !simulatedDone)
            {
                simulatedDone = true;
                Emit(
                    "{\"type\":\"done\",\"start\":{\"x\":" + simX1 + ",\"y\":" + simY1 +
                    "},\"end\":{\"x\":" + simX2 + ",\"y\":" + simY2 + "}}"
                );
                armed = false;
                continue;
            }

            bool cancel = cancelRequested;
            cancelRequested = false;
            if (cancel || IsDown(VK_ESCAPE) || (IsDown(VK_RBUTTON) && !previousRight))
            {
                Emit("{\"type\":\"cancel\",\"reason\":\"" + (cancel ? "host" : IsDown(VK_ESCAPE) ? "escape" : "right-click") + "\"}");
                armed = false;
                continue;
            }

            bool left = IsDown(VK_LBUTTON);
            bool right = IsDown(VK_RBUTTON);
            if (left && !previousLeft)
            {
                POINT point;
                if (GetCursorPos(out point))
                {
                    if (!hasStart)
                    {
                        start = point;
                        hasStart = true;
                        Emit(
                            "{\"type\":\"point\",\"x\":" + point.X + ",\"y\":" + point.Y +
                            ",\"monitor\":" + MonitorJson(point) + "}"
                        );
                    }
                    else
                    {
                        Emit(
                            "{\"type\":\"done\",\"start\":{\"x\":" + start.X + ",\"y\":" + start.Y +
                            "},\"end\":{\"x\":" + point.X + ",\"y\":" + point.Y +
                            "},\"monitor\":" + MonitorJson(point) + "}"
                        );
                        armed = false;
                        hasStart = false;
                        deadline = 0;
                        // Do not fall through to the deadline check: a zero
                        // deadline would immediately emit a bogus timeout.
                        continue;
                    }
                }
            }

            previousLeft = left;
            previousRight = right;

            if (clock.ElapsedMilliseconds > deadline)
            {
                Emit("{\"type\":\"cancel\",\"reason\":\"timeout\"}");
                armed = false;
            }

            Thread.Sleep(8);
        }
    }
}
