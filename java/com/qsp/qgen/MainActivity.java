package com.qsp.qgen;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

/**
 * QGen Android —— 唯一 Activity：一个全屏 WebView 承载编辑器界面，
 * 通过 {@link Bridge} 暴露文件读写给前端 JS 层。
 *
 * QSP 格式的解析/序列化全部在前端 qsp.js 中完成；Java 侧只负责
 * “把字节读出来 / 把字节写回去”，因此这里刻意保持薄。
 */
public class MainActivity extends Activity {

    public static final String VERSION_NAME = "1.3.11";

    /** 优先读系统里的 versionName，避免和常量不一致 */
    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return VERSION_NAME;
        }
    }

    private static final int REQ_OPEN = 1001;
    private static final int REQ_SAVE = 1002;
    private static final int REQ_VIEW_OPEN = 1003;
    private static final int REQ_ZIP_OPEN = 1004;
    private static final int REQ_ZIP_SAVE = 1005;
    private static final int REQ_TEXT_SAVE = 1006;

    private WebView web;
    private final Bridge bridge = new Bridge();

    /** 当前文档 */
    private byte[] fileData;         // 当前文件全部字节（读取后缓存）
    private String fileName;         // 显示名
    private Uri fileUri;             // SAF uri，新建文件时为 null
    private boolean writable;        // 是否可写回原位置
    private boolean pageReady = false;
    private Uri pendingUri = null;   // 页面还没加载完时先存着
    private ByteArrayOutputStream pendingWrite;
    private String pendingSaveName;  // 另存为时的建议名

    /** TXT 工程 zip 的临时数据，与当前 .qsp 文档互不影响 */
    private byte[] zipData;
    private ByteArrayOutputStream pendingZip;
    private byte[] pendingZipOut;
    private String pendingZipName;

    /** 文本导出（记录表 CSV） */
    private byte[] pendingTextOut;
    private String pendingTextName;

    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("qgen", MODE_PRIVATE);

        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 21) {
            w.setStatusBarColor(0xFFFFFFFF);
            w.setNavigationBarColor(0xFFFFFFFF);
        }
        if (Build.VERSION.SDK_INT >= 23) {
            int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= 27) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            w.getDecorView().setSystemUiVisibility(flags);
        }

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= 21) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return true; // 不做外部跳转
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                if (pendingUri != null) {
                    Uri u = pendingUri;
                    pendingUri = null;
                    openUri(u);
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                android.util.Log.i("QGenJS", m.message() + " (line " + m.lineNumber() + ")");
                return true;
            }
        });
        web.addJavascriptInterface(bridge, "QGenNative");
        web.setBackgroundColor(0xFFFFFFFF);

        setContentView(web);
        web.loadUrl("file:///android_asset/ui/index.html");

        // 从外部“打开方式”进入
        handleIncomingIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent);
    }

    private void handleIncomingIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            Uri uri = intent.getData();
            try {
                getContentResolver().takePersistableUriPermission(uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Exception ignored) { }
            if (pageReady) openUri(uri); else pendingUri = uri;
        }
    }

    /* ------------------------------------------------------------------ */
    /* 文件读写                                                            */
    /* ------------------------------------------------------------------ */

    private String queryName(Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            Cursor c = null;
            try {
                c = getContentResolver().query(uri, null, null, null, null);
                if (c != null && c.moveToFirst()) {
                    int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (i >= 0) name = c.getString(i);
                }
            } catch (Exception ignored) {
            } finally {
                if (c != null) c.close();
            }
        }
        if (name == null) name = uri.getLastPathSegment();
        return name == null ? "untitled.qsp" : name;
    }

    private byte[] readAllBytes(Uri uri) throws Exception {
        InputStream in = getContentResolver().openInputStream(uri);
        if (in == null) throw new Exception("无法打开文件");
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        in.close();
        return bo.toByteArray();
    }

    private void openUri(Uri uri) {
        try {
            byte[] data = readAllBytes(uri);
            fileData = data;
            fileUri = uri;
            fileName = queryName(uri);
            writable = true;
            try {
                getContentResolver().takePersistableUriPermission(uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Exception e) {
                writable = false;
            }
            addRecent(fileName, uri.toString(), data.length);
            callback("onFilePicked", ok(true).put("name", fileName).put("size", data.length)
                    .put("writable", writable));
        } catch (Exception e) {
            callback("onFilePicked", ok(false).put("message", "打开失败：" + e.getMessage()));
        }
    }

    private void writeToUri(Uri uri, byte[] data) throws Exception {
        OutputStream out = getContentResolver().openOutputStream(uri, "wt");
        if (out == null) throw new Exception("无法写入该文件");
        out.write(data);
        out.flush();
        out.close();
    }

    /* ------------------------------------------------------------------ */
    /* 回调前端                                                            */
    /* ------------------------------------------------------------------ */

    /** 对 org.json 的受检异常做无痛封装 */
    static final class J {
        final JSONObject o = new JSONObject();
        J(Object... kv) {
            try {
                for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]);
            } catch (Exception ignored) { }
        }
        J put(String k, Object v) {
            try { o.put(k, v); } catch (Exception ignored) { }
            return this;
        }
        @Override public String toString() { return o.toString(); }
    }

    private J ok(boolean v) { return new J("ok", v); }

    private void callback(String fn, J arg) {
        final String js = "window.qgenCallback && window.qgenCallback(" +
                JSONObject.quote(fn) + "," + arg.toString() + ")";
        runOnUiThread(new Runnable() {
            @Override public void run() { web.evaluateJavascript(js, null); }
        });
    }

    private void toastMsg(final String msg) {
        runOnUiThread(new Runnable() {
            @Override public void run() { Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show(); }
        });
    }

    /* ------------------------------------------------------------------ */
    /* 最近文件                                                            */
    /* ------------------------------------------------------------------ */

    private void addRecent(String name, String uri, long size) {
        try {
            JSONArray arr = new JSONArray(prefs.getString("recent", "[]"));
            JSONArray out = new JSONArray();
            JSONObject item = new JSONObject();
            item.put("name", name);
            item.put("uri", uri);
            item.put("size", size);
            item.put("time", System.currentTimeMillis());
            out.put(item);
            for (int i = 0; i < arr.length() && out.length() < 12; i++) {
                JSONObject o = arr.getJSONObject(i);
                if (!uri.equals(o.optString("uri"))) out.put(o);
            }
            prefs.edit().putString("recent", out.toString()).apply();
        } catch (Exception ignored) { }
    }

    private String recentJson() {
        return prefs.getString("recent", "[]");
    }

    /* ------------------------------------------------------------------ */
    /* 返回键                                                              */
    /* ------------------------------------------------------------------ */

    @Override
    public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        web.evaluateJavascript("(window.qgenBack && window.qgenBack()) === true",
                new android.webkit.ValueCallback<String>() {
                    @Override public void onReceiveValue(String value) {
                        if (!"true".equals(value)) {
                            // 交给 JS 的退出确认（可能弹框），否则直接退出
                            web.evaluateJavascript("window.qgenRequestExit && window.qgenRequestExit()", null);
                        }
                    }
                });
    }

    /* ------------------------------------------------------------------ */
    /* JS 桥                                                               */
    /* ------------------------------------------------------------------ */

    public class Bridge {

        @JavascriptInterface
        public String appInfo() {
            JSONObject o = new JSONObject();
            try {
                o.put("app", "QGen Android");
                o.put("version", versionName());
                o.put("sdk", Build.VERSION.SDK_INT);
                o.put("device", Build.MODEL);
            } catch (Exception ignored) { }
            return o.toString();
        }

        @JavascriptInterface
        public void pickOpen() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                    try {
                        startActivityForResult(i, REQ_OPEN);
                    } catch (Exception e) {
                        toastMsg("没有可用的文件选择器");
                    }
                }
            });
        }

        @JavascriptInterface
        public void openRecent(final String uri) {
            runOnUiThread(new Runnable() {
                @Override public void run() { openUri(Uri.parse(uri)); }
            });
        }

        @JavascriptInterface
        public String recentFiles() { return recentJson(); }

        @JavascriptInterface
        public void clearRecent() { prefs.edit().putString("recent", "[]").apply(); }

        @JavascriptInterface
        public String currentFile() {
            JSONObject o = new JSONObject();
            try {
                o.put("name", fileName == null ? "" : fileName);
                o.put("uri", fileUri == null ? "" : fileUri.toString());
                o.put("size", fileData == null ? 0 : fileData.length);
                o.put("writable", writable);
            } catch (Exception ignored) { }
            return o.toString();
        }

        /** 读取当前文件的一段（base64），offset/len 以字节计 */
        @JavascriptInterface
        public String readChunk(int offset, int len) {
            if (fileData == null) return "";
            int start = Math.max(0, Math.min(offset, fileData.length));
            int end = Math.max(start, Math.min(start + len, fileData.length));
            return Base64.encodeToString(fileData, start, end - start, Base64.NO_WRAP);
        }

        @JavascriptInterface
        public void beginWrite() { pendingWrite = new ByteArrayOutputStream(); }

        @JavascriptInterface
        public void writeChunk(String b64) {
            if (pendingWrite == null) pendingWrite = new ByteArrayOutputStream();
            byte[] b = Base64.decode(b64, Base64.DEFAULT);
            pendingWrite.write(b, 0, b.length);
        }

        @JavascriptInterface
        public void endWrite() {
            final byte[] data = pendingWrite == null ? new byte[0] : pendingWrite.toByteArray();
            pendingWrite = null;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (fileUri == null) {
                        callback("onWritten", ok(false).put("needSaveAs", true));
                        return;
                    }
                    try {
                        writeToUri(fileUri, data);
                        fileData = data;
                        addRecent(fileName, fileUri.toString(), data.length);
                        callback("onWritten", ok(true).put("size", data.length).put("name", fileName));
                    } catch (Exception e) {
                        callback("onWritten", ok(false).put("message", "保存失败：" + e.getMessage()));
                    }
                }
            });
        }

        @JavascriptInterface
        public void saveAs(final String suggestedName) {
            pendingSaveName = suggestedName;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("application/octet-stream");
                    i.putExtra(Intent.EXTRA_TITLE, suggestedName == null ? "game.qsp" : suggestedName);
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                    try {
                        startActivityForResult(i, REQ_SAVE);
                    } catch (Exception e) {
                        toastMsg("没有可用的文件选择器");
                    }
                }
            });
        }

        /** 选择要导入的 TXT 工程 .zip */
        @JavascriptInterface
        public void pickZip() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                            "application/zip", "application/x-zip-compressed",
                            "application/octet-stream", "text/plain"});
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                    try {
                        startActivityForResult(i, REQ_ZIP_OPEN);
                    } catch (Exception e) {
                        toastMsg("没有可用的文件选择器");
                    }
                }
            });
        }

        /** 读取 pickZip 选中的 zip 的一段（base64） */
        @JavascriptInterface
        public String readZipChunk(int offset, int len) {
            if (zipData == null) return "";
            int start = Math.max(0, Math.min(offset, zipData.length));
            int end = Math.max(start, Math.min(start + len, zipData.length));
            return Base64.encodeToString(zipData, start, end - start, Base64.NO_WRAP);
        }

        @JavascriptInterface
        public void beginZipWrite() { pendingZip = new ByteArrayOutputStream(); }

        @JavascriptInterface
        public void writeZipChunk(String b64) {
            if (pendingZip == null) pendingZip = new ByteArrayOutputStream();
            byte[] b = Base64.decode(b64, Base64.DEFAULT);
            pendingZip.write(b, 0, b.length);
        }

        /** 结束写入并弹出系统「另存为」，保存成功后回调 onZipSaved */
        @JavascriptInterface
        public void saveZip(final String suggestedName) {
            final byte[] data = pendingZip == null ? new byte[0] : pendingZip.toByteArray();
            pendingZip = null;
            if (data.length == 0) { toastMsg("没有可保存的内容"); return; }
            pendingZipOut = data;
            pendingZipName = suggestedName == null ? "qgen-txt.zip" : suggestedName;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("application/zip");
                    i.putExtra(Intent.EXTRA_TITLE, pendingZipName);
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                    try {
                        startActivityForResult(i, REQ_ZIP_SAVE);
                    } catch (Exception e) {
                        pendingZipOut = null;
                        toastMsg("没有可用的文件选择器");
                    }
                }
            });
        }

        /** 保存 UTF-8 文本（记录表 CSV），成功后回调 onTextSaved */
        @JavascriptInterface
        public void saveText(final String text, final String suggestedName) {
            byte[] data;
            try {
                data = (text == null ? "" : text).getBytes("UTF-8");
            } catch (Exception e) {
                toastMsg("文本编码失败");
                return;
            }
            if (data.length == 0) { toastMsg("没有可保存的内容"); return; }
            pendingTextOut = data;
            pendingTextName = suggestedName == null ? "qgen-records.csv" : suggestedName;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("text/csv");
                    i.putExtra(Intent.EXTRA_TITLE, pendingTextName);
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                    try {
                        startActivityForResult(i, REQ_TEXT_SAVE);
                    } catch (Exception e) {
                        pendingTextOut = null;
                        toastMsg("没有可用的文件选择器");
                    }
                }
            });
        }

        /** 仅允许访问本机回环的简单 GET（给「关于」里的 MCP 状态检测用） */
        @JavascriptInterface
        public String httpGet(String url) {
            if (url == null) return "";
            if (!(url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:"))) return "";
            java.net.HttpURLConnection c = null;
            try {
                c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                c.setConnectTimeout(1500);
                c.setReadTimeout(2000);
                c.setRequestMethod("GET");
                java.io.InputStream in = c.getInputStream();
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                in.close();
                return new String(bo.toByteArray(), "UTF-8");
            } catch (Exception e) {
                return "";
            } finally {
                if (c != null) c.disconnect();
            }
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(new Runnable() {
                @Override public void run() { Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show(); }
            });
        }

        @JavascriptInterface
        public void vibrate(int ms) { /* 预留 */ }

        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(new Runnable() {
                @Override public void run() { finish(); }
            });
        }

        @JavascriptInterface
        public void setKeepAwake(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        /* -------- 开发/调试用：列出应用私有目录中的文件 -------- */

        @JavascriptInterface
        public String devFiles() {
            JSONArray arr = new JSONArray();
            List<File> dirs = new ArrayList<>();
            File ext = getExternalFilesDir(null);
            if (ext != null) dirs.add(ext);
            dirs.add(getFilesDir());
            for (File d : dirs) {
                File[] fs = d.listFiles();
                if (fs == null) continue;
                Arrays.sort(fs, new Comparator<File>() {
                    @Override public int compare(File a, File b) { return a.getName().compareTo(b.getName()); }
                });
                for (File f : fs) {
                    if (!f.isFile()) continue;
                    try {
                        JSONObject o = new JSONObject();
                        o.put("name", f.getName());
                        o.put("path", f.getAbsolutePath());
                        o.put("size", f.length());
                        arr.put(o);
                    } catch (Exception ignored) { }
                }
            }
            return arr.toString();
        }

        /** 仅允许打开应用私有目录内的文件（调试/示例用） */
        @JavascriptInterface
        public void devOpen(final String path) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        File f = new File(path);
                        String abs = f.getCanonicalPath();
                        boolean allowed = false;
                        File ext = getExternalFilesDir(null);
                        if (ext != null && abs.startsWith(ext.getCanonicalPath())) allowed = true;
                        if (abs.startsWith(getFilesDir().getCanonicalPath())) allowed = true;
                        if (!allowed) { toastMsg("不允许的路径"); return; }
                        FileInputStream in = new FileInputStream(f);
                        ByteArrayOutputStream bo = new ByteArrayOutputStream();
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                        in.close();
                        fileData = bo.toByteArray();
                        fileUri = Uri.fromFile(f);
                        fileName = f.getName();
                        writable = true;
                        callback("onFilePicked", ok(true).put("name", fileName).put("size", fileData.length)
                                .put("writable", true).put("path", abs));
                    } catch (Exception e) {
                        callback("onFilePicked", ok(false).put("message", e.getMessage()));
                    }
                }
            });
        }

        @JavascriptInterface
        public void saveToPrivate(final String name) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (pendingWrite == null && fileData == null) { toastMsg("没有内容"); return; }
                    try {
                        File dir = getExternalFilesDir(null);
                        if (dir == null) dir = getFilesDir();
                        if (!dir.exists()) dir.mkdirs();
                        File f = new File(dir, name == null ? "game.qsp" : name);
                        FileOutputStream out = new FileOutputStream(f);
                        byte[] data = pendingWrite != null ? pendingWrite.toByteArray() : fileData;
                        out.write(data);
                        out.flush();
                        out.close();
                        callback("onWritten", ok(true).put("size", data.length).put("name", f.getName())
                                .put("path", f.getAbsolutePath()));
                    } catch (Exception e) {
                        callback("onWritten", ok(false).put("message", "写入失败：" + e.getMessage()));
                    }
                }
            });
        }
    }

    /* ------------------------------------------------------------------ */
    /* 结果回调                                                            */
    /* ------------------------------------------------------------------ */

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            if (requestCode == REQ_OPEN) callback("onFilePicked", ok(false).put("canceled", true));
            if (requestCode == REQ_SAVE) callback("onSaveAsPicked", ok(false).put("canceled", true));
            if (requestCode == REQ_ZIP_OPEN) callback("onZipPicked", ok(false).put("canceled", true));
            if (requestCode == REQ_ZIP_SAVE) {
                pendingZipOut = null;
                callback("onZipSaved", ok(false).put("canceled", true));
            }
            if (requestCode == REQ_TEXT_SAVE) {
                pendingTextOut = null;
                callback("onTextSaved", ok(false).put("canceled", true));
            }
            return;
        }
        Uri uri = data.getData();
        if (requestCode == REQ_OPEN) {
            try {
                getContentResolver().takePersistableUriPermission(uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Exception ignored) { }
            openUri(uri);
        } else if (requestCode == REQ_SAVE) {
            try {
                getContentResolver().takePersistableUriPermission(uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                writable = true;
            } catch (Exception ignored) { writable = false; }
            fileUri = uri;
            fileName = queryName(uri);
            callback("onSaveAsPicked", ok(true).put("name", fileName));
        } else if (requestCode == REQ_ZIP_OPEN) {
            try {
                getContentResolver().takePersistableUriPermission(uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) { }
            try {
                zipData = readAllBytes(uri);
                callback("onZipPicked", ok(true).put("name", queryName(uri))
                        .put("size", zipData.length));
            } catch (Exception e) {
                zipData = null;
                callback("onZipPicked", ok(false).put("message", "读取 ZIP 失败：" + e.getMessage()));
            }
        } else if (requestCode == REQ_ZIP_SAVE) {
            byte[] out = pendingZipOut;
            pendingZipOut = null;
            if (out == null) {
                callback("onZipSaved", ok(false).put("message", "没有待保存的数据"));
                return;
            }
            try {
                writeToUri(uri, out);
                callback("onZipSaved", ok(true).put("name", queryName(uri)).put("size", out.length));
            } catch (Exception e) {
                callback("onZipSaved", ok(false).put("message", "保存 ZIP 失败：" + e.getMessage()));
            }
        } else if (requestCode == REQ_TEXT_SAVE) {
            byte[] out = pendingTextOut;
            pendingTextOut = null;
            if (out == null) {
                callback("onTextSaved", ok(false).put("message", "没有待保存的数据"));
                return;
            }
            try {
                writeToUri(uri, out);
                callback("onTextSaved", ok(true).put("name", queryName(uri)).put("size", out.length));
            } catch (Exception e) {
                callback("onTextSaved", ok(false).put("message", "保存文本失败：" + e.getMessage()));
            }
        }
    }
}
