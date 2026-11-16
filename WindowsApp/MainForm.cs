using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace FreeTility.CadPro
{
    /// <summary>The app window: hosts the web UI in WebView2 and serves its files from https://app.local/.</summary>
    public sealed class MainForm : Form
    {
        internal const string Version = "1.2.2";
        private const string Origin = "https://app.local/";
        private static readonly Color Back = Color.FromArgb(17, 26, 28);

        private readonly WebView2 web;
        private readonly Projects lib = new Projects();
        private readonly string webRoot = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "web");
        private readonly List<string> pendingJs = new List<string>();
        private string[] startArgs;
        private bool jsReady, allowClose;

        public MainForm(string[] args)
        {
            startArgs = args;
            Text = "FreeTility CAD PRO";
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { /* default icon */ }
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            Size = new Size(Math.Min(1500, (int)(wa.Width * 0.85)), Math.Min(980, (int)(wa.Height * 0.9)));
            MinimumSize = new Size(480, 600);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Back;
            web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Back };
            Controls.Add(web);
            Load += async (s, e) => await InitAsync();
            HandleCreated += (s, e) => DarkTitleBar();
            StartPipeServer();
        }

        private async Task InitAsync()
        {
            try
            {
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Projects.DataDir, "WebView2"));
                await web.EnsureCoreWebView2Async(env);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this,
                    "This app needs the Microsoft Edge WebView2 Runtime, which is part of Windows 10 and 11.\n\n" +
                    "Install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and try again.\n\n" + ex.Message,
                    Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
                allowClose = true;
                Close();
                return;
            }

            CoreWebView2 cw = web.CoreWebView2;
            CoreWebView2Settings st = cw.Settings;
            st.AreDefaultContextMenusEnabled = false;
            st.IsZoomControlEnabled = false;
            st.IsPinchZoomEnabled = false;
            st.AreBrowserAcceleratorKeysEnabled = false;
            st.IsStatusBarEnabled = false;
            st.IsSwipeNavigationEnabled = false;
            st.IsGeneralAutofillEnabled = false;
            st.IsPasswordAutosaveEnabled = false;
            st.AreDevToolsEnabled = Environment.GetEnvironmentVariable("FREETILITY_DEVTOOLS") == "1";
            cw.AddHostObjectToScript("Native", new Bridge(this, lib));
            await cw.AddScriptToExecuteOnDocumentCreatedAsync("window.Native = chrome.webview.hostObjects.sync.Native;");
            cw.AddWebResourceRequestedFilter(Origin + "*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
            cw.WebResourceRequested += OnResource;
            cw.NewWindowRequested += (s, e) => { e.Handled = true; OpenExternal(e.Uri); };
            cw.NavigationStarting += (s, e) =>
            {
                if (e.Uri.StartsWith(Origin, StringComparison.OrdinalIgnoreCase)) return;
                e.Cancel = true;
                // a file dropped on the window arrives as a file:// navigation
                if (e.Uri.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
                {
                    try { OpenPaths(new[] { new Uri(e.Uri).LocalPath }); } catch { /* ignore */ }
                }
                else OpenExternal(e.Uri);
            };
            cw.Navigate(Origin + "assets/index.html");
        }

        private static void OpenExternal(string uri)
        {
            if (uri == null || !(uri.StartsWith("https://") || uri.StartsWith("http://") || uri.StartsWith("mailto:"))) return;
            try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { /* ignore */ }
        }

        private void OnResource(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            string path;
            try { path = Uri.UnescapeDataString(new Uri(e.Request.Uri).AbsolutePath); }
            catch { e.Response = NotFound(); return; }
            string file = Projects.Resolve(webRoot, path);
            if (file == null || !File.Exists(file)) { e.Response = NotFound(); return; }
            try
            {
                var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                e.Response = web.CoreWebView2.Environment.CreateWebResourceResponse(fs, 200, "OK",
                    "Content-Type: " + Projects.Mime(file) + "\r\nCache-Control: no-cache\r\nAccess-Control-Allow-Origin: *");
            }
            catch { e.Response = NotFound(); }
        }

        private CoreWebView2WebResourceResponse NotFound() =>
            web.CoreWebView2.Environment.CreateWebResourceResponse(null, 404, "Not Found", "");

        // ------------------------------------------------------------------ bridge support

        internal void OnJsReady()
        {
            jsReady = true;
            foreach (string js in pendingJs) _ = web.CoreWebView2.ExecuteScriptAsync(js);
            pendingJs.Clear();
            if (startArgs != null && startArgs.Length > 0) { string[] a = startArgs; startArgs = null; BeginInvoke((Action)(() => OpenPaths(a))); }
        }

        /// <summary>Sends an event to window.onNative(event, data). Safe from any thread.</summary>
        internal void Emit(string ev, object data)
        {
            if (IsDisposed) return;
            if (InvokeRequired) { try { BeginInvoke((Action)(() => Emit(ev, data))); } catch { /* closing */ } return; }
            string js = "window.onNative && window.onNative(" + Projects.Json(ev) + "," + Projects.Json(data ?? new { }) + ")";
            if (!jsReady || web.CoreWebView2 == null) { pendingJs.Add(js); return; }
            _ = web.CoreWebView2.ExecuteScriptAsync(js);
        }

        private void Ui(Action a) { try { BeginInvoke(a); } catch { /* closing */ } }

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        private void DarkTitleBar()
        {
            int v = 1;
            DwmSetWindowAttribute(Handle, 20, ref v, 4);                     // DWMWA_USE_IMMERSIVE_DARK_MODE
            int c = Back.R | (Back.G << 8) | (Back.B << 16);
            DwmSetWindowAttribute(Handle, 35, ref c, 4);                     // DWMWA_CAPTION_COLOR (Windows 11)
        }

        /// <summary>Let the page save the open part before the window closes.</summary>
        protected override async void OnFormClosing(FormClosingEventArgs e)
        {
            if (!allowClose && jsReady && web.CoreWebView2 != null)
            {
                e.Cancel = true;
                try { await web.CoreWebView2.ExecuteScriptAsync("window.onNative && window.onNative('pause', {})"); } catch { /* ignore */ }
                allowClose = true;
                BeginInvoke((Action)Close);
                return;
            }
            base.OnFormClosing(e);
        }

        // ------------------------------------------------------------------ opening files

        /// <summary>.ftcad parts open (copied into the library if needed); .step / .stp start a new part.</summary>
        internal void OpenPaths(IEnumerable<string> paths)
        {
            foreach (string p in paths)
            {
                if (string.IsNullOrWhiteSpace(p) || !File.Exists(p)) continue;
                string ext = Path.GetExtension(p).ToLowerInvariant();
                if (ext == Projects.Ext)
                {
                    string name = lib.ImportProject(p, out string err);
                    if (name != null) Emit("openPart", new { name });
                    else Emit("imported", new { ok = false, message = err });
                }
                else if (ext == ".step" || ext == ".stp")
                {
                    try { Emit("openStep", new { name = Path.GetFileNameWithoutExtension(p), url = lib.StageImport(p) }); }
                    catch (Exception ex) { Emit("imported", new { ok = false, message = ex.Message }); }
                }
                else if (ext == ".sldprt" || ext == ".sldasm")
                {
                    Emit("imported", new { ok = false, message = "SolidWorks files can't be opened directly. In SolidWorks use File > Save As > STEP, then open the .step file." });
                }
            }
        }

        internal void PickProject()
        {
            Ui(() =>
            {
                using (var d = new OpenFileDialog { Title = "Open FreeTility CAD part", Filter = "FreeTility CAD parts (*.ftcad)|*.ftcad|STEP files (*.step;*.stp)|*.step;*.stp" })
                {
                    if (d.ShowDialog(this) != DialogResult.OK) return;
                    string ext = Path.GetExtension(d.FileName).ToLowerInvariant();
                    if (ext == Projects.Ext)
                    {
                        string name = lib.ImportProject(d.FileName, out string err);
                        Emit("imported", name != null ? (object)new { ok = true, name } : new { ok = false, message = err });
                    }
                    else OpenPaths(new[] { d.FileName });
                }
            });
        }

        internal void PickFile(string accept)
        {
            Ui(() =>
            {
                string filter = accept != null && accept.Contains(".st")
                    ? "STEP files (*.step;*.stp)|*.step;*.stp|All files (*.*)|*.*"
                    : "All files (*.*)|*.*";
                using (var d = new OpenFileDialog { Title = "Open", Filter = filter })
                {
                    if (d.ShowDialog(this) != DialogResult.OK) { Emit("filePicked", new { ok = false }); return; }
                    try { Emit("filePicked", new { ok = true, name = Path.GetFileName(d.FileName), url = lib.StageImport(d.FileName) }); }
                    catch (Exception ex) { Emit("filePicked", new { ok = false, message = ex.Message }); }
                }
            });
        }

        /// <summary>Asks where to save the export buffer (STL, STEP or .ftcad).</summary>
        internal bool SaveExport(string fileName, string mime)
        {
            byte[] bytes = lib.TakeExport();
            if (bytes == null) return false;
            Ui(() =>
            {
                string ext = Path.GetExtension(fileName).ToLowerInvariant();
                string filter = ext == ".stl" ? "STL mesh (*.stl)|*.stl"
                    : ext == ".step" ? "STEP file (*.step)|*.step"
                    : ext == ".ftcad" ? "FreeTility CAD part (*.ftcad)|*.ftcad"
                    : "All files (*.*)|*.*";
                using (var d = new SaveFileDialog { Title = "Export", FileName = Projects.Safe(fileName), Filter = filter, OverwritePrompt = true })
                {
                    if (d.ShowDialog(this) != DialogResult.OK) { Emit("exported", new { ok = false, cancelled = true }); return; }
                    try
                    {
                        File.WriteAllBytes(d.FileName, bytes);
                        Emit("exported", new { ok = true });
                    }
                    catch (Exception ex) { Emit("exported", new { ok = false, message = ex.Message }); }
                }
            });
            return true;
        }

        // ------------------------------------------------------------------ single instance

        private void StartPipeServer()
        {
            var t = new Thread(() =>
            {
                while (true)
                {
                    try
                    {
                        using (var srv = new NamedPipeServerStream(Program.PipeName, PipeDirection.In, 1))
                        {
                            srv.WaitForConnection();
                            string text;
                            using (var r = new StreamReader(srv, Encoding.UTF8)) text = r.ReadToEnd();
                            var paths = text.Split('\n').Select(x => x.Trim()).Where(x => x.Length > 0).ToList();
                            if (IsHandleCreated)
                            {
                                Ui(() =>
                                {
                                    if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                                    Activate();
                                    if (paths.Count > 0) OpenPaths(paths);
                                });
                            }
                        }
                    }
                    catch { Thread.Sleep(300); }
                }
            })
            { IsBackground = true, Name = "open-pipe" };
            t.Start();
        }
    }
}
