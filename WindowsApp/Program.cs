using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace FreeTility.CadPro
{
    internal static class Program
    {
        internal const string MutexName = "FreeTility.CadPro.SingleInstance";
        internal const string PipeName = "FreeTility.CadPro.Open";

        [STAThread]
        private static void Main(string[] args)
        {
            using (var mutex = new Mutex(true, MutexName, out bool first))
            {
                if (!first)
                {
                    // Already running: hand the file paths to that window and quit.
                    SendToRunning(args);
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm(args));
                GC.KeepAlive(mutex);
            }
        }

        private static void SendToRunning(string[] args)
        {
            try
            {
                using (var c = new NamedPipeClientStream(".", PipeName, PipeDirection.Out))
                {
                    c.Connect(10000);
                    var full = new string[args.Length];
                    for (int i = 0; i < args.Length; i++) full[i] = Path.GetFullPath(args[i]);
                    byte[] b = Encoding.UTF8.GetBytes(string.Join("\n", full) + "\n");
                    c.Write(b, 0, b.Length);
                }
            }
            catch
            {
                // The other instance may be closing; nothing useful to do.
            }
        }
    }
}
