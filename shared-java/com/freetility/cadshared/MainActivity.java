package com.freetility.cadshared;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.view.HapticFeedbackConstants;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedDispatcher;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * FreeTility CAD and FreeTility CAD PRO shell (shared by both apps): a full-screen WebView that runs the web UI from assets,
 * plus a small bridge (window.Native) for project files, export and import.
 * Events go to the page through window.onNative(event, data).
 */
public class MainActivity extends Activity {

    private static final String TAG = "FreeTilityCAD";
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/assets/index.html";
    private static final String EXT = ".ftcad";

    private static final int REQ_EXPORT = 21;
    private static final int REQ_IMPORT = 22;
    private static final int REQ_PICK = 23;

    private WebView web;
    private FrameLayout root;
    private File projDir, thumbDir, shareDir, importDir;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<String> pendingJs = new ArrayList<>();
    private boolean jsReady = false;

    /** Export buffer: JS sends base64 chunks, then writeEnd() saves or shares the file. */
    private ByteArrayOutputStream exportBuf;
    private File pendingExport;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        projDir = mkdir(new File(getFilesDir(), "projects"));
        thumbDir = mkdir(new File(getFilesDir(), "thumbs"));
        shareDir = mkdir(new File(getCacheDir(), "share"));
        importDir = mkdir(new File(getCacheDir(), "import"));

        root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        applyBars();
        setupInsets();

        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .addPathHandler("/thumbs/", new WebViewAssetLoader.InternalStoragePathHandler(this, thumbDir))
                .addPathHandler("/import/", new WebViewAssetLoader.InternalStoragePathHandler(this, importDir))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse r = loader.shouldInterceptRequest(request.getUrl());
                String p = request.getUrl().getPath();
                if (r != null && p != null && p.endsWith(".wasm")) r.setMimeType("application/wasm");
                return r;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (HOST.equals(uri.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "Native");

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }

