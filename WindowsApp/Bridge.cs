using System.Runtime.InteropServices;

namespace FreeTility.CadPro
{
    /// <summary>
    /// window.Native for the web UI: the same method names as the Android bridge
    /// (CADApp/shared-java/.../MainActivity.java). Called synchronously from JS through
    /// chrome.webview.hostObjects.sync on the UI thread, so dialogs are posted and their
    /// results come back as events (imported, filePicked, exported).
    /// </summary>
    [ClassInterface(ClassInterfaceType.AutoDual)]
    [ComVisible(true)]
    public class Bridge
    {
        private readonly MainForm form;
        private readonly Projects lib;

        internal Bridge(MainForm form, Projects lib)
        {
            this.form = form;
            this.lib = lib;
        }

        public void ready() => form.OnJsReady();
        public string platform() => "windows";
        public string version() => MainForm.Version;
        public void haptic() { /* no vibration on PCs */ }

        public string listProjects() => lib.List();
        public string loadProject(string name) => lib.Load(name);
        public bool projectExists(string name) => lib.Exists(name);
        public string freeProjectName(string b) => lib.FreeName(b);
        public bool saveProject(string name, string json) => lib.Save(name, json);
        public bool saveThumb(string name, string dataUrl) => lib.SaveThumb(name, dataUrl);
        public bool deleteProject(string name) => lib.Delete(name);
        public string renameProject(string from, string to) => lib.Rename(from, to);
        public void showInFolder(string name) => lib.ShowInFolder(name);

        public void importProject() => form.PickProject();
        public void pickFile(string accept) => form.PickFile(accept);

        public bool writeBegin() => lib.WriteBegin();
        public bool writeChunk(string b64) => lib.WriteChunk(b64);
        public bool writeEnd(string fileName, string mime, string mode) => form.SaveExport(fileName, mime);
    }
}
