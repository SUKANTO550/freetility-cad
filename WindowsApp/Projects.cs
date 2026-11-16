using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.VisualBasic.FileIO;

namespace FreeTility.CadPro
{
    /// <summary>
    /// Part files (.ftcad) in Documents\FreeTility CAD, thumbnails and temporary
    /// files in %LOCALAPPDATA%\FreeTility\CadPro. FREETILITY_CAD_DIR and
    /// FREETILITY_CAD_DATA override both (used for testing).
    /// </summary>
    internal sealed class Projects
    {
        internal const string Ext = ".ftcad";
        private static readonly JavaScriptSerializer Ser = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        internal static readonly string LibDir = Dir(Environment.GetEnvironmentVariable("FREETILITY_CAD_DIR")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "FreeTility CAD"));
        internal static readonly string DataDir = Dir(Environment.GetEnvironmentVariable("FREETILITY_CAD_DATA")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FreeTility", "CadPro"));
        internal static readonly string ThumbDir = Dir(Path.Combine(DataDir, "thumbs"));
        internal static readonly string ImportDir = Dir(Path.Combine(DataDir, "import"));

        private MemoryStream export;

        private static string Dir(string p) { Directory.CreateDirectory(p); return p; }

        internal static string Json(object o) => Ser.Serialize(o);

        /// <summary>Names become file names: drop characters Windows rejects.</summary>
        internal static string Safe(string n)
        {
            string s = Regex.Replace(n ?? "", "[\\\\/:*?\"<>|\\x00-\\x1F]", "").Trim().TrimEnd('.');
            if (s.Length > 80) s = s.Substring(0, 80).Trim();
            return s.Length == 0 ? "Part" : s;
        }

        private static string PathOf(string name) => Path.Combine(LibDir, Safe(name) + Ext);
        private static string ThumbOf(string name) => Path.Combine(ThumbDir, Safe(name) + ".png");

        internal string List()
        {
            var list = new List<object>();
            foreach (string f in Directory.GetFiles(LibDir, "*" + Ext))
            {
                string name = Path.GetFileNameWithoutExtension(f);
                var fi = new FileInfo(f);
                string th = ThumbOf(name);
                long mt = (long)(fi.LastWriteTimeUtc - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                long tt = File.Exists(th) ? (long)(File.GetLastWriteTimeUtc(th) - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds : 0;
                list.Add(new Dictionary<string, object> { { "name", name }, { "mtime", mt }, { "size", fi.Length }, { "thumb", tt } });
            }
            return Json(list);
        }

        internal string Load(string name)
        {
            try { return File.ReadAllText(PathOf(name), Encoding.UTF8); } catch { return null; }
        }

        internal bool Exists(string name) => File.Exists(PathOf(name));

        internal string FreeName(string b)
        {
            string s = Safe(b), n = s;
            for (int i = 2; File.Exists(PathOf(n)); i++) n = s + " (" + i + ")";
            return n;
        }

        /// <summary>Write through a temp file so a crash never leaves a half-written part.</summary>
        internal bool Save(string name, string json)
        {
            try
            {
                string p = PathOf(name), tmp = p + ".tmp";
                File.WriteAllText(tmp, json, new UTF8Encoding(false));
                if (File.Exists(p)) File.Replace(tmp, p, null); else File.Move(tmp, p);
                return true;
            }
            catch (Exception e) { Log.Write("save " + name + ": " + e.Message); return false; }
        }

        internal bool SaveThumb(string name, string dataUrl)
        {
            try
            {
                int c = dataUrl.IndexOf(',');
                File.WriteAllBytes(ThumbOf(name), Convert.FromBase64String(dataUrl.Substring(c + 1)));
                return true;
            }
            catch { return false; }
        }

        /// <summary>Deleted parts go to the Recycle Bin.</summary>
        internal bool Delete(string name)
        {
            try
            {
                string p = PathOf(name);
                if (File.Exists(p)) FileSystem.DeleteFile(p, UIOption.OnlyErrorDialogs, RecycleOption.SendToRecycleBin);
                if (File.Exists(ThumbOf(name))) File.Delete(ThumbOf(name));
                return true;
            }
            catch (Exception e) { Log.Write("delete: " + e.Message); return false; }
        }

        internal string Rename(string from, string to)
        {
            string a = Safe(from), b = Safe(to);
            if (a == b) return b;
            if (File.Exists(PathOf(b))) return null;
            try
            {
                File.Move(PathOf(a), PathOf(b));
                if (File.Exists(ThumbOf(a))) File.Move(ThumbOf(a), ThumbOf(b));
                return b;
            }
            catch { return null; }
        }

        internal void ShowInFolder(string name)
        {
            try { Process.Start("explorer.exe", "/select,\"" + PathOf(name) + "\""); } catch { /* ignore */ }
        }

        /// <summary>Copies a .ftcad file into the library under a free name. Returns the name, or null.</summary>
        internal string ImportProject(string file, out string error)
        {
            error = null;
            try
            {
                string full = Path.GetFullPath(file);
                // a part already in the library opens in place
                if (string.Equals(Path.GetDirectoryName(full).TrimEnd('\\'), LibDir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                    return Path.GetFileNameWithoutExtension(full);
                string text = File.ReadAllText(full, Encoding.UTF8);
                if (!(Ser.DeserializeObject(text) is Dictionary<string, object> d) || !(d.TryGetValue("format", out object f) && "ftcad".Equals(f)))
                { error = "Not a FreeTility CAD project"; return null; }
                string name = FreeName(Path.GetFileNameWithoutExtension(full));
                File.WriteAllText(PathOf(name), text, new UTF8Encoding(false));
                return name;
            }
            catch (Exception e) { error = e.Message; return null; }
        }

        /// <summary>Copies any file into the import folder (served at /import/). Returns its URL path.</summary>
        internal string StageImport(string file)
        {
            foreach (string old in Directory.GetFiles(ImportDir)) { try { File.Delete(old); } catch { /* in use */ } }
            string safe = Safe(Path.GetFileName(file));
            File.Copy(file, Path.Combine(ImportDir, safe), true);
            return "/import/" + Uri.EscapeDataString(safe);
        }

        // ------------------------------------------------------------------ exports (JS sends base64 chunks)

        internal bool WriteBegin() { export = new MemoryStream(); return true; }

        internal bool WriteChunk(string b64)
        {
            if (export == null) return false;
            try { byte[] b = Convert.FromBase64String(b64); export.Write(b, 0, b.Length); return true; }
            catch { return false; }
        }

        internal byte[] TakeExport()
        {
            byte[] b = export?.ToArray();
            export = null;
            return b;
        }

        /// <summary>Path under the web root, thumbnails or imports for a request path.</summary>
        internal static string Resolve(string webRoot, string path)
        {
            string root, rel;
            if (path.StartsWith("/assets/", StringComparison.Ordinal)) { root = webRoot; rel = path.Substring(8); }
            else if (path.StartsWith("/thumbs/", StringComparison.Ordinal)) { root = ThumbDir; rel = path.Substring(8); }
            else if (path.StartsWith("/import/", StringComparison.Ordinal)) { root = ImportDir; rel = path.Substring(8); }
            else return null;
            string full = Path.GetFullPath(Path.Combine(root, rel.Replace('/', '\\')));
            return full.StartsWith(Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase) ? full : null;
        }

        internal static string Mime(string file)
        {
            switch (Path.GetExtension(file).ToLowerInvariant())
            {
                case ".html": return "text/html; charset=utf-8";
                case ".js": case ".mjs": return "text/javascript; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".wasm": return "application/wasm";
                case ".svg": return "image/svg+xml";
                case ".png": return "image/png";
                case ".json": return "application/json";
                case ".txt": return "text/plain; charset=utf-8";
                default: return "application/octet-stream";
            }
        }
    }

    internal static class Log
    {
        internal static void Write(string s)
        {
            try { File.AppendAllText(Path.Combine(Projects.DataDir, "log.txt"), DateTime.Now.ToString("s") + " " + s + Environment.NewLine); }
            catch { /* ignore */ }
        }
    }
}