        web.loadUrl(START_URL);
        if (savedInstanceState == null) handleIntent(getIntent());
    }

    // ------------------------------------------------------------------ window

    private void setupInsets() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            });
        } else {
            root.setFitsSystemWindows(true);
        }
    }

    /** The UI is always dark, so the system bars use light icons. */
    @SuppressWarnings("deprecation")
    private void applyBars() {
        int bg = Color.parseColor("#111A1C");
        root.setBackgroundColor(bg);
        web.setBackgroundColor(bg);
        getWindow().setStatusBarColor(Build.VERSION.SDK_INT >= 30 ? Color.TRANSPARENT : bg);
        getWindow().setNavigationBarColor(Build.VERSION.SDK_INT >= 30 ? Color.TRANSPARENT : bg);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(0, light);
            }
        }
    }

    private void handleBack() {
        if (web == null) {
            moveTaskToBack(true);
            return;
        }
        web.evaluateJavascript("(window.__androidBack && window.__androidBack()) ? 'handled' : 'exit'",
                result -> {
                    if (!"\"handled\"".equals(result)) moveTaskToBack(true);
                });
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        handleBack();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        // Let the page save the open project before the app goes to the background.
        if (web != null && jsReady) web.evaluateJavascript("window.onNative&&window.onNative('pause',{})", null);
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        worker.shutdown();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    // ------------------------------------------------------------------ JS events

    /** Call window.onNative(event, data) in the page; queued until the page says it is ready. */
    private void emit(String event, JSONObject data) {
        String js = "window.onNative&&window.onNative(" + JSONObject.quote(event) + ","
                + (data == null ? "{}" : data.toString()) + ")";
        main.post(() -> {
            if (!jsReady) pendingJs.add(js);
            else if (web != null) web.evaluateJavascript(js, null);
        });
    }

    private static JSONObject obj(Object... kv) {
        JSONObject o = new JSONObject();
        try {
            for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]);
        } catch (Exception ignored) {
        }
        return o;
    }

    // ------------------------------------------------------------------ intents

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        Uri u = null;
        if (Intent.ACTION_VIEW.equals(intent.getAction())) u = intent.getData();
        else if (Intent.ACTION_SEND.equals(intent.getAction())) u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (u != null) {
            final Uri uri = u;
            worker.execute(() -> importFrom(uri));
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_EXPORT) {
            final File f = pendingExport;
            pendingExport = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null || f == null) {
                emit("exported", obj("ok", false, "cancelled", true));
                return;
            }
            final Uri dest = data.getData();
            worker.execute(() -> {
                try (InputStream in = new FileInputStream(f);
                     OutputStream out = getContentResolver().openOutputStream(dest, "wt")) {
                    copy(in, out);
                    emit("exported", obj("ok", true));
                } catch (Exception e) {
                    Log.w(TAG, "export", e);
                    emit("exported", obj("ok", false, "message", String.valueOf(e.getMessage())));
                }
            });
        } else if (requestCode == REQ_PICK) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                emit("filePicked", obj("ok", false));
                return;
            }
            final Uri u = data.getData();
            worker.execute(() -> {
                try {
                    String name = displayName(u);
                    if (name == null) name = "file";
                    String safe = safeName(name);
                    File[] old = importDir.listFiles();
                    if (old != null) for (File f : old) //noinspection ResultOfMethodCallIgnored
                        f.delete();
                    File out = new File(importDir, safe);
                    try (InputStream in = getContentResolver().openInputStream(u);
                         OutputStream o = new FileOutputStream(out)) {
                        if (in == null) throw new IOException("Cannot open file");
                        copy(in, o);
                    }
                    emit("filePicked", obj("ok", true, "name", name,
                            "url", "/import/" + Uri.encode(safe), "size", out.length()));
                } catch (Exception e) {
                    Log.w(TAG, "pick", e);
                    emit("filePicked", obj("ok", false, "message", String.valueOf(e.getMessage())));
                }
            });
        } else if (requestCode == REQ_IMPORT) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
            final Uri u = data.getData();
            worker.execute(() -> importFrom(u));
        }
    }

    /** Copy a .ftcad file into the project folder under a free name. */
    private void importFrom(Uri u) {
        try {
            String name = displayName(u);
            if (name == null) name = "Imported";
            if (name.toLowerCase().endsWith(EXT)) name = name.substring(0, name.length() - EXT.length());
            String text;
            try (InputStream in = getContentResolver().openInputStream(u)) {
                if (in == null) throw new IOException("Cannot open file");
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                copy(in, bo);
                if (bo.size() > 64 * 1024 * 1024) throw new IOException("File is too large");
                text = bo.toString("UTF-8");
            }
            JSONObject check = new JSONObject(text);
            if (!"ftcad".equals(check.optString("format"))) throw new IOException("Not a FreeTility CAD project");
            String free = freeName(safeName(name));
            writeText(new File(projDir, free + EXT), text);
            emit("imported", obj("ok", true, "name", free));
        } catch (Exception e) {
            Log.w(TAG, "import", e);
            emit("imported", obj("ok", false, "message", String.valueOf(e.getMessage())));
        }
    }

    private String displayName(Uri u) {
        try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
        }
        String p = u.getLastPathSegment();
        return p == null ? null : p.substring(p.lastIndexOf('/') + 1);
    }

    // ------------------------------------------------------------------ files

    private static File mkdir(File f) {
        if (!f.exists()) //noinspection ResultOfMethodCallIgnored
            f.mkdirs();
        return f;
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] b = new byte[65536];
        int n;
        while ((n = in.read(b)) > 0) out.write(b, 0, n);
    }

    private static String readText(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            copy(in, bo);
            return bo.toString("UTF-8");
        }
    }

    /** Write through a temp file so a crash never leaves a half-written project. */
    private static void writeText(File f, String text) throws IOException {
        File tmp = new File(f.getParentFile(), f.getName() + ".tmp");
        try (OutputStream out = new FileOutputStream(tmp)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
        if (f.exists() && !f.delete()) throw new IOException("Cannot replace " + f.getName());
        if (!tmp.renameTo(f)) throw new IOException("Cannot write " + f.getName());
    }

    /** Project names become file names: drop characters Android file systems reject. */
    private static String safeName(String n) {
        String s = n == null ? "" : n.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1F]", "").trim();
        if (s.length() > 80) s = s.substring(0, 80).trim();
        return s.isEmpty() ? "Part" : s;
    }

    private String freeName(String base) {
        String n = base;
        int i = 2;
        while (new File(projDir, n + EXT).exists()) n = base + " (" + (i++) + ")";
        return n;
    }

    // ------------------------------------------------------------------ bridge

    private class Bridge {

        @JavascriptInterface
        public void ready() {
            main.post(() -> {
                jsReady = true;
                for (String js : pendingJs) web.evaluateJavascript(js, null);
                pendingJs.clear();
            });
        }

        @JavascriptInterface
        public String platform() {
            return "android";
        }

        @JavascriptInterface
        public String version() {
            try {
                PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                return pi.versionName;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void haptic() {
            main.post(() -> web.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY));
        }

        @JavascriptInterface
        public String listProjects() {
            JSONArray a = new JSONArray();
            File[] files = projDir.listFiles();
            if (files != null) {
                for (File f : files) {
                    String n = f.getName();
                    if (!n.endsWith(EXT)) continue;
                    String name = n.substring(0, n.length() - EXT.length());
                    File th = new File(thumbDir, name + ".png");
                    a.put(obj("name", name, "mtime", f.lastModified(), "size", f.length(),
                            "thumb", th.exists() ? th.lastModified() : 0));
                }
            }
            return a.toString();
        }

        @JavascriptInterface
        public String loadProject(String name) {
            try {
                return readText(new File(projDir, safeName(name) + EXT));
            } catch (Exception e) {
                return null;
            }
        }

        @JavascriptInterface
        public boolean projectExists(String name) {
            return new File(projDir, safeName(name) + EXT).exists();
        }

        @JavascriptInterface
        public String freeProjectName(String base) {
            return freeName(safeName(base));
        }

        @JavascriptInterface
        public boolean saveProject(String name, String json) {
            try {
                writeText(new File(projDir, safeName(name) + EXT), json);
                return true;
            } catch (Exception e) {
                Log.w(TAG, "save", e);
                return false;
            }
        }

        /** Thumbnail as a data URL (image/png or image/jpeg), shown on the project list. */
        @JavascriptInterface
        public boolean saveThumb(String name, String dataUrl) {
            try {
                int comma = dataUrl.indexOf(',');
                byte[] b = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
                try (OutputStream out = new FileOutputStream(new File(thumbDir, safeName(name) + ".png"))) {
                    out.write(b);
                }
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean deleteProject(String name) {
            String n = safeName(name);
            //noinspection ResultOfMethodCallIgnored
            new File(thumbDir, n + ".png").delete();
            return new File(projDir, n + EXT).delete();
        }

        @JavascriptInterface
        public String renameProject(String from, String to) {
            String a = safeName(from), b = safeName(to);
            if (a.equals(b)) return b;
            if (new File(projDir, b + EXT).exists()) return null;
            if (!new File(projDir, a + EXT).renameTo(new File(projDir, b + EXT))) return null;
            //noinspection ResultOfMethodCallIgnored
            new File(thumbDir, a + ".png").renameTo(new File(thumbDir, b + ".png"));
            return b;
        }

        @JavascriptInterface
        public void importProject() {
            main.post(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(i, REQ_IMPORT);
                } catch (ActivityNotFoundException e) {
                    emit("imported", obj("ok", false, "message", "No file picker found"));
                }
            });
        }

        /** Pick any file; it is copied to the app cache and announced with the "filePicked" event. */
        @JavascriptInterface
        public void pickFile(String accept) {
            main.post(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(i, REQ_PICK);
                } catch (ActivityNotFoundException e) {
                    emit("filePicked", obj("ok", false, "message", "No file picker found"));
                }
            });
        }

        @JavascriptInterface
        public synchronized void writeBegin() {
            exportBuf = new ByteArrayOutputStream();
        }

        @JavascriptInterface
        public synchronized boolean writeChunk(String b64) {
            if (exportBuf == null) return false;
            try {
                exportBuf.write(Base64.decode(b64, Base64.DEFAULT));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        /** mode "save" asks where to save the file; "share" opens the share sheet. */
        @JavascriptInterface
        public synchronized boolean writeEnd(String fileName, String mime, String mode) {
            if (exportBuf == null) return false;
            final byte[] bytes = exportBuf.toByteArray();
            exportBuf = null;
            final String fname = safeName(fileName);
            final File f = new File(shareDir, fname);
            try (OutputStream out = new FileOutputStream(f)) {
                out.write(bytes);
            } catch (IOException e) {
                Log.w(TAG, "writeEnd", e);
                return false;
            }
            main.post(() -> {
                if ("share".equals(mode)) {
                    Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".files", f);
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType(mime);
                    send.putExtra(Intent.EXTRA_STREAM, uri);
                    send.setClipData(ClipData.newRawUri(fname, uri));
                    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    try {
                        startActivity(Intent.createChooser(send, "Share " + fname));
                        emit("exported", obj("ok", true, "shared", true));
                    } catch (ActivityNotFoundException e) {
                        emit("exported", obj("ok", false, "message", "No app to share with"));
                    }
                } else {
                    pendingExport = f;
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType(mime);
                    i.putExtra(Intent.EXTRA_TITLE, fname);
                    try {
                        startActivityForResult(i, REQ_EXPORT);
                    } catch (ActivityNotFoundException e) {
                        emit("exported", obj("ok", false, "message", "No file saver found"));
                    }
                }
            });
            return true;
        }
    }
}
