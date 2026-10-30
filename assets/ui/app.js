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
    busy: false
  };

  var LIST_RENDER_LIMIT = 400;

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
    if (S.view === 'editor' && S.cur >= 0) {
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

  function openFromBytes(bytes, name) {
    var game;
    try {
      game = QSP.parse(bytes);
    } catch (e) {
      showModal('无法打开文件', '<h3>打开失败</h3><p>' + esc(e.message) + '</p>',
        [{ text: '好', primary: true }]);
      return;
    }
    S.game = game;
    S.cur = -1;
    S.query = '';
    $('search').value = '';
    $('search-clear').hidden = true;
    setDirty(false);
    var cf = Native.currentFile ? Native.currentFile() : {};
    S.file = {
      name: name || (cf && cf.name) || '未命名.qsp',
      uri: (cf && cf.uri) || '',
      size: bytes.length,
      writable: cf && cf.writable !== false,
      path: (cf && cf.path) || ''
    };
    renderList();
    show('list');
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
    toast('行距 ' + Math.round(S.codeLH * 100) + '%');
  }

  function updateEditorInfo() {
    if (S.cur < 0 || !S.game) { $('editor-info').textContent = ''; return; }
    var loc = S.game.locations[S.cur];
    $('editor-info').textContent = '代码 ' + (loc.code || '').length + ' 字';
  }

  var HL_LIMIT = 250000;      // 超过这个长度不做高亮（保证输入不卡）
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
    if (src.length > HL_LIMIT) {
      body.textContent = src;
      if (!S._hlOff) { toast('代码超过 ' + Math.round(HL_LIMIT / 1000) + 'K 字符，已关闭语法高亮'); S._hlOff = true; }
    } else {
      if (S._hlOff) S._hlOff = false;
      var marks = (S.find.open && S.find.marks.length) ? S.find.marks : null;
      body.innerHTML = QSPHL.highlight(src, marks);
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
    if (n > 5000) { gutter.textContent = ''; return; }
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
    try { ta.setSelectionRange(m.s, m.e); } catch (e) { }
    var before = ta.value.slice(0, m.s);
    var line = 0;
    for (var p = 0; p < before.length; p++) if (before.charCodeAt(p) === 10) line++;
    var lh = Math.round(S.codeSize * S.codeLH);
    var center = Math.max(0, line * lh - Math.floor(ta.clientHeight / 2) + lh);
    ta.scrollTop = center;
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
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') cb(inp.value); });
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
      { ico: 'ℹ', text: '游戏信息', fn: showGameInfo }
    ];
    if (S.view === 'editor' && S.cur >= 0) {
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
      if (pinch) { savePrefs(); renderGutterLines(ta.value); }
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

    $('btn-wrap').addEventListener('click', function () {
      S.codeWrap = !S.codeWrap;
      applyCodeStyle();
      renderGutterLines($('edit-code').value);
      syncView();
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
    findInput.addEventListener('input', function () {
      var v = this.value;
      if (findTimer) clearTimeout(findTimer);
      findTimer = setTimeout(function () { runFind(v); }, 120);
    });
    findInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); findStep(ev.shiftKey ? -1 : 1); }
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
    var ver = info.version || '1.2.0';
    showModal('关于 QGen Android', '' +
      '<h3>QGen Android ' + esc(ver) + '</h3>' +
      '<p>QSP 游戏（.qsp）编辑器，功能参考开源的 <b>QGen 4.3</b>（QSP Foundation）。</p>' +
      '<p class="hint">本程序按 GPLv2+ 发布；QSP 文件格式的实现依据 QGen 的 game.cpp。</p>' +
      '<div class="kv"><span>设备</span><span>' + esc(info.device || '') + '</span></div>' +
      '<div class="kv"><span>Android SDK</span><span>' + (info.sdk || '') + '</span></div>' +
      '<div class="mcp-box">' +
        '<div class="mcp-title">MCP 服务（供 AI 查找/修改 .qsp）</div>' +
        '<div class="kv"><span>地址</span><span class="mono">http://127.0.0.1:<b id="mcp-port">8790</b>/mcp</span></div>' +
        '<div class="kv"><span>状态</span><span id="mcp-state">检测中…</span></div>' +
        '<div class="kv"><span>工具</span><span id="mcp-tools">—</span></div>' +
        '<div class="mcp-label">启动命令（长按可复制）</div>' +
        '<textarea class="mcp-cmd" readonly rows="2">nohup sh &lt;项目目录&gt;/mcp/start-http.sh 8790 &gt; ~/qsp-mcp.log 2&gt;&amp;1 &amp;</textarea>' +
        '<div class="mcp-label">APK 内置文件</div>' +
        '<div class="mcp-path">assets/mcp/server.js · assets/mcp/start-http.sh · 只监听本机回环</div>' +
      '</div>',
      [{ text: '好', primary: true }]);

    // 追加一个不关闭弹窗的「重新检测」
    var bar = document.querySelector('#modal .modal-actions');
    if (bar) {
      var btn = document.createElement('button');
      btn.textContent = '重新检测';
      btn.addEventListener('click', checkMcp);
      bar.insertBefore(btn, bar.firstChild);
    }
    checkMcp();
  }

  function checkMcp() {
    var st = document.getElementById('mcp-state');
    var tl = document.getElementById('mcp-tools');
    if (!st) return;
    st.textContent = '检测中…';
    var done = false;
    var timer = setTimeout(function () { if (!done) failMcp('超时'); }, 2000);
    function ok(d) {
      if (done) return; done = true; clearTimeout(timer);
      st.innerHTML = '<span class="dot ok"></span>运行中';
      tl.textContent = (d && d.tools ? d.tools.length : 0) + ' 个';
    }
    function failMcp(why) {
      if (done) return; done = true; clearTimeout(timer);
      st.innerHTML = '<span class="dot off"></span>未运行';
      tl.textContent = '—（' + (why || '连接失败') + '）';
    }
    var url = 'http://127.0.0.1:8790/';
    // WebView 的 file:// 源不能直接 fetch http，优先走原生桥
    var raw = Native.httpGet ? Native.httpGet(url) : '';
    if (raw) {
      try { ok(JSON.parse(raw)); } catch (e) { failMcp('响应格式错误'); }
      return;
    }
    try {
      fetch(url, { mode: 'cors', cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(ok)
        .catch(function (e) { failMcp(e && e.message); });
    } catch (e) {
      failMcp(e.message);
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
