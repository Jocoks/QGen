/*!
 * app.js — QGen Android 界面逻辑
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var S = {
    game: null,
    file: { name: '', uri: '', size: 0, writable: false, path: '' },
    cur: -1,
    view: 'home',
    codeWrap: false,
    codeSize: 15,
    codeLH: 1.3,
    hlOn: true,
    find: { open: false, q: '', idx: -1, marks: [] },
    query: '',
    dirty: false,
    busy: false,
    records: {
      scanned: false, busy: false, families: [], scanMs: 0, statements: 0,
      active: null, table: null, q: '', undo: [], hideEmpty: recHideEmptyPref()
    }
  };

  var LIST_RENDER_LIMIT = 400;
  var REC_ROW_LIMIT = 300;
  var REC_FAMILY_LIMIT = 200;

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function fmtTime(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    var p = function (x) { return x < 10 ? '0' + x : '' + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  function setDirty(v) {
    S.dirty = v;
    $('dirty-flag').hidden = !v;
    updateTitle();
  }

  /* ------------------------------------------------------------------ */
  /* 视图切换                                                            */
  /* ------------------------------------------------------------------ */

  function show(view) {
    S.view = view;
    $('screen-home').hidden = view !== 'home';
    $('screen-list').hidden = view !== 'list';
    $('screen-records').hidden = view !== 'records';
    $('screen-editor').hidden = view !== 'editor';
    $('btn-back').hidden = view === 'home';
    $('btn-find').hidden = view !== 'editor';
    $('btn-menu').hidden = view === 'home' || !S.game;
    updateTitle();
  }

  function updateTitle() {
    var title = $('title'), sub = $('subtitle');
    if (!S.game) {
      title.textContent = 'QGen';
      sub.textContent = 'QSP 游戏编辑器';
      return;
    }
    var nm = S.file.name || '未命名.qsp';
    if (S.view === 'records') {
      var rec = S.records;
      var active = rec.active && rec.active.descriptor;
      title.textContent = active ? active.label : '记录表';
      sub.textContent = active
        ? (rec.table ? rec.table.rows.length + ' 条记录 · ' + rec.table.columns.length + ' 列' : nm)
        : (rec.families.length ? rec.families.length + ' 个候选记录族 · ' + nm : nm);
    } else if (S.view === 'editor' && S.cur >= 0) {
      var loc = S.game.locations[S.cur];
      title.textContent = loc ? loc.name : '(未命名位置)';
      sub.textContent = nm + (S.dirty ? ' · 未保存' : '');
    } else {
      title.textContent = nm + (S.dirty ? ' ●' : '');
      sub.textContent = S.game.locations.length + ' 个位置 · ' + fmtSize(S.file.size);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 打开文件                                                            */
  /* ------------------------------------------------------------------ */

  /** 把一个已解析的游戏装进界面（打开 qsp / 导入 TXT 工程共用） */
  function adoptGame(game, file) {
    S.game = game;
    S.cur = -1;
    S.query = '';
    $('search').value = '';
    $('search-clear').hidden = true;
    S.file = file;
    resetRecords();
    if (S.find.open) closeFind();
    setDirty(!!file.dirty);
    renderList();
    show('list');
  }

  function openFromBytes(bytes, name) {
    var game;
    try {
      game = QSP.parse(bytes);
    } catch (e) {
      showModal('无法打开文件', '<h3>打开失败</h3><p>' + esc(e.message) + '</p>',
        [{ text: '好', primary: true }]);
      return;
    }
    var cf = Native.currentFile ? Native.currentFile() : {};
    adoptGame(game, {
      name: name || (cf && cf.name) || '未命名.qsp',
      uri: (cf && cf.uri) || '',
      size: bytes.length,
      writable: cf && cf.writable !== false,
      path: (cf && cf.path) || ''
    });
    toast('已打开 ' + S.file.name + '（' + game.locations.length + ' 个位置）');
  }

  Native.on('onFilePicked', function (r) {
    if (!r || !r.ok) {
      if (r && r.canceled) return;
      toast('打开失败：' + ((r && r.message) || '未知错误'));
      return;
    }
    Native.readAll(function (bytes) { openFromBytes(bytes, r.name); });
  });

  Native.on('onWritten', function (r) {
    if (r && r.ok) {
      if (r.size) S.file.size = r.size;
      if (r.name) S.file.name = r.name;
      if (r.path) S.file.path = r.path;
      setDirty(false);
      toast('已保存' + (r.path ? '：' + r.path : ''));
      renderList();
    } else if (r && r.needSaveAs) {
      askSaveAs();
    } else {
      toast('保存失败：' + ((r && r.message) || '未知错误'));
    }
  });

  Native.on('onSaveAsPicked', function (r) {
    if (!r || !r.ok) { toast('已取消另存为'); return; }
    S.file.name = r.name || S.file.name;
    S.file.uri = (Native.currentFile() || {}).uri || S.file.uri;
    writeCurrentFile();
  });

  /* ------------------------------------------------------------------ */
  /* 保存                                                                */
  /* ------------------------------------------------------------------ */

  function doSave() {
    if (!S.game) return;
    if (!S.file.uri) { askSaveAs(); return; }
    writeCurrentFile();
  }

  function writeCurrentFile() {
    if (S.busy) return;
    S.busy = true;
    toast('正在保存…');
    setTimeout(function () {
      try {
        var bytes = QSP.serialize(S.game);
        Native.writeAll(bytes);
      } catch (e) {
        toast('序列化失败：' + e.message);
      } finally {
        S.busy = false;
      }
    }, 20);
  }

  function askSaveAs() {
    var def = (S.file.name || 'game.qsp').replace(/\.saved\.qsp$/i, '.qsp');
    promptModal('另存为', '输入文件名', def, function (name) {
      if (!name) return;
      if (!/\.qsp$/i.test(name)) name += '.qsp';
      Native.saveAs(name);
    });
  }

  /* ------------------------------------------------------------------ */
  /* TXT 工程（.zip）导入 / 导出                                          */
  /* ------------------------------------------------------------------ */

  function currentVersion() {
    try { return (Native.appInfo() || {}).version || '1.3.12'; } catch (e) { return '1.3.12'; }
  }

  /**
   * 导出：把当前游戏拆成 locations/*.txt + manifest.json，再打包为 .zip。
   * 当前编辑中的内容（未保存的修改）也会包含进去。
   */
  function exportTxtProject() {
    if (!S.game) { toast('请先打开一个 .qsp 文件'); return; }
    if (S.busy) { toast('正在处理，请稍候'); return; }
    S.busy = true;
    var ver = currentVersion();
    toast('正在拆分位置并打包…');
    setTimeout(function () {
      var proj;
      try {
        proj = QSPText.exportProject(S.game, { generator: 'QGen Android ' + ver });
      } catch (e) {
        S.busy = false;
        toast('导出失败：' + (e.message || e));
        return;
      }
      var lastPct = -10;
      QSPZip.create(proj.files.map(function (f) {
        return { name: f.name, data: f.text };
      }), {
        compress: true,
        onProgress: function (done, total) {
          var pct = total ? Math.floor(done * 100 / total) : 100;
          if (pct >= lastPct + 10 || done === total) {
            lastPct = pct;
            toast('正在打包… ' + pct + '%');
          }
        }
      }).then(function (u8) {
        S.busy = false;
        Native.writeZip(u8, QSPText.suggestArchiveName(S.file.name));
        toast('打包完成（' + proj.files.length + ' 个文件），请选择保存位置');
      }).catch(function (e) {
        S.busy = false;
        showModal('导出失败', '<h3>导出 TXT 工程失败</h3><p>' +
          esc(e && e.message || e) + '</p>', [{ text: '好', primary: true }]);
      });
    }, 30);
  }

  /** 导入：选择一个 .zip，还原成游戏并进入位置列表（需要另存为 .qsp） */
  function importTxtProject() {
    if (S.busy) { toast('正在处理，请稍候'); return; }
    var go = function () {
      S.busy = true;
      toast('请选择 TXT 工程 .zip');
      Native.pickZip();
    };
    if (S.game && S.dirty) {
      confirmModal('导入 TXT 工程', '当前文件有未保存的修改，导入后会丢弃，继续？', go, true);
    } else {
      go();
    }
  }

  Native.on('onZipPicked', function (r) {
    if (!r || !r.ok) {
      S.busy = false;
      if (!(r && r.canceled)) toast('选择 ZIP 失败：' + ((r && r.message) || '未知错误'));
      return;
    }
    Native.readZipAll(function (bytes) {
      var fail = function (e) {
        S.busy = false;
        showModal('导入失败', '<h3>无法导入 TXT 工程</h3><p>' +
          esc(e && e.message || e) + '</p>', [{ text: '好', primary: true }]);
      };
      if (!bytes || !bytes.length) { fail(new Error('ZIP 文件为空')); return; }
      QSPZip.read(bytes).then(function (entries) {
        var files = [];
        entries.forEach(function (en) {
          if (/\/$/.test(en.name)) return;
          if (!/\.(txt|json)$/i.test(en.name)) return;
          files.push({ name: en.name, text: QSPZip.utf8Decode(en.data) });
        });
        if (!files.length) throw new Error('压缩包里没有 .txt 或 manifest.json');
        var res = QSPText.importProject(files, { version: currentVersion() });
        var name = QSPText.suggestQspName(r.name);
        var qspSize = 0;
        try { qspSize = QSP.serialize(res.game).length; } catch (e) { }
        adoptGame(res.game, {
          name: name,
          uri: '',
          size: qspSize,
          writable: false,
          path: '',
          dirty: true
        });
        S.busy = false;
        toast((res.fallback ? '已按兼容模式导入 ' : '已导入 ') +
          res.game.locations.length + ' 个位置，请另存为 .qsp');
      }).catch(fail);
    });
  });

  Native.on('onZipSaved', function (r) {
    if (r && r.ok) toast('TXT 工程已保存' + (r.name ? '：' + r.name : ''));
    else if (!(r && r.canceled)) toast('保存 ZIP 失败：' + ((r && r.message) || '未知错误'));
  });

  /* ------------------------------------------------------------------ */
  /* 位置列表                                                            */
  /* ------------------------------------------------------------------ */

  function countIn(str, q) {
    if (!str) return 0;
    var s = str.toLowerCase(), n = 0, from = 0;
    for (;;) {
      var at = s.indexOf(q, from);
      if (at < 0) break;
      n++;
      from = at + q.length;
      if (n >= 9999) break;
    }
    return n;
  }

  /** 取命中位置所在行，关键字前后各 15 个字符（超长截断加 …） */
  function snippetAround(text, at, len, ctx) {
    if (!text) return '';
    ctx = ctx || 15;
    var ls = text.lastIndexOf('\n', at - 1) + 1;
    var le = text.indexOf('\n', at + len);
    if (le < 0) le = text.length;
    var line = text.slice(ls, le);
    var col = at - ls;
    var a = Math.max(0, col - ctx);
    var b = Math.min(line.length, col + len + ctx);
    var head = (a > 0 ? '…' : '') + esc(line.slice(a, col));
    var body = '<mark>' + esc(line.slice(col, col + len)) + '</mark>';
    var tail = esc(line.slice(col + len, b)) + (b < line.length ? '…' : '');
    return head + body + tail;
  }

  /** 统计一个位置里各字段的命中情况；没有命中返回 null */
  function analyzeHit(loc, q) {
    var ql = q.toLowerCase();
    var fields = [
      { label: '名称', text: loc.name || '', key: 'name' },
      { label: '代码', text: loc.code || '', key: 'code' }
    ];
    var total = 0, first = null, byField = {};
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var n = countIn(f.text, ql);
      if (n) {
        byField[f.key] = n;
        total += n;
        if (!first) {
          var at = f.text.toLowerCase().indexOf(ql);
          first = { label: f.label, text: f.text, at: at, len: q.length };
        }
      }
    }
    if (!total) return null;
    return { total: total, byField: byField, first: first };
  }

  function hitSummary(hit, q) {
    if (!hit.first) return '命中 ' + hit.total + ' 处';
    if (hit.total === 1) {
      return '<span class="hit-line">' + esc(hit.first.label) + '：' +
        snippetAround(hit.first.text, hit.first.at, hit.first.len, 15) + '</span>';
    }
    var parts = [];
    if (hit.byField.code) parts.push('代码 ' + hit.byField.code);
    if (hit.byField.name) parts.push('名称 ' + hit.byField.name);
    return '命中 ' + hit.total + ' 处' + (parts.length ? '（' + parts.join(' · ') + '）' : '');
  }

  function renderList() {
    var host = $('loc-list');
    if (!S.game) { host.innerHTML = ''; return; }
    var q = S.query;
    var frag = document.createDocumentFragment();
    var shown = 0;
    for (var i = 0; i < S.game.locations.length; i++) {
      var loc = S.game.locations[i];
      var hit = q ? analyzeHit(loc, q) : null;
      if (q && !hit) continue;
      if (shown >= LIST_RENDER_LIMIT) break;
      shown++;
      var el = document.createElement('button');
      el.className = 'loc-item';
      el.dataset.idx = i;
      var sub;
      if (q) {
        sub = hitSummary(hit, q);
      } else {
        var meta = [];
        if (loc.code) meta.push('代码 ' + loc.code.length + ' 字');
        sub = esc(meta.join(' · ') || '空位置');
      }
      el.innerHTML =
        '<div class="li-main"><div class="li-name">' + esc(loc.name || '(未命名位置)') + '</div>' +
        '<div class="li-sub' + (q ? ' li-sub-hit' : '') + '">' + sub + '</div></div>' +
        '<button class="li-more" aria-label="更多">&#x22EE;</button>';
      frag.appendChild(el);
    }
    host.innerHTML = '';
    host.appendChild(frag);
    $('list-count').textContent = q
      ? shown + ' / ' + S.game.locations.length + ' 个位置'
      : S.game.locations.length + ' 个位置';
    $('list-empty').hidden = shown > 0;
    if (shown >= LIST_RENDER_LIMIT) {
      $('list-count').textContent += '（仅显示前 ' + LIST_RENDER_LIMIT + ' 条，请搜索缩小范围）';
    }
  }

  function onLocClick(e) {
    var more = e.target.closest('.li-more');
    var item = e.target.closest('.loc-item');
    if (!item) return;
    var idx = parseInt(item.dataset.idx, 10);
    if (more) { locationMenu(idx); return; }
    openLocation(idx);
  }

  /* ------------------------------------------------------------------ */
  /* 记录表（只读聚合视图）                                               */
  /* ------------------------------------------------------------------ */

  function resetRecords() {
    S.records = {
      scanned: false, busy: false, families: [], scanMs: 0, statements: 0,
      active: null, table: null, q: '', undo: [], hideEmpty: recHideEmptyPref()
    };
    var list = $('rec-family-list');
    var panel = $('rec-table-panel');
    var empty = $('rec-empty');
    if (list) list.innerHTML = '';
    if (panel) panel.hidden = true;
    if (empty) empty.hidden = true;
    if ($('rec-search')) $('rec-search').value = '';
    if ($('rec-search-clear')) $('rec-search-clear').hidden = true;
    if ($('rec-count')) $('rec-count').textContent = '尚未扫描';
    recUpdateEmptyBtn();
  }

  var recMemStore = {};

  function recStoreKey(id) {
    return 'qgen.records.v1.' + (S.file.name || 'untitled') + '.' + id;
  }
  function recHideEmptyPref() {
    try { return localStorage.getItem('qgen.records.hideEmpty') !== '0'; }
    catch (e) { return true; }
  }

  function recHiddenFields() {
    var a = S.records.active;
    var list = a && a.descriptor && a.descriptor.hiddenFields;
    return Array.isArray(list) ? list : [];
  }

  function recColumnHasData(t, c) {
    if (c.source && c.source.kind === 'manual') return true; // 人工列即使空也保留，方便填写
    for (var i = 0; i < t.rows.length; i++) {
      var v = t.rows[i].values[c.key];
      if (v != null && String(v) !== '') return true;
    }
    return false;
  }

  function recVisibleColumns(t) {
    var hidden = recHiddenFields();
    return t.columns.filter(function (c) {
      if (hidden.indexOf(c.key) >= 0) return false;
      if (S.records.hideEmpty && !recColumnHasData(t, c)) return false;
      return true;
    });
  }

  function recStoreGet(key) {
    try { return localStorage.getItem(key); }
    catch (e) { return recMemStore[key] || null; }
  }

  function recStoreSet(key, value) {
    try { localStorage.setItem(key, value); return true; }
    catch (e) { recMemStore[key] = value; return false; }
  }

  function recLoadSaved(id) {
    try {
      var raw = recStoreGet(recStoreKey(id));
      if (!raw) return null;
      var v = QSPRecords.validateDescriptor(JSON.parse(raw));
      return v.ok ? v.descriptor : null;
    } catch (e) { return null; }
  }

  function recSaveDescriptor(d) {
    try {
      recStoreSet(recStoreKey(d.id), JSON.stringify(d));
      return true;
    } catch (e) {
      toast('保存列设置失败：' + (e && e.message || e));
      return false;
    }
  }

  function openRecords() {
    if (!S.game) return;
    show('records');
    recShowFamilies();
    if (!S.records.scanned && !S.records.busy) scanRecords();
    else if (S.records.scanned) renderFamilies();
  }

  function scanRecords() {
    var rec = S.records;
    if (rec.busy || !S.game) return;
    rec.busy = true;
    rec.active = null;
    rec.table = null;
    rec.q = '';
    if ($('rec-search')) $('rec-search').value = '';
    if ($('rec-search-clear')) $('rec-search-clear').hidden = true;
    $('rec-count').textContent = '正在扫描静态数据…';
    $('rec-empty').hidden = true;
    $('rec-family-list').innerHTML = '';
    var t0 = Date.now();
    setTimeout(function () {
      try {
        var res = QSPRecords.scan(S.game, { minRecords: 3, minFields: 2 });
        rec.families = res.families || [];
        rec.statements = res.statementCount || 0;
        rec.scanMs = Date.now() - t0;
        rec.scanned = true;
        rec.busy = false;
        renderFamilies();
        toast('发现 ' + rec.families.length + ' 个候选记录族');
      } catch (e) {
        rec.busy = false;
        rec.scanned = true;
        $('rec-count').textContent = '扫描失败';
        $('rec-empty').hidden = false;
        $('rec-empty').textContent = '扫描失败：' + (e && e.message || e);
      }
    }, 30);
  }

  function recShowFamilies() {
    S.records.active = null;
    S.records.table = null;
    S.records.q = '';
    $('rec-search').value = '';
    $('rec-search-clear').hidden = true;
    $('rec-family-list').hidden = false;
    $('rec-table-panel').hidden = true;
    $('rec-search').placeholder = '筛选记录族…';
    updateTitle();
  }

  function renderFamilies() {
    var rec = S.records;
    var q = (rec.q || '').toLowerCase();
    var all = rec.families || [];
    var list = all.filter(function (f) {
      if (!q) return true;
      var hay = f.label + ' ' + (f.location || '') + ' ' +
        (f.descriptor.fields || []).map(function (x) { return x.label; }).join(' ');
      return hay.toLowerCase().indexOf(q) >= 0;
    });
    var html = '';
    list.slice(0, REC_FAMILY_LIMIT).forEach(function (f) {
      var keys = (f.preview || []).join('、');
      html += '<button class="rec-card" data-fam="' + esc(f.id) + '">' +
        '<div class="rec-card-top"><span class="rec-card-name">' + esc(f.label) + '</span>' +
        '<span class="rec-pill">' + f.recordCount + ' 条</span></div>' +
        '<div class="rec-card-meta">' + esc(f.location || '') + ' · ' + f.fieldCount + ' 列</div>' +
        (keys ? '<div class="rec-card-keys">' + esc(keys) + '</div>' : '') +
        '</button>';
    });
    $('rec-family-list').innerHTML = html;
    $('rec-family-list').hidden = false;
    $('rec-table-panel').hidden = true;
    $('rec-empty').hidden = list.length > 0;
    if (!list.length) $('rec-empty').textContent = '没有匹配的记录族';
    var msg = list.length + ' 个候选记录族';
    if (list.length > REC_FAMILY_LIMIT) msg += '（仅显示前 ' + REC_FAMILY_LIMIT + ' 个）';
    msg += ' · ' + rec.statements + ' 条语句 · 扫描 ' + (rec.scanMs / 1000).toFixed(1) + 's';
    $('rec-count').textContent = msg;
    updateTitle();
  }

  function openFamily(famId) {
    var fam = (S.records.families || []).filter(function (f) { return f.id === famId; })[0];
    if (!fam) return;
    var d = recLoadSaved(fam.descriptor.id) || fam.descriptor;
    if (!d.manual || typeof d.manual !== 'object') d.manual = {};
    S.records.active = { family: fam, descriptor: d };
    S.records.q = '';
    S.records.undo = [];
    $('rec-search').value = '';
    $('rec-search-clear').hidden = true;
    $('rec-search').placeholder = '筛选记录（id / 字段值）…';
    $('rec-family-list').hidden = true;
    $('rec-table-panel').hidden = false;
    recBuildTable();
    renderRecordTable();
    recUpdateUndoBtn();
    updateTitle();
  }

  function recBuildTable() {
    var a = S.records.active;
    if (!a) return false;
    try {
      var t = QSPRecords.buildTable(S.game, a.descriptor);
      S.records.table = t;
      if (t.ok) a.descriptor = t.descriptor;
      return t.ok;
    } catch (e) {
      S.records.table = { ok: false, errors: [String(e && e.message || e)], columns: [], rows: [] };
      return false;
    }
  }

  function recCellText(v) {
    var s = v == null ? '' : String(v);
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > 180 ? s.slice(0, 180) + '…' : s;
  }

  function renderRecordTable() {
    var a = S.records.active, t = S.records.table;
    if (!a) return;
    $('rec-table-title').textContent = a.descriptor.label + (t && t.ok ? ' · ' + t.rows.length + ' 条' : '');
    if (!t || !t.ok) {
      $('rec-table-wrap').innerHTML = '<div class="rec-note">无法生成表格：' +
        esc((t && t.errors || []).join('；')) + '</div>';
      $('rec-count').textContent = '无法生成表格';
      $('rec-empty').hidden = true;
      return;
    }
    var q = (S.records.q || '').toLowerCase();
    var rows = t.rows.filter(function (r) {
      if (!q) return true;
      if (String(r.id).toLowerCase().indexOf(q) >= 0) return true;
      for (var i = 0; i < t.columns.length; i++) {
        if (t.columns[i].type === 'code') continue;
        var v = r.values[t.columns[i].key];
        if (String(v == null ? '' : v).toLowerCase().indexOf(q) >= 0) return true;
      }
      return false;
    });
    var cols = recVisibleColumns(t);
    var html = '<table class="rec-table"><thead><tr><th>id</th>';
    cols.forEach(function (c) {
      var canEdit = !c.readOnly && !(c.source && c.source.kind === 'literal');
      html += '<th>' + esc(c.label) + '<span class="rec-col-type">' + esc(c.type) +
        (canEdit ? ' · 可改' : ' · 只读') + '</span></th>';
    });
    html += '</tr></thead><tbody>';
    rows.slice(0, REC_ROW_LIMIT).forEach(function (r) {
      html += '<tr><td data-label="id" title="' + esc(r.id) + '">' + esc(r.id) + '</td>';
      cols.forEach(function (c) {
        var v = r.values[c.key];
        var fl = r.flags[c.key] || [];
        var src = c.source || {};
        var isManual = src.kind === 'manual';
        var missing = fl.indexOf('missing') >= 0;
        var conflict = fl.indexOf('conflict') >= 0;
        var editable = !isManual && !c.readOnly && !missing && !conflict &&
          src.kind !== 'literal' && v !== '' && !!r.sources[c.key];
        var cls = ['rec-cell'];
        if (c.type === 'code') cls.push('rec-code');
        if (missing) cls.push('rec-missing');
        if (conflict) cls.push('rec-conflict');
        if (isManual) cls.push('rec-manual');
        if (editable) cls.push('rec-editable');
        if (S.records.hideEmpty && (v === '' || missing)) cls.push('rec-empty-cell');
        var attrs = ' data-label="' + esc(c.label) + '" data-id="' + esc(r.id) +
          '" data-field="' + esc(c.key) + '"';
        if (isManual) attrs += ' data-name="' + esc(src.name) + '"';
        var hint = isManual ? '点击填写人工标记' : (editable ? '点击修改' : '');
        html += '<td class="' + cls.join(' ') + '"' + attrs +
          ' title="' + esc(recCellText(v) + (hint ? '\n' + hint : '')) + '">' +
          '<span class="rec-val">' +
          (v === '' ? '<span class="rec-missing">—</span>' : esc(recCellText(v))) +
          '</span></td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    if (!rows.length) html = '<div class="rec-note">没有匹配的记录</div>';
    $('rec-table-wrap').innerHTML = html;
    var msg = rows.length + ' / ' + t.rows.length + ' 条记录 · ' + cols.length + ' / ' + t.columns.length + ' 列';
    if (rows.length > REC_ROW_LIMIT) msg += '（仅显示前 ' + REC_ROW_LIMIT + ' 条）';
    if (S.records.hideEmpty) msg += ' · 空值已隐藏';
    var warn = t.warnings && t.warnings.length ? ' · ' + t.warnings.length + ' 条字段警告' : '';
    $('rec-count').textContent = msg + warn + ' · 点单元格可修改';
    $('btn-rec-empty').classList.toggle('on', !!S.records.hideEmpty);
    $('btn-rec-empty').setAttribute('aria-pressed', S.records.hideEmpty ? 'true' : 'false');
    $('rec-empty').hidden = rows.length > 0;
    recUpdateUndoBtn();
  }

  function recFilter(q) {
    S.records.q = q || '';
    if (S.records.active) renderRecordTable();
    else renderFamilies();
  }

  function recBack() {
    if (!$('rec-table-panel').hidden) {
      recShowFamilies();
      renderFamilies();
      return true;
    }
    return false;
  }

  function recExportCSV() {
    var t = S.records.table;
    if (!t || !t.ok) { toast('请先打开一个记录族'); return; }
    var base = (S.file.name || 'qgen').replace(/\.qsp$/i, '').replace(/[\\/:*?"<>|]+/g, '_');
    var id = (S.records.active && S.records.active.descriptor.id || 'table').replace(/[^A-Za-z0-9_.-]+/g, '_');
    var text = QSPRecords.tableToCSV({ columns: recVisibleColumns(t), rows: t.rows });
    Native.saveText(text, base + '.' + id + '.csv');
    toast('准备导出 ' + t.rows.length + ' 条记录…');
  }

  function recFieldFormToggle() {
    var kind = $('rf-kind').value;
    $('rf-name-row').hidden = kind === 'literal';
    $('rf-arg-row').hidden = kind !== 'helperArg';
    $('rf-path-row').hidden = kind !== 'array' && kind !== 'block';
    $('rf-value-row').hidden = kind !== 'literal';
    var lab = $('rf-name-label');
    if (kind === 'array') lab.textContent = '数组名（如 $item_name）';
    else if (kind === 'block') lab.textContent = '代码块数组名（如 $item_property）';
    else if (kind === 'helperArg') lab.textContent = 'Helper 名（如 $ib_cycle）';
    else if (kind === 'manual') lab.textContent = '人工标记名（自定义）';
  }

  function recAddField() {
    var a = S.records.active;
    if (!a) return;
    showModal('添加列', '<h3>添加列</h3>' +
      '<div class="rec-form-row"><label>列名</label><input id="rf-label" placeholder="例如 价格"></div>' +
      '<div class="rec-form-row"><label>来源</label><select id="rf-kind">' +
      '<option value="helperArg">Helper 参数</option>' +
      '<option value="array">数组字段</option>' +
      '<option value="block">代码块</option>' +
      '<option value="literal">固定值</option>' +
      '<option value="manual">人工标记</option></select></div>' +
      '<div class="rec-form-row" id="rf-name-row"><label id="rf-name-label">名称</label><input id="rf-name" placeholder="$ib_cycle / $item_name"></div>' +
      '<div class="rec-form-row" id="rf-arg-row"><label>Helper 参数序号（1 起，主键通常是 1）</label><input id="rf-arg" type="number" min="1" value="2"></div>' +
      '<div class="rec-form-row" id="rf-path-row" hidden><label>数组二级路径（逗号分隔，可空）</label><input id="rf-path" placeholder="可空"></div>' +
      '<div class="rec-form-row" id="rf-value-row" hidden><label>固定值</label><input id="rf-value"></div>' +
      '<div class="rec-form-row"><label>类型</label><select id="rf-type">' +
      '<option value="text">文本</option><option value="number">数字</option>' +
      '<option value="code">代码块</option><option value="boolean">布尔</option></select></div>',
      [{ text: '取消' }, { text: '添加', primary: true, fn: function () {
        var label = ($('rf-label').value || '').trim();
        if (!label) { toast('请填写列名'); return; }
        var kind = $('rf-kind').value;
        var name = ($('rf-name').value || '').trim();
        var source = { kind: kind };
        if (kind === 'helperArg') {
          if (!name) { toast('请填写 Helper 名'); return; }
          if (name.charAt(0) !== '$') name = '$' + name;
          var arg = parseInt($('rf-arg').value, 10);
          if (!(arg >= 1)) { toast('参数序号必须 >= 1'); return; }
          source.helper = name; source.arg = arg;
        } else if (kind === 'array' || kind === 'block') {
          if (!name) { toast('请填写数组名'); return; }
          if (name.charAt(0) !== '$') name = '$' + name;
          source.name = name;
          source.path = ($('rf-path').value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        } else if (kind === 'literal') {
          source.value = $('rf-value').value;
        } else if (kind === 'manual') {
          source.name = name || ('m_' + Date.now().toString(36));
        }
        var d = a.descriptor;
        var key = 'f' + (d.fields.length + 1);
        var n = 1;
        while (d.fields.some(function (f) { return f.key === key; })) key = 'f' + (d.fields.length + 1) + '_' + (n++);
        var type = $('rf-type').value;
        if (kind === 'block') type = 'code';
        if (kind === 'literal' && type === 'number' && source.value !== '' && !isNaN(Number(source.value))) {
          source.value = Number(source.value);
        }
        var res = QSPRecords.addField(d, { key: key, label: label, type: type, source: source });
        if (!res.ok) { toast('添加失败：' + res.errors.join('；')); return; }
        res.descriptor.manual = res.descriptor.manual || {};
        if (kind === 'manual') res.descriptor.manual[source.name] = res.descriptor.manual[source.name] || {};
        a.descriptor = res.descriptor;
        recSaveDescriptor(a.descriptor);
        recBuildTable();
        renderRecordTable();
        updateTitle();
      } }]);
    $('rf-kind').addEventListener('change', recFieldFormToggle);
    recFieldFormToggle();
  }

  function recUpdateEmptyBtn() {
    var b = $('btn-rec-empty');
    if (!b) return;
    b.classList.toggle('on', !!S.records.hideEmpty);
    b.setAttribute('aria-pressed', S.records.hideEmpty ? 'true' : 'false');
    b.title = S.records.hideEmpty ? '空值已隐藏，点击显示' : '空值已显示，点击隐藏';
  }

  function recToggleEmpty() {
    S.records.hideEmpty = !S.records.hideEmpty;
    try { localStorage.setItem('qgen.records.hideEmpty', S.records.hideEmpty ? '1' : '0'); } catch (e) { }
    recUpdateEmptyBtn();
    renderRecordTable();
    toast(S.records.hideEmpty ? '已隐藏空值字段' : '已显示空值字段');
  }

  function recOpenColumns() {
    var a = S.records.active, t = S.records.table;
    if (!a || !t || !t.ok) { toast('请先打开一个记录族'); return; }
    var hidden = recHiddenFields();
    var list = t.columns.map(function (c) {
      var checked = hidden.indexOf(c.key) < 0 ? ' checked' : '';
      return '<label class="rec-col-item"><input type="checkbox" data-key="' + esc(c.key) + '"' + checked + '>' +
        '<span class="rec-col-name">' + esc(c.label) + '</span>' +
        '<span class="rec-col-meta">' + esc(c.type) + '</span></label>';
    }).join('');
    var box = showModal('显示列',
      '<h3>显示列</h3>' +
      '<div class="hint">取消勾选即可隐藏不关心的子属性；列设置按记录族保存在本机。</div>' +
      '<div class="rec-col-actions"><button type="button" class="text-btn" id="rec-col-all">全选</button>' +
      '<button type="button" class="text-btn" id="rec-col-none">全不选</button></div>' +
      '<div class="rec-col-list">' + list + '</div>',
      [{ text: '取消' }, { text: '确定', primary: true, fn: function () {
        var keep = {};
        var boxes = box.querySelectorAll('input[data-key]');
        for (var i = 0; i < boxes.length; i++) keep[boxes[i].dataset.key] = boxes[i].checked;
        a.descriptor.hiddenFields = t.columns.filter(function (c) { return !keep[c.key]; })
          .map(function (c) { return c.key; });
        recSaveDescriptor(a.descriptor);
        renderRecordTable();
        toast('已更新显示列');
      } }]);
    box.querySelector('#rec-col-all').addEventListener('click', function () {
      box.querySelectorAll('input[data-key]').forEach(function (x) { x.checked = true; });
    });
    box.querySelector('#rec-col-none').addEventListener('click', function () {
      box.querySelectorAll('input[data-key]').forEach(function (x) { x.checked = false; });
    });
  }

  function recUpdateUndoBtn() {
    var b = $('btn-rec-undo');
    if (b) b.disabled = !(S.records.undo && S.records.undo.length);
  }

  function recUndo() {
    var stack = S.records.undo || [];
    var edit = stack.pop();
    if (!edit) return;
    var res = QSPRecords.undoValue(S.game, edit);
    if (!res.ok) {
      stack.push(edit);
      toast('撤销失败：' + (res.error || '内容已变化'));
      return;
    }
    setDirty(!!edit.wasDirty);
    recBuildTable();
    renderRecordTable();
    recUpdateUndoBtn();
    toast('已撤销上一步修改');
  }

  function recEditCell(td) {
    var t = S.records.table, a = S.records.active;
    if (!t || !t.ok || !a) return;
    var id = td.dataset.id, key = td.dataset.field;
    var c = null, r = null, i;
    for (i = 0; i < t.columns.length; i++) if (t.columns[i].key === key) { c = t.columns[i]; break; }
    for (i = 0; i < t.rows.length; i++) if (t.rows[i].id === id) { r = t.rows[i]; break; }
    if (!c || !r) return;
    var fl = r.flags[key] || [];
    if (fl.indexOf('conflict') >= 0) { toast('这一列存在冲突值，暂不支持直接改'); return; }
    if (fl.indexOf('missing') >= 0 || !r.sources[key]) { toast('该记录没有这一项，无法直接修改'); return; }
    var src = c.source || {};
    var old = r.values[key];
    var multiline = c.type === 'code' || src.kind === 'block' || String(old).length > 70;
    editFieldModal('修改 ' + c.label,
      id + ' · 只改当前这一条，保存文件后生效',
      old, multiline, function (v) {
        if (String(v) === String(old)) return;
        var target = {
          location: r.sources[key].location,
          start: r.sources[key].start,
          end: r.sources[key].end,
          source: c.source,
          type: c.type
        };
        var res;
        try { res = QSPRecords.updateValue(S.game, target, v); }
        catch (e) { toast('修改失败：' + (e && e.message || e)); return; }
        if (!res.ok) { toast('修改失败：' + (res.error || '未知错误')); return; }
        if (!res.edit) return;
        res.edit.wasDirty = S.dirty;
        S.records.undo.push(res.edit);
        setDirty(true);
        recBuildTable();
        renderRecordTable();
        recUpdateUndoBtn();
        toast('已修改 ' + c.label + ' · ' + id);
      });
  }

  function recTableClick(e) {
    var td = e.target.closest('td');
    if (!td) return;
    if (td.classList.contains('rec-manual')) {
      var id = td.dataset.id, name = td.dataset.name;
      var a = S.records.active;
      if (!a) return;
      var bucket = (a.descriptor.manual && a.descriptor.manual[name]) || {};
      promptModal('人工标记', id + ' · ' + name, bucket[id] || '', function (v) {
        a.descriptor.manual = a.descriptor.manual || {};
        a.descriptor.manual[name] = a.descriptor.manual[name] || {};
        a.descriptor.manual[name][id] = v;
        recSaveDescriptor(a.descriptor);
        recBuildTable();
        renderRecordTable();
      });
      return;
    }
    if (td.classList.contains('rec-editable')) recEditCell(td);
  }

  Native.on('onTextSaved', function (r) {
    if (r && r.ok) toast('已导出' + (r.name ? '：' + r.name : ' CSV'));
    else if (!(r && r.canceled)) toast('导出失败：' + ((r && r.message) || '未知错误'));
  });

  /* ------------------------------------------------------------------ */
  /* 编辑器                                                              */
  /* ------------------------------------------------------------------ */

  function openLocation(idx) {
    S.cur = idx;
    var loc = S.game.locations[idx];
    $('edit-code').value = loc.code || '';
    $('edit-code').scrollTop = 0;
    $('edit-code').scrollLeft = 0;
    applyCodeStyle();
    applyHighlightMode();
    show('editor');
    updateEditorInfo();
    // 切换位置后必须重建查找结果，否则 marks 仍指向上一个位置的偏移
    if (S.find.open) {
      if (S.find.q) {
        runFind(S.find.q);
      } else {
        S.find.marks = [];
        S.find.idx = -1;
        updateHighlight();
        $('find-count').textContent = '0/0';
      }
    }
  }

  function applyCodeStyle(save) {
    var root = document.documentElement;
    root.style.setProperty('--code-fs', S.codeSize + 'px');
    root.style.setProperty('--code-lh', Math.round(S.codeSize * S.codeLH) + 'px');
    var ta = $('edit-code');
    var pre = $('hl-code');
    ta.classList.toggle('wrap', !!S.codeWrap);
    pre.classList.toggle('wrap', !!S.codeWrap);
    $('btn-wrap').classList.toggle('on', !!S.codeWrap);
    // 自动换行时行号与视觉行不再一致，隐藏行号
    $('gutter-code').style.display = S.codeWrap ? 'none' : '';
    $('btn-lh').classList.toggle('on', S.codeLH <= 1.25);
    if (save !== false) savePrefs();
  }

  function savePrefs() {
    try {
      localStorage.setItem('qgen.codeSize', String(S.codeSize));
      localStorage.setItem('qgen.codeWrap', S.codeWrap ? '1' : '0');
      localStorage.setItem('qgen.codeLH', String(S.codeLH));
    } catch (e) { }
  }

  var LH_STEPS = [1.15, 1.3, 1.45, 1.7];
  function cycleLineHeight() {
    var i = LH_STEPS.indexOf(S.codeLH);
    S.codeLH = LH_STEPS[(i + 1) % LH_STEPS.length];
    applyCodeStyle(true);
    renderGutterLines($('edit-code').value);
    syncView();
    if (S.find.open && S.find.idx >= 0) gotoMatch(S.find.idx);
    toast('行距 ' + Math.round(S.codeLH * 100) + '%');
  }

  function updateEditorInfo() {
    if (S.cur < 0 || !S.game) { $('editor-info').textContent = ''; return; }
    var loc = S.game.locations[S.cur];
    $('editor-info').textContent = '代码 ' + (loc.code || '').length + ' 字';
  }

  var hlTimer = null;

  function applyHighlightMode() {
    var ta = $('edit-code');
    var pre = $('hl-code');
    if (S.hlOn) {
      pre.hidden = false;
      ta.classList.add('hl');
    } else {
      pre.hidden = true;
      ta.classList.remove('hl');
    }
    $('btn-hl').classList.toggle('on', !!S.hlOn);
    if (S.hlOn) updateHighlight();
    else { renderGutterLines(ta.value); syncView(); }
    try { localStorage.setItem('qgen.hl', S.hlOn ? '1' : '0'); } catch (e) { }
  }

  function updateHighlight() {
    if (!S.hlOn) { renderGutterLines($('edit-code').value); syncView(); return; }
    var ta = $('edit-code');
    var body = $('hl-code-body');
    var src = ta.value;
    var marks = (S.find.open && S.find.marks.length) ? S.find.marks : null;
    try {
      body.innerHTML = QSPHL.highlight(src, marks);
    } catch (e) {
      // 极端情况下退回纯文本，至少不让编辑区变空
      body.textContent = src;
    }
    renderGutterLines(src);
    syncView();
  }

  function debounceHighlight() {
    if (hlTimer) clearTimeout(hlTimer);
    hlTimer = setTimeout(updateHighlight, 140);
  }

  function renderGutterLines(src) {
    var gutter = $('gutter-code');
    if (S.codeWrap) return;
    var n = 1;
    for (var i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
    var parts = new Array(n);
    for (var k = 0; k < n; k++) parts[k] = k + 1;
    gutter.textContent = parts.join('\n');
  }

  function syncView() {
    var ta = $('edit-code');
    var pre = $('hl-code');
    if (!pre) return;
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
    if (!S.codeWrap) $('gutter-code').scrollTop = ta.scrollTop;
  }

  function setCodeSize(px) {
    S.codeSize = Math.max(8, Math.min(28, px));
    applyCodeStyle(true);
    renderGutterLines($('edit-code').value);
    syncView();
    if (S.find.open && S.find.idx >= 0) gotoMatch(S.find.idx);
    toast('代码字号 ' + S.codeSize + 'px');
  }

  /* ---------------- 代码内查找 ---------------- */

  function toggleFind() {
    if (S.find.open) { closeFind(); return; }
    if (!S.hlOn) { S.hlOn = true; applyHighlightMode(); toast('已打开语法高亮以显示查找结果'); }
    S.find.open = true;
    $('findbar').hidden = false;
    $('btn-find').classList.add('on');
    var inp = $('find-input');
    inp.value = S.find.q || '';
    inp.focus();
    try { inp.select(); } catch (e) { }
    if (S.find.q) runFind(S.find.q);
    else { $('find-count').textContent = '0/0'; }
  }

  function closeFind() {
    S.find.open = false;
    $('findbar').hidden = true;
    $('btn-find').classList.remove('on');
    S.find.marks = [];
    S.find.idx = -1;
    updateHighlight();
  }

  function runFind(q, keepIdx) {
    S.find.q = q;
    var src = $('edit-code').value;
    var marks = [];
    var lower = src.toLowerCase(), lq = q.toLowerCase();
    if (q) {
      var from = 0, MAX = 4000;
      while (marks.length < MAX) {
        var at = lower.indexOf(lq, from);
        if (at < 0) break;
        marks.push({ s: at, e: at + q.length, cur: false });
        from = at + Math.max(1, q.length);
      }
    }
    S.find.marks = marks;
    S.find.idx = marks.length ? 0 : -1;
    if (marks.length) marks[0].cur = true;
    updateHighlight();
    $('find-count').textContent = marks.length ? ('1/' + marks.length) : '0/0';
    if (marks.length) gotoMatch(0);
  }

  function gotoMatch(i) {
    var m = S.find.marks[i];
    if (!m) return;
    S.find.idx = i;
    for (var k = 0; k < S.find.marks.length; k++) S.find.marks[k].cur = (k === i);
    updateHighlight();
    var ta = $('edit-code');
    var pre = $('hl-code');
    try { ta.setSelectionRange(m.s, m.e); } catch (e) { }
    // 直接量当前命中元素的实际像素位置：字号、行距、捏合缩放、自动换行都不用再猜行高
    var cm = document.querySelector('#hl-code-body mark.fc');
    if (cm && pre && !pre.hidden) {
      var pr = pre.getBoundingClientRect();
      var cr = cm.getBoundingClientRect();
      var top = (cr.top - pr.top) + pre.scrollTop;
      var left = (cr.left - pr.left) + pre.scrollLeft;
      ta.scrollTop = Math.max(0, top - Math.floor(ta.clientHeight / 2) + Math.floor(cr.height / 2));
      if (!S.codeWrap) ta.scrollLeft = Math.max(0, left - Math.floor(ta.clientWidth / 3));
    } else {
      // 高亮层不可用时退回按逻辑行估算
      var before = ta.value.slice(0, m.s);
      var line = 0;
      for (var p = 0; p < before.length; p++) if (before.charCodeAt(p) === 10) line++;
      var lh = Math.round(S.codeSize * S.codeLH);
      ta.scrollTop = Math.max(0, line * lh - Math.floor(ta.clientHeight / 2) + lh);
    }
    syncView();
    $('find-count').textContent = (i + 1) + '/' + S.find.marks.length;
  }

  function findStep(dir) {
    var n = S.find.marks.length;
    if (!n) return;
    var i = (S.find.idx + dir + n) % n;
    gotoMatch(i);
  }

  function onCodeInput() {
    if (S.cur < 0) return;
    S.game.locations[S.cur].code = $('edit-code').value;
    setDirty(true);
    updateEditorInfo();
    debounceHighlight();
    syncView();
  }

  /* ------------------------------------------------------------------ */
  /* 位置操作                                                            */
  /* ------------------------------------------------------------------ */

  function locationMenu(idx) {
    var loc = S.game.locations[idx];
    sheet(loc.name || '(未命名位置)', [
      { ico: '✎', text: '重命名', fn: function () { renameLocation(idx); } },
      { ico: '⧉', text: '创建副本', fn: function () { duplicateLocation(idx); } },
      { ico: '↺', text: '还原到此位置（丢弃修改）', fn: function () { /* 需重新读文件，略 */ toast('请使用“文件 → 重新载入”'); } },
      { ico: '🗑', text: '删除位置', danger: true, fn: function () { deleteLocation(idx); } }
    ]);
  }

  function renameLocation(idx) {
    var loc = S.game.locations[idx];
    promptModal('重命名位置', '位置名（QSP 中唯一）', loc.name, function (name) {
      if (!name) return;
      name = name.replace(/\s+$/, '');
      for (var i = 0; i < S.game.locations.length; i++) {
        if (i !== idx && S.game.locations[i].name === name) { toast('已存在同名位置'); return; }
      }
      loc.name = name;
      setDirty(true);
      renderList();
      if (S.cur === idx) updateTitle();
      toast('已重命名');
    });
  }

  function duplicateLocation(idx) {
    var src = S.game.locations[idx];
    var copy = JSON.parse(JSON.stringify(src));
    var base = src.name + '_copy';
    var name = base, n = 2;
    var exists = function (nm) {
      for (var i = 0; i < S.game.locations.length; i++) if (S.game.locations[i].name === nm) return true;
      return false;
    };
    while (exists(name)) name = base + n++;
    copy.name = name;
    S.game.locations.splice(idx + 1, 0, copy);
    setDirty(true);
    renderList();
    toast('已创建副本：' + name);
  }

  function deleteLocation(idx) {
    var loc = S.game.locations[idx];
    confirmModal('删除位置', '确定要删除位置「' + (loc.name || '(未命名)') + '」吗？此操作不可撤销（保存后生效）。', function () {
      S.game.locations.splice(idx, 1);
      if (S.cur >= S.game.locations.length) S.cur = S.game.locations.length - 1;
      setDirty(true);
      if (S.view === 'editor') { show('list'); }
      renderList();
      toast('已删除');
    }, true);
  }

  function addLocation() {
    promptModal('新建位置', '位置名', 'new_location', function (name) {
      if (!name) return;
      for (var i = 0; i < S.game.locations.length; i++) {
        if (S.game.locations[i].name === name) { toast('已存在同名位置'); return; }
      }
      // desc / actions 仅为 QSP 文件格式兼容保留（界面已不提供这两块的编辑）
      S.game.locations.push({ name: name, desc: '', code: '', actions: [] });
      setDirty(true);
      renderList();
      openLocation(S.game.locations.length - 1);
      toast('已创建');
    });
  }

  /* ------------------------------------------------------------------ */
  /* 底部弹层 / 模态框                                                   */
  /* ------------------------------------------------------------------ */

  function closeSheet() { $('sheet-host').hidden = true; }
  function sheet(title, items) {
    var host = $('sheet-host');
    var el = $('sheet');
    el.innerHTML = '<div class="sheet-title">' + esc(title) + '</div>';
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.className = 'sheet-item' + (it.danger ? ' danger' : '');
      b.innerHTML = '<span class="si-ico">' + (it.ico || '') + '</span><span>' + esc(it.text) + '</span>';
      b.addEventListener('click', function () { closeSheet(); setTimeout(function () { it.fn && it.fn(); }, 10); });
      el.appendChild(b);
    });
    host.hidden = false;
  }

  function closeModal() { $('modal-host').hidden = true; }

  function showModal(title, html, buttons) {
    var host = $('modal-host');
    var box = $('modal');
    box.innerHTML = html + '<div class="modal-actions"></div>';
    var bar = box.querySelector('.modal-actions');
    (buttons || [{ text: '好', primary: true }]).forEach(function (b, i) {
      var el = document.createElement('button');
      el.textContent = b.text;
      if (b.primary) el.className = 'primary';
      if (b.danger) el.className = 'danger';
      el.addEventListener('click', function () {
        closeModal();
        if (b.fn) b.fn();
      });
      bar.appendChild(el);
    });
    host.hidden = false;
    return box;
  }

  function promptModal(title, hint, value, cb) {
    var box = showModal(title,
      '<h3>' + esc(title) + '</h3>' +
      (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') +
      '<input class="field" id="modal-input" value="' + esc(value || '') + '">',
      [{ text: '取消' }, { text: '确定', primary: true, fn: function () {
          var v = document.getElementById('modal-input').value;
          cb(v);
        } }]);
    var inp = document.getElementById('modal-input');
    inp.focus();
    inp.select();
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { closeModal(); cb(inp.value); }
    });
  }

  /** 文本/代码编辑弹窗：文本用单行，代码或长文本用多行 */
  function editFieldModal(title, hint, value, multiline, cb) {
    var box = showModal(title,
      '<h3>' + esc(title) + '</h3>' +
      (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') +
      '<textarea class="field" id="modal-input" rows="' + (multiline ? 7 : 2) + '"></textarea>',
      [{ text: '取消' }, { text: '确定', primary: true, fn: function () {
        cb(document.getElementById('modal-input').value);
      } }]);
    var ta = document.getElementById('modal-input');
    ta.value = value == null ? '' : String(value);
    ta.focus();
    if (!multiline) ta.select();
  }

  function confirmModal(title, msg, cb, danger) {
    showModal(title, '<h3>' + esc(title) + '</h3><p>' + esc(msg) + '</p>', [
      { text: '取消' },
      { text: '确定', primary: !danger, danger: !!danger, fn: cb }
    ]);
  }

  /* ------------------------------------------------------------------ */
  /* 菜单                                                                */
  /* ------------------------------------------------------------------ */

  function openMenu() {
    var items = [
      { ico: '💾', text: '保存', fn: doSave },
      { ico: '📄', text: '另存为…', fn: askSaveAs },
      { ico: '📦', text: '导出 TXT 工程（.zip）', fn: exportTxtProject },
      { ico: '📥', text: '导入 TXT 工程（.zip）', fn: importTxtProject },
      { ico: '🧾', text: '记录表（查看/修改）', fn: openRecords },
      { ico: 'ℹ', text: '游戏信息', fn: showGameInfo }
    ];
    if (S.view === 'records') {
      items = [
        { ico: '🧾', text: '记录族列表', fn: function () { recShowFamilies(); renderFamilies(); } },
        { ico: '📤', text: '导出当前表 CSV', fn: recExportCSV },
        { ico: '🔁', text: '重新扫描', fn: scanRecords },
        { ico: '←', text: '返回位置列表', fn: function () { show('list'); renderList(); } }
      ];
    } else if (S.view === 'editor' && S.cur >= 0) {
      items = items.concat([
        { ico: '✎', text: '重命名此位置', fn: function () { renameLocation(S.cur); } },
        { ico: '⧉', text: '创建副本', fn: function () { duplicateLocation(S.cur); } },
        { ico: '🗑', text: '删除此位置', danger: true, fn: function () { deleteLocation(S.cur); } }
      ]);
    } else {
      items = items.concat([
        { ico: '🔁', text: '重新载入（放弃未保存修改）', fn: reloadFile },
        { ico: '✕', text: '关闭文件', fn: closeFile }
      ]);
    }
    sheet(S.file.name || '文件', items);
  }

  function showGameInfo() {
    var g = S.game, st = QSP.stats(g);
    var html = '<h3>游戏信息</h3>' +
      '<div class="kv"><span>文件</span><span>' + esc(S.file.name) + '</span></div>' +
      '<div class="kv"><span>大小</span><span>' + fmtSize(S.file.size) + '</span></div>' +
      '<div class="kv"><span>位置</span><span>' + st.locations + '</span></div>' +
      '<div class="kv"><span>代码字数</span><span>' + st.codeChars + '</span></div>' +
      '<div class="kv"><span>密码</span><span>' + esc(g.password || '(空)') + '</span></div>' +
      '<div class="kv"><span>文件头</span><span>' + esc(g.date || '(空)') + '</span></div>';
    showModal('游戏信息', html, [
      { text: '编辑密码', fn: function () {
          promptModal('游戏密码', '默认 "No"。改成别的会让玩家打开时要求输入密码', g.password, function (v) {
            g.password = v || 'No'; setDirty(true); toast('密码已修改');
          });
        } },
      { text: '好', primary: true }
    ]);
  }

  function reloadFile() {
    confirmModal('重新载入', '将丢弃所有未保存的修改并重新读取文件，继续？', function () {
      if (S.file.uri) Native.openRecent(S.file.uri);
      else toast('该文件没有可重新载入的位置');
    }, true);
  }

  function closeFile() {
    var go = function () {
      S.game = null; S.cur = -1; S.file = { name: '', uri: '', size: 0, writable: false };
      setDirty(false);
      show('home');
      renderRecent();
    };
    if (S.dirty) confirmModal('关闭文件', '有未保存的修改，确定关闭？', go, true);
    else go();
  }

  /* ------------------------------------------------------------------ */
  /* 最近文件                                                            */
  /* ------------------------------------------------------------------ */

  function renderRecent() {
    var list = $('recent-list');
    var recent = Native.recentFiles() || [];
    list.innerHTML = '';
    $('recent-title').hidden = recent.length === 0;
    recent.forEach(function (r) {
      var el = document.createElement('button');
      el.className = 'recent-item';
      el.innerHTML = '<div class="ri-ico">📄</div><div class="ri-main">' +
        '<div class="ri-name">' + esc(r.name) + '</div>' +
        '<div class="ri-sub">' + fmtSize(r.size) + ' · ' + fmtTime(r.time) + '</div></div>';
      el.addEventListener('click', function () { Native.openRecent(r.uri); });
      list.appendChild(el);
    });

    var dev = $('dev-box');
    var files = Native.devFiles ? Native.devFiles() : [];
    dev.hidden = files.length === 0;
    var dl = $('dev-list');
    dl.innerHTML = '';
    files.forEach(function (f) {
      var el = document.createElement('button');
      el.className = 'recent-item';
      el.innerHTML = '<div class="ri-ico">🧪</div><div class="ri-main"><div class="ri-name">' +
        esc(f.name) + '</div><div class="ri-sub">' + fmtSize(f.size) + '</div></div>';
      el.addEventListener('click', function () { Native.devOpen(f.path); });
      dl.appendChild(el);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 返回键 / 退出                                                       */
  /* ------------------------------------------------------------------ */

  window.qgenBack = function () {
    if (!$('modal-host').hidden) { closeModal(); return true; }
    if (!$('sheet-host').hidden) { closeSheet(); return true; }
    if (S.view === 'records') {
      if (recBack()) return true;
      show('list'); renderList(); return true;
    }
    if (S.view === 'editor') { show('list'); renderList(); return true; }
    if (S.view === 'list') {
      if (S.dirty) { confirmExit(); return true; }
      return false;
    }
    return false;
  };

  window.qgenRequestExit = function () {
    if (S.dirty) confirmExit();
    else Native.exitApp();
  };

  function confirmExit() {
    confirmModal('未保存的修改', '有未保存的修改，退出将丢失。可以保存后再退出。', function () {
      Native.exitApp();
    }, true);
    // 追加一个保存按钮
    var bar = $('modal').querySelector('.modal-actions');
    if (bar) {
      var b = document.createElement('button');
      b.textContent = '保存并退出';
      b.className = 'primary';
      b.addEventListener('click', function () {
        closeModal();
        doSave();
        setTimeout(function () { Native.exitApp(); }, 600);
      });
      bar.insertBefore(b, bar.firstChild);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 事件绑定                                                            */
  /* ------------------------------------------------------------------ */

  /* ---------------- 手势：单指拖动滚动 + 双指捏合缩放 ---------------- */
  /* 透明 textarea + 高亮层的组合在部分 WebView 上原生滚动会失灵，
     所以这里直接把平移手势接管（配套 CSS: #pane-code .editor-wrap{touch-action:none}）。 */
  function bindGestures() {
    var box = document.querySelector('#pane-code .editor-wrap');
    if (!box) return;
    var ta = $('edit-code');
    var pan = null, pinch = null;

    function dist(t) {
      var dx = t[0].clientX - t[1].clientX;
      var dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    box.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) {
        pan = null;
        pinch = { dist: dist(e.touches), base: S.codeSize };
      } else if (e.touches.length === 1) {
        pinch = null;
        pan = { y: e.touches[0].clientY, x: e.touches[0].clientX, top: ta.scrollTop, left: ta.scrollLeft, moved: false };
      }
    }, { passive: true });

    box.addEventListener('touchmove', function (e) {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        if (pinch.dist > 0) {
          var ns = Math.max(8, Math.min(28, Math.round(pinch.base * (dist(e.touches) / pinch.dist))));
          if (ns !== S.codeSize) { S.codeSize = ns; applyCodeStyle(false); syncView(); }
        }
        return;
      }
      if (!pan || e.touches.length !== 1) return;
      var dy = e.touches[0].clientY - pan.y;
      var dx = e.touches[0].clientX - pan.x;
      if (!pan.moved && Math.abs(dy) < 3 && Math.abs(dx) < 3) return;
      pan.moved = true;
      e.preventDefault();
      ta.scrollTop = Math.max(0, pan.top - dy);
      ta.scrollLeft = Math.max(0, pan.left - dx);
      syncView();
    }, { passive: false });

    function end(e) {
      if (e.touches && e.touches.length) return;
      if (pinch) {
        savePrefs();
        renderGutterLines(ta.value);
        if (S.find.open && S.find.idx >= 0) gotoMatch(S.find.idx);
      }
      pan = null;
      pinch = null;
      syncView();
    }
    box.addEventListener('touchend', end, { passive: true });
    box.addEventListener('touchcancel', end, { passive: true });
  }

  function bind() {
    $('btn-open').addEventListener('click', function () {
      if (S.dirty) { toast('请先保存或关闭当前文件'); return; }
      Native.pickOpen();
    });
    $('btn-new').addEventListener('click', function () {
      if (S.dirty) { toast('请先保存或关闭当前文件'); return; }
      S.game = QSP.newGame();
      S.file = { name: '未命名.qsp', uri: '', size: 0, writable: false };
      S.cur = -1;
      setDirty(true);
      renderList();
      show('list');
      toast('已新建空游戏，保存时会询问位置');
    });
    var btnImportZip = $('btn-import-zip');
    if (btnImportZip) btnImportZip.addEventListener('click', importTxtProject);
    $('btn-back').addEventListener('click', function () { if (!window.qgenBack()) closeFile(); });
    $('btn-menu').addEventListener('click', openMenu);
    $('topbar').addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      var a = document.activeElement;
      if (a && a.blur) a.blur();
    });
    $('link-about').addEventListener('click', about);
    $('sheet-mask').addEventListener('click', closeSheet);
    $('modal-host').querySelector('.modal-mask').addEventListener('click', closeModal);

    var searchTimer = null;
    $('search').addEventListener('input', function () {
      var v = this.value.trim();
      $('search-clear').hidden = !v;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { S.query = v; renderList(); }, 120);
    });
    $('search-clear').addEventListener('click', function () {
      $('search').value = ''; S.query = ''; this.hidden = true; renderList();
    });
    $('btn-add-loc').addEventListener('click', addLocation);
    $('loc-list').addEventListener('click', onLocClick);

    $('btn-rec-rescan').addEventListener('click', function () {
      S.records.scanned = false;
      scanRecords();
    });
    $('btn-rec-csv').addEventListener('click', recExportCSV);
    $('btn-rec-back').addEventListener('click', recBack);
    $('btn-rec-add-field').addEventListener('click', recAddField);
    $('btn-rec-columns').addEventListener('click', recOpenColumns);
    $('btn-rec-empty').addEventListener('click', recToggleEmpty);
    $('btn-rec-undo').addEventListener('click', recUndo);
    $('rec-family-list').addEventListener('click', function (e) {
      var card = e.target.closest('[data-fam]');
      if (card) openFamily(card.dataset.fam);
    });
    $('rec-table-wrap').addEventListener('click', recTableClick);
    var recTimer = null;
    $('rec-search').addEventListener('input', function () {
      var v = this.value.trim();
      $('rec-search-clear').hidden = !v;
      if (recTimer) clearTimeout(recTimer);
      recTimer = setTimeout(function () { recFilter(v); }, 120);
    });
    $('rec-search-clear').addEventListener('click', function () {
      $('rec-search').value = ''; this.hidden = true; recFilter('');
    });

    $('btn-wrap').addEventListener('click', function () {
      S.codeWrap = !S.codeWrap;
      applyCodeStyle();
      renderGutterLines($('edit-code').value);
      syncView();
      if (S.find.open && S.find.idx >= 0) gotoMatch(S.find.idx);
      toast(S.codeWrap ? '自动换行：开（行号已隐藏）' : '自动换行：关');
    });
    $('btn-zoom-out').addEventListener('click', function () { setCodeSize(S.codeSize - 1); });
    $('btn-zoom-in').addEventListener('click', function () { setCodeSize(S.codeSize + 1); });
    $('btn-lh').addEventListener('click', cycleLineHeight);
    $('btn-hl').addEventListener('click', function () {
      S.hlOn = !S.hlOn;
      applyHighlightMode();
      toast(S.hlOn ? '语法高亮：开' : '语法高亮：关');
    });
    $('btn-find').addEventListener('click', toggleFind);
    $('find-close').addEventListener('click', closeFind);
    $('find-prev').addEventListener('click', function () { findStep(-1); });
    $('find-next').addEventListener('click', function () { findStep(1); });
    var findInput = $('find-input');
    var findTimer = null;
    function queueFind() {
      var v = findInput.value;
      if (findTimer) clearTimeout(findTimer);
      findTimer = setTimeout(function () { runFind(v); }, 120);
    }
    findInput.addEventListener('input', function () {
      $('find-count').textContent = '…';
      queueFind();
    });
    // 中文等输入法组词时可能不触发 input；组词结束或内容确认后补搜一次
    findInput.addEventListener('compositionend', function () {
      if (findTimer) clearTimeout(findTimer);
      var el = this;
      setTimeout(function () { runFind(el.value); }, 0);
    });
    findInput.addEventListener('change', function () { runFind(this.value); });
    findInput.addEventListener('search', function () { runFind(this.value); });
    findInput.addEventListener('focus', function () {
      if (this.value !== S.find.q) runFind(this.value);
    });
    findInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        // 输入法刚提交、input 还没执行时，先按输入框当前内容搜索，不能跳到旧结果
        if (findInput.value !== S.find.q) {
          if (findTimer) clearTimeout(findTimer);
          runFind(findInput.value);
          return;
        }
        findStep(ev.shiftKey ? -1 : 1);
      }
      if (ev.key === 'Escape') closeFind();
    });
    bindGestures();
    var codeArea = document.querySelector('#pane-code .code-area');
    if (codeArea) {
      codeArea.addEventListener('click', function () {
        var ta = $('edit-code');
        setTimeout(function () {
          if (document.activeElement !== ta) {
            try { ta.focus(); } catch (e) { }
          }
        }, 60);
      });
    }
    $('edit-code').addEventListener('input', onCodeInput);
    $('edit-code').addEventListener('scroll', syncView);
  }

  function about() {
    var info = Native.appInfo() || {};
    var ver = info.version || '1.4.0';
    showModal('关于 QGen Android', '' +
      '<h3>QGen Android ' + esc(ver) + '</h3>' +
      '<p>QSP 游戏（.qsp）编辑器，功能参考开源的 <b>QGen 4.3</b>（QSP Foundation）。</p>' +
      '<p class="hint">本程序按 GPLv2+ 发布；QSP 文件格式的实现依据 QGen 的 game.cpp。</p>' +
      '<div class="kv"><span>设备</span><span>' + esc(info.device || '') + '</span></div>' +
      '<div class="kv"><span>Android SDK</span><span>' + (info.sdk || '') + '</span></div>' +
      '<div class="mcp-box">' +
        '<div class="mcp-title">MCP 服务（供 AI 查找/修改 .qsp）</div>' +
        '<div class="mcp-addr-row">' +
          '<input id="mcp-addr" class="mono" readonly value="http://127.0.0.1:8790/mcp" onclick="this.select()">' +
          '<button id="mcp-copy" class="text-btn" type="button">复制</button>' +
        '</div>' +
        '<div class="kv"><span>状态</span><span id="mcp-state">检测中…</span></div>' +
        '<div class="kv"><span>工具</span><span id="mcp-tools">—</span></div>' +
        '<div class="kv"><span>文件访问</span><span id="mcp-files">—</span></div>' +
        '<div class="mcp-path">App 启动后自动运行，只监听本机回环 127.0.0.1；退出 App 即停止。</div>' +
      '</div>',
      [{ text: '好', primary: true }]);

    var addr = document.getElementById('mcp-addr');
    var copy = document.getElementById('mcp-copy');
    if (addr) addr.addEventListener('focus', function () { addr.select(); });
    if (copy) copy.addEventListener('click', copyMcpAddr);

    var bar = document.querySelector('#modal .modal-actions');
    if (bar) {
      var restart = document.createElement('button');
      restart.textContent = '重启服务';
      restart.addEventListener('click', function () {
        Native.mcpRestart();
        setTimeout(checkMcp, 400);
      });
      var recheck = document.createElement('button');
      recheck.textContent = '重新检测';
      recheck.addEventListener('click', checkMcp);
      bar.insertBefore(recheck, bar.firstChild);
      bar.insertBefore(restart, bar.firstChild);
    }
    checkMcp();
  }

  function copyMcpAddr() {
    var addr = document.getElementById('mcp-addr');
    var text = addr ? addr.value : '';
    if (!text) return;
    if (Native.available && Native.copyText) {
      Native.copyText(text);
    } else {
      try {
        addr.select();
        document.execCommand('copy');
      } catch (e) { }
    }
  }

  function checkMcp() {
    var st = document.getElementById('mcp-state');
    var tl = document.getElementById('mcp-tools');
    var fl = document.getElementById('mcp-files');
    var addr = document.getElementById('mcp-addr');
    if (!st) return;
    var info = Native.mcpServerInfo ? Native.mcpServerInfo() : {};
    var port = info && info.port ? info.port : 8790;
    if (addr) addr.value = 'http://127.0.0.1:' + port + '/mcp';

    if (info && info.running) {
      st.innerHTML = '<span class="dot ok"></span>运行中';
      var n = 0;
      try { n = (window.QGenMcp ? QGenMcp.toolNames().length : 0); } catch (e) { }
      tl.textContent = n + ' 个（含记录表批量修改）';
    } else {
      st.innerHTML = '<span class="dot off"></span>未运行';
      tl.textContent = '点“重启服务”再试';
    }

    var hasAll = Native.mcpHasAllFiles ? Native.mcpHasAllFiles() : true;
    if (fl) {
      if (hasAll) {
        fl.innerHTML = '<span class="dot ok"></span>可读写共享目录';
      } else {
        fl.innerHTML = '<span class="dot off"></span>仅能读 App 私有目录 ' +
          '<button id="mcp-grant" class="text-btn" type="button">去授权</button>';
        var g = document.getElementById('mcp-grant');
        if (g) g.addEventListener('click', function () { Native.mcpRequestAllFiles(); });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  function boot() {
    try {
      var cs = parseInt(localStorage.getItem('qgen.codeSize') || '', 10);
      if (cs >= 8 && cs <= 28) S.codeSize = cs;
      S.codeWrap = localStorage.getItem('qgen.codeWrap') === '1';
      var hlPref = localStorage.getItem('qgen.hl');
      S.hlOn = hlPref === null ? true : hlPref === '1';
      var lh = parseFloat(localStorage.getItem('qgen.codeLH') || '');
      if (lh >= 1.0 && lh <= 2.0) S.codeLH = lh;
      if (LH_STEPS.indexOf(S.codeLH) < 0) S.codeLH = 1.3;
    } catch (e) { }
    bind();
    renderRecent();
    try {
      var vt = document.getElementById('ver-text');
      var info = Native.appInfo();
      if (vt && info && info.version) vt.textContent = info.version;
    } catch (e) { }
    show('home');
    if (Native.demo) {
      $('dev-box').hidden = false;
      $('dev-list').innerHTML = '<button class="recent-item" id="demo-load"><div class="ri-ico">🧪</div>' +
        '<div class="ri-main"><div class="ri-name">载入演示文件 jack.qsp</div>' +
        '<div class="ri-sub">浏览器演示模式（需要同目录下有 demo/jack.qsp）</div></div></button>';
      var el = $('demo-load');
      if (el) el.addEventListener('click', function () {
        fetch('demo/jack.qsp').then(function (r) { return r.arrayBuffer(); }).then(function (b) {
          window.qgenDemoLoad(new Uint8Array(b), 'jack.qsp');
        }).catch(function () { toast('演示文件不存在'); });
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
