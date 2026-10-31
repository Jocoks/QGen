/*!
 * native.js — 与 Android 宿主（MainActivity.Bridge）之间的桥接层。
 * 在桌面浏览器里打开时会自动降级为“演示模式”（用 fetch + 内存模拟），
 * 方便在没有安装 APK 的情况下调试界面。
 */
(function (global) {
  'use strict';

  var handlers = {};          // fn -> [cb]
  var hasNative = typeof QGenNative !== 'undefined';

  /* ---------- base64 工具 ---------- */
  function b64ToBytes(b64) {
    var bin = atob(b64);
    var n = bin.length;
    var u8 = new Uint8Array(n);
    for (var i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function bytesToB64(u8) {
    var s = '';
    var CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
    }
    return btoa(s);
  }

  function fire(fn, arg) {
    var list = handlers[fn];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](arg); } catch (e) { console.error('callback error', fn, e); }
    }
  }
  global.qgenCallback = fire;

  /* ---------- 原生桥 ---------- */
  var Native = {
    available: hasNative,
    demo: !hasNative,

    on: function (fn, cb) {
      (handlers[fn] || (handlers[fn] = [])).push(cb);
    },
    off: function (fn, cb) {
      var l = handlers[fn];
      if (!l) return;
      var i = l.indexOf(cb);
      if (i >= 0) l.splice(i, 1);
    },

    appInfo: function () {
      if (!hasNative) return { app: 'QGen Android', version: '1.0.0-demo', sdk: 0, device: 'browser' };
      try { return JSON.parse(QGenNative.appInfo()); } catch (e) { return {}; }
    },

    pickOpen: function () { if (hasNative) QGenNative.pickOpen(); },
    pickZip: function () { if (hasNative) QGenNative.pickZip(); },
    openRecent: function (uri) { if (hasNative) QGenNative.openRecent(uri); },
    recentFiles: function () {
      if (!hasNative) return [];
      try { return JSON.parse(QGenNative.recentFiles() || '[]'); } catch (e) { return []; }
    },
    clearRecent: function () { if (hasNative) QGenNative.clearRecent(); },
    currentFile: function () {
      if (!hasNative) return {};
      try { return JSON.parse(QGenNative.currentFile() || '{}'); } catch (e) { return {}; }
    },
    readChunk: function (off, len) { return hasNative ? QGenNative.readChunk(off, len) : ''; },
    beginWrite: function () { if (hasNative) QGenNative.beginWrite(); },
    writeChunk: function (b64) { if (hasNative) QGenNative.writeChunk(b64); },
    endWrite: function () { if (hasNative) QGenNative.endWrite(); },
    saveAs: function (name) { if (hasNative) QGenNative.saveAs(name); },
    devFiles: function () {
      if (!hasNative) return [];
      try { return JSON.parse(QGenNative.devFiles() || '[]'); } catch (e) { return []; }
    },
    devOpen: function (p) { if (hasNative) QGenNative.devOpen(p); },
    saveToPrivate: function (name) { if (hasNative) QGenNative.saveToPrivate(name); },
    toast: function (m) { if (hasNative) QGenNative.toast(m); },
    httpGet: function (url) {
      if (!hasNative) return '';
      try { return QGenNative.httpGet(url) || ''; } catch (e) { return ''; }
    },
    exitApp: function () { if (hasNative) QGenNative.exitApp(); },
    setKeepAwake: function (on) { if (hasNative) QGenNative.setKeepAwake(on); },

    /* 整文件读取（分块过桥，避免大字符串） */
    readAll: function (cb) {
      var CHUNK = 1 << 20;
      var chunks = [];
      function step(off) {
        var b64 = Native.readChunk(off, CHUNK);
        if (!b64) { done(); return; }
        var bytes = b64ToBytes(b64);
        chunks.push(bytes);
        if (bytes.length < CHUNK) { done(); return; }
        setTimeout(function () { step(off + bytes.length); }, 0);
      }
      function done() {
        var total = 0, i;
        for (i = 0; i < chunks.length; i++) total += chunks[i].length;
        var out = new Uint8Array(total);
        var o = 0;
        for (i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
        cb(out);
      }
      step(0);
    },

    /* 整文件写入 */
    writeAll: function (u8) {
      Native.beginWrite();
      var CHUNK = 1 << 19; // 512 KiB
      for (var i = 0; i < u8.length; i += CHUNK) {
        Native.writeChunk(bytesToB64(u8.subarray(i, Math.min(i + CHUNK, u8.length))));
      }
      Native.endWrite();
    },

    /* ---------- TXT 工程 zip 的读取 / 写入（与 .qsp 的当前文档分开） ---------- */

    readZipChunk: function (off, len) {
      return hasNative ? QGenNative.readZipChunk(off, len) : '';
    },

    readZipAll: function (cb) {
      if (!hasNative) { cb(new Uint8Array(0)); return; }
      var CHUNK = 1 << 20;
      var chunks = [];
      function step(off) {
        var b64 = Native.readZipChunk(off, CHUNK);
        if (!b64) { done(); return; }
        var bytes = b64ToBytes(b64);
        chunks.push(bytes);
        if (bytes.length < CHUNK) { done(); return; }
        setTimeout(function () { step(off + bytes.length); }, 0);
      }
      function done() {
        var total = 0, i;
        for (i = 0; i < chunks.length; i++) total += chunks[i].length;
        var out = new Uint8Array(total);
        var o = 0;
        for (i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
        cb(out);
      }
      step(0);
    },

    /* 把 zip 字节交给 Java：分块缓存，然后弹系统「另存为」 */
    writeZip: function (u8, name) {
      if (!hasNative) return;
      QGenNative.beginZipWrite();
      var CHUNK = 1 << 19;
      for (var i = 0; i < u8.length; i += CHUNK) {
        QGenNative.writeZipChunk(bytesToB64(u8.subarray(i, Math.min(i + CHUNK, u8.length))));
      }
      QGenNative.saveZip(name || 'qgen-txt.zip');
    },

    /* 导出 UTF-8 文本（CSV），弹出系统「另存为」 */
    saveText: function (text, name) {
      if (!hasNative) return;
      QGenNative.saveText(text == null ? '' : String(text), name || 'qgen-records.csv');
    },

    /* ---------- 内置 MCP：本机文件分块 IO ---------- */
    mcpServerInfo: function () {
      if (!hasNative) return { ok: false, running: false, port: 0 };
      try { return JSON.parse(QGenNative.mcpServerInfo() || '{}'); } catch (e) { return { ok: false, running: false }; }
    },
    mcpRestart: function () { if (hasNative) QGenNative.mcpRestart(); },
    copyText: function (t) { if (hasNative) QGenNative.copyText(t); },
    mcpFileStat: function (path) {
      if (!hasNative) return { ok: false, error: '演示模式不支持本机路径' };
      try { return JSON.parse(QGenNative.mcpFileStat(path) || '{}'); } catch (e) { return { ok: false, error: e.message }; }
    },
    mcpReadChunk: function (path, off, len) {
      if (!hasNative) return { ok: false, error: '演示模式不支持本机路径' };
      try { return JSON.parse(QGenNative.mcpReadChunk(path, off, len) || '{}'); } catch (e) { return { ok: false, error: e.message }; }
    },
    mcpWriteBegin: function (path) {
      if (!hasNative) return { ok: false, error: '演示模式不支持本机路径' };
      try { return JSON.parse(QGenNative.mcpWriteBegin(path) || '{}'); } catch (e) { return { ok: false, error: e.message }; }
    },
    mcpWriteChunk: function (b64) {
      if (!hasNative) return { ok: false, error: '演示模式不支持本机路径' };
      try { return JSON.parse(QGenNative.mcpWriteChunk(b64) || '{}'); } catch (e) { return { ok: false, error: e.message }; }
    },
    mcpWriteEnd: function () {
      if (!hasNative) return { ok: false, error: '演示模式不支持本机路径' };
      try { return JSON.parse(QGenNative.mcpWriteEnd() || '{}'); } catch (e) { return { ok: false, error: e.message }; }
    },
    mcpWriteAbort: function () { if (hasNative) QGenNative.mcpWriteAbort(); },
    mcpHasAllFiles: function () { return hasNative ? !!QGenNative.mcpHasAllFiles() : false; },
    mcpRequestAllFiles: function () { if (hasNative) QGenNative.mcpRequestAllFiles(); }
  };

  /* ---------- 浏览器演示模式 ---------- */
  if (!hasNative) {
    var demoBytes = null;
    var demoName = 'jack.qsp';
    var demoZipBytes = null;

    global.qgenDemoLoad = function (bytes, name) {
      demoBytes = bytes;
      demoName = name || demoName;
      fire('onFilePicked', { ok: true, name: demoName, size: bytes.length, writable: true });
    };

    Native.pickOpen = function () {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.qsp,application/octet-stream,*/*';
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        if (!f) { fire('onFilePicked', { ok: false, canceled: true }); return; }
        var r = new FileReader();
        r.onload = function () {
          var u8 = new Uint8Array(r.result);
          demoBytes = u8;
          demoName = f.name;
          fire('onFilePicked', { ok: true, name: f.name, size: u8.length, writable: true });
        };
        r.readAsArrayBuffer(f);
      };
      inp.click();
    };

    Native.readAll = function (cb) { cb(demoBytes || new Uint8Array(0)); };

    Native.pickZip = function () {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.zip,application/zip,application/x-zip-compressed,application/octet-stream';
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        if (!f) { fire('onZipPicked', { ok: false, canceled: true }); return; }
        var r = new FileReader();
        r.onload = function () {
          var u8 = new Uint8Array(r.result);
          demoZipBytes = u8;
          fire('onZipPicked', { ok: true, name: f.name, size: u8.length });
        };
        r.readAsArrayBuffer(f);
      };
      inp.click();
    };

    Native.readZipAll = function (cb) {
      cb(demoZipBytes || new Uint8Array(0));
    };

    Native.writeZip = function (u8, name) {
      try {
        var blob = new Blob([u8], { type: 'application/zip' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name || 'qgen-txt.zip';
        a.click();
      } catch (e) { }
      setTimeout(function () {
        fire('onZipSaved', { ok: true, name: name || 'qgen-txt.zip', size: u8.length, demo: true });
      }, 50);
    };
    Native.saveText = function (text, name) {
      try {
        var blob = new Blob([text == null ? '' : String(text)], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name || 'qgen-records.csv';
        a.click();
      } catch (e) { }
      setTimeout(function () {
        fire('onTextSaved', { ok: true, name: name || 'qgen-records.csv', size: String(text || '').length, demo: true });
      }, 50);
    };
    Native.writeAll = function (u8) {
      demoBytes = u8;
      // 演示模式下把结果下载出来
      try {
        var blob = new Blob([u8], { type: 'application/octet-stream' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = demoName.replace(/\.qsp$/i, '') + '.saved.qsp';
        a.click();
      } catch (e) { }
      setTimeout(function () { fire('onWritten', { ok: true, size: u8.length, name: demoName, demo: true }); }, 50);
    };
    Native.saveAs = function (name) {
      setTimeout(function () { fire('onSaveAsPicked', { ok: true, name: name || 'game.qsp' }); }, 10);
    };
  }

  global.Native = Native;
})(window);
