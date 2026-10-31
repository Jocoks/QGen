/*
 * qgen-mcp —— App 内置 MCP 工具层（运行在 WebView 里）
 *
 * Java 侧的 McpHttpServer 只负责 HTTP/JSON-RPC 传输；真正的 QSP 读写、
 * 记录表筛选和批量修改都复用 qsp.js / records.js，和编辑器同源。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QGenMcp = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.4.0';
  var DEFAULT_ROOT = '/storage/emulated/0';

  /* ---------------- 基础工具 ---------------- */

  function fail(msg) {
    var e = new Error(msg);
    e.isMcpError = true;
    throw e;
  }

  function native() {
    var n = (typeof window !== 'undefined' ? window.Native : null);
    if (!n) fail('原生桥不可用');
    return n;
  }

  function bytesToB64(bytes) {
    var s = '', chunk = 0x8000, i;
    for (i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  function b64ToBytes(s) {
    var bin = atob(s), out = new Uint8Array(bin.length), i;
    for (i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function jget(v) {
    if (v && typeof v === 'object') return v;
    return JSON.parse(v || '{}');
  }

  function readBytes(path) {
    var st = jget(native().mcpFileStat(path));
    if (!st.ok) fail(st.error || ('无法读取：' + path));
    var size = Number(st.size) || 0;
    var out = new Uint8Array(size);
    var off = 0;
    while (off < size) {
      var n = Math.min(524288, size - off);
      var r = jget(native().mcpReadChunk(path, off, n));
      if (!r.ok) fail(r.error || '读取分块失败');
      var b = b64ToBytes(r.data);
      if (!b.length) fail('读取分块为空');
      out.set(b, off);
      off += b.length;
    }
    return out;
  }

  function writeBytes(path, bytes) {
    var b = jget(native().mcpWriteBegin(path));
    if (!b.ok) fail(b.error || ('无法写入：' + path));
    try {
      for (var off = 0; off < bytes.length; off += 262144) {
        var r = jget(native().mcpWriteChunk(bytesToB64(bytes.subarray(off, off + 262144))));
        if (!r.ok) fail(r.error || '写入分块失败');
      }
      var e = jget(native().mcpWriteEnd());
      if (!e.ok) fail(e.error || '写入失败');
      return e;
    } catch (err) {
      try { native().mcpWriteAbort(); } catch (x) { }
      throw err;
    }
  }

  function resolvePath(p) {
    if (!p || typeof p !== 'string') fail('缺少文件路径');
    if (p.charAt(0) === '/') return p;
    return DEFAULT_ROOT + '/' + p.replace(/^\.?\//, '');
  }

  function loadGame(p) {
    var abs = resolvePath(p);
    var bytes = readBytes(abs);
    var game;
    try {
      game = (typeof QSP !== 'undefined' ? QSP : require('../../assets/ui/qsp.js')).parse(bytes);
    } catch (e) {
      fail('不是有效的 QSP 文件（' + abs + '）：' + e.message);
    }
    return { abs: abs, game: game, bytes: bytes };
  }

  function saveGame(abs, game, dryRun) {
    var bytes = QSP.serialize(game);
    var check = QSP.parse(bytes);
    if (check.locations.length !== game.locations.length) fail('内部错误：序列化后位置数量不一致，已放弃写入');
    if (dryRun) return { dryRun: true, size: bytes.length };
    writeBytes(abs, bytes);
    return { size: bytes.length, locations: check.locations.length };
  }

  function findLocation(game, ref) {
    if (ref == null) fail('缺少位置名或序号');
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
      var i = Number(ref);
      if (i < 0 || i >= game.locations.length) fail('位置序号越界：' + i);
      return i;
    }
    var name = String(ref);
    for (var k = 0; k < game.locations.length; k++) {
      if (game.locations[k].name === name) return k;
    }
    var low = name.toLowerCase();
    for (k = 0; k < game.locations.length; k++) {
      if ((game.locations[k].name || '').toLowerCase() === low) return k;
    }
    fail('找不到位置「' + name + '」');
  }

  function locationBrief(l, i) {
    return {
      index: i,
      name: l.name,
      descChars: (l.desc || '').length,
      codeChars: (l.code || '').length,
      actions: (l.actions || []).length
    };
  }

  function lineSnippet(text, at, len, ctx) {
    ctx = ctx == null ? 40 : ctx;
    var ls = text.lastIndexOf('\n', at - 1) + 1;
    var le = text.indexOf('\n', at + len);
    if (le < 0) le = text.length;
    var line = text.slice(ls, le);
    var col = at - ls;
    var a = Math.max(0, col - ctx);
    var b = Math.min(line.length, col + len + ctx);
    return {
      line: text.slice(0, at).split('\n').length,
      snippet: (a > 0 ? '…' : '') + line.slice(a, col) + '⟦' +
        line.slice(col, col + len) + '⟧' + line.slice(col + len, b) + (b < line.length ? '…' : '')
    };
  }

  function searchField(text, query, regex, snippetsPer, ctx) {
    var out = [], re, m, from = 0, guard = 0;
    text = text || '';
    if (!text) return out;
    if (regex) {
      try { re = new RegExp(query, 'gi'); } catch (e) { fail('正则表达式无效：' + e.message); }
      while ((m = re.exec(text)) && guard++ < 5000) {
        out.push(lineSnippet(text, m.index, m[0].length, ctx));
        if (m.index === re.lastIndex) re.lastIndex++;
        if (out.length >= snippetsPer) break;
      }
      return out;
    }
    while (out.length < snippetsPer && guard++ < 5000) {
      var at = text.indexOf(query, from);
      if (at < 0) break;
      out.push(lineSnippet(text, at, query.length, ctx));
      from = at + Math.max(1, query.length);
    }
    return out;
  }

  function replaceOne(text, find, repl, all, regex, caseSensitive) {
    var count = 0, out;
    if (regex) {
      var flags = 'g' + (caseSensitive ? '' : 'i');
      var re;
      try { re = new RegExp(find, flags); } catch (e) { fail('正则表达式无效：' + e.message); }
      out = text.replace(re, function () {
        count++;
        return repl;
      });
      if (!all) {
        // 只替换第一处：用非全局正则在原串上重做
        var re1 = new RegExp(find, caseSensitive ? '' : 'i');
        count = re1.test(text) ? 1 : 0;
        out = text.replace(re1, repl);
      }
      return { text: out, count: count };
    }
    if (all) {
      var pos = 0, parts = [];
      var hay = caseSensitive ? text : text.toLowerCase();
      var needle = caseSensitive ? find : find.toLowerCase();
      for (;;) {
        var at = hay.indexOf(needle, pos);
        if (at < 0) break;
        parts.push(text.slice(pos, at), repl);
        pos = at + find.length;
        count++;
      }
      parts.push(text.slice(pos));
      return { text: parts.join(''), count: count };
    }
    var at1 = caseSensitive ? text.indexOf(find) : text.toLowerCase().indexOf(find.toLowerCase());
    if (at1 < 0) return { text: text, count: 0 };
    return { text: text.slice(0, at1) + repl + text.slice(at1 + find.length), count: 1 };
  }

  function getField(loc, field) {
    if (field === 'name') return loc.name || '';
    if (field === 'desc') return loc.desc || '';
    if (field === 'code') return loc.code || '';
    fail('field 只能是 name / desc / code');
  }

  function setField(loc, field, value) {
    if (field === 'name') loc.name = value;
    else if (field === 'desc') loc.desc = value;
    else if (field === 'code') loc.code = value;
    else fail('field 只能是 name / desc / code');
  }

  /* ---------------- 工具实现 ---------------- */

  var TOOLS = {};

  TOOLS.qsp_info = {
    description: '查看 .qsp 文件概要：大小、位置数、动作数、密码、文件头、md5。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: function (a) {
      var r = loadGame(a.path);
      var g = r.game;
      return {
        path: r.abs, size: r.bytes.length,
        header: g.date, password: g.password,
        locations: g.locations.length,
        actions: g.locations.reduce(function (n, l) { return n + (l.actions || []).length; }, 0),
        codeChars: g.locations.reduce(function (n, l) { return n + (l.code || '').length; }, 0),
        descChars: g.locations.reduce(function (n, l) { return n + (l.desc || '').length; }, 0)
      };
    }
  };

  TOOLS.qsp_list_locations = {
    description: '列出所有位置（序号、名称、字数、动作数），可按名称过滤。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, filter: { type: 'string' } }, required: ['path'] },
    handler: function (a) {
      var g = loadGame(a.path).game;
      var f = (a.filter || '').toLowerCase();
      var out = [];
      g.locations.forEach(function (l, i) {
        if (f && (l.name || '').toLowerCase().indexOf(f) < 0) return;
        out.push(locationBrief(l, i));
      });
      return { total: g.locations.length, matched: out.length, locations: out };
    }
  };

  TOOLS.qsp_get_location = {
    description: '读取一个位置的完整内容（描述、代码、动作列表）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        location: { type: ['string', 'number'] },
        includeActions: { type: 'boolean' }
      },
      required: ['path', 'location']
    },
    handler: function (a) {
      var g = loadGame(a.path).game;
      var i = findLocation(g, a.location);
      var l = g.locations[i];
      var out = { index: i, name: l.name, desc: l.desc || '', code: l.code || '' };
      if (a.includeActions !== false) out.actions = l.actions || [];
      return out;
    }
  };

  TOOLS.qsp_search = {
    description: '全文搜索位置名称/描述/代码/动作，返回命中次数与上下文片段（⟦关键字⟧），支持正则。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        query: { type: 'string' },
        regex: { type: 'boolean' },
        fields: { type: 'array', items: { type: 'string' } },
        maxLocations: { type: 'number' },
        snippetsPerLocation: { type: 'number' },
        context: { type: 'number' }
      },
      required: ['path', 'query']
    },
    handler: function (a) {
      if (!a.query) fail('缺少搜索内容');
      var g = loadGame(a.path).game;
      var fields = a.fields && a.fields.length ? a.fields : ['name', 'desc', 'code', 'actions'];
      var per = Math.max(1, Math.min(20, a.snippetsPerLocation || 3));
      var maxLoc = Math.max(1, Math.min(500, a.maxLocations || 50));
      var ctx = Math.max(0, Math.min(200, a.context == null ? 40 : a.context));
      var out = [];
      g.locations.forEach(function (l, i) {
        if (out.length >= maxLoc) return;
        var hits = {};
        var snippets = [];
        fields.forEach(function (f) {
          if (f === 'actions') {
            (l.actions || []).forEach(function (ac, ai) {
              var s = searchField(ac.code || '', a.query, a.regex, per, ctx);
              if (s.length) {
                hits.actions = (hits.actions || 0) + s.length;
                s.forEach(function (x) { x.action = ai; x.actionName = ac.name; snippets.push(x); });
              }
            });
          } else if (f === 'name' || f === 'desc' || f === 'code') {
            var s = searchField(l[f] || '', a.query, a.regex, per, ctx);
            if (s.length) {
              hits[f] = s.length;
              s.forEach(function (x) { x.field = f; snippets.push(x); });
            }
          }
        });
        var total = Object.keys(hits).reduce(function (n, k) { return n + hits[k]; }, 0);
        if (total) out.push({ index: i, name: l.name, hits: hits, total: total, snippets: snippets });
      });
      return { query: a.query, matched: out.length, results: out };
    }
  };

  TOOLS.qsp_set_location = {
    description: '整体替换一个位置的描述或代码（不传的字段保持不变），默认先 dryRun。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        location: { type: ['string', 'number'] },
        desc: { type: 'string' },
        code: { type: 'string' },
        dryRun: { type: 'boolean' }
      },
      required: ['path', 'location']
    },
    handler: function (a) {
      var r = loadGame(a.path), g = r.game;
      var i = findLocation(g, a.location);
      var old = { desc: g.locations[i].desc || '', code: g.locations[i].code || '' };
      if (typeof a.desc === 'string') g.locations[i].desc = a.desc;
      if (typeof a.code === 'string') g.locations[i].code = a.code;
      if (typeof a.desc !== 'string' && typeof a.code !== 'string') fail('至少要提供 desc 或 code');
      var saved = saveGame(r.abs, g, a.dryRun !== false);
      return { ok: true, location: g.locations[i].name, before: old, after: { desc: g.locations[i].desc, code: g.locations[i].code }, saved: saved };
    }
  };

  TOOLS.qsp_replace = {
    description: '在一个位置的 name/desc/code 中查找替换，支持正则、全部替换、dryRun。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        location: { type: ['string', 'number'] },
        field: { type: 'string' },
        find: { type: 'string' },
        replace: { type: 'string' },
        all: { type: 'boolean' },
        regex: { type: 'boolean' },
        caseSensitive: { type: 'boolean' },
        dryRun: { type: 'boolean' }
      },
      required: ['path', 'location', 'field', 'find', 'replace']
    },
    handler: function (a) {
      if (!a.find) fail('find 不能为空');
      var r = loadGame(a.path), g = r.game;
      var i = findLocation(g, a.location);
      var text = getField(g.locations[i], a.field);
      var rr = replaceOne(text, a.find, a.replace, !!a.all, !!a.regex, !!a.caseSensitive);
      if (rr.count) setField(g.locations[i], a.field, rr.text);
      var saved = saveGame(r.abs, g, a.dryRun !== false);
      return { ok: true, count: rr.count, saved: saved };
    }
  };

  TOOLS.qsp_replace_all = {
    description: '全游戏批量替换，默认 dryRun=true；确认后传 dryRun:false 才写回。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        find: { type: 'string' },
        replace: { type: 'string' },
        regex: { type: 'boolean' },
        caseSensitive: { type: 'boolean' },
        fields: { type: 'array', items: { type: 'string' } },
        dryRun: { type: 'boolean' }
      },
      required: ['path', 'find', 'replace']
    },
    handler: function (a) {
      if (!a.find) fail('find 不能为空');
      var r = loadGame(a.path), g = r.game;
      var fields = a.fields && a.fields.length ? a.fields : ['name', 'desc', 'code', 'actions'];
      var total = 0, changed = [];
      g.locations.forEach(function (l, i) {
        var n = 0;
        fields.forEach(function (f) {
          if (f === 'actions') {
            (l.actions || []).forEach(function (ac) {
              var rr = replaceOne(ac.code || '', a.find, a.replace, true, !!a.regex, !!a.caseSensitive);
              if (rr.count) { ac.code = rr.text; n += rr.count; }
            });
          } else if (f === 'name' || f === 'desc' || f === 'code') {
            var rr2 = replaceOne(l[f] || '', a.find, a.replace, true, !!a.regex, !!a.caseSensitive);
            if (rr2.count) { l[f] = rr2.text; n += rr2.count; }
          }
        });
        if (n) { total += n; changed.push({ index: i, name: l.name, count: n }); }
      });
      var saved = saveGame(r.abs, g, a.dryRun !== false);
      return { ok: true, total: total, changed: changed, saved: saved };
    }
  };

  TOOLS.qsp_add_location = {
    description: '新增位置，可指定插入序号；默认追加到末尾。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        name: { type: 'string' },
        code: { type: 'string' },
        desc: { type: 'string' },
        index: { type: 'number' },
        dryRun: { type: 'boolean' }
      },
      required: ['path', 'name']
    },
    handler: function (a) {
      if (!a.name) fail('缺少位置名');
      var r = loadGame(a.path), g = r.game;
      var idx = (a.index == null) ? g.locations.length : Number(a.index);
      if (!isFinite(idx) || idx < 0 || idx > g.locations.length) fail('插入序号越界');
      g.locations.splice(idx, 0, { name: a.name, desc: a.desc || '', code: a.code || '', actions: [] });
      var saved = saveGame(r.abs, g, a.dryRun !== false);
      return { ok: true, index: idx, saved: saved };
    }
  };

  TOOLS.qsp_rename_location = {
    description: '重命名位置。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, location: { type: ['string', 'number'] }, name: { type: 'string' }, dryRun: { type: 'boolean' } }, required: ['path', 'location', 'name'] },
    handler: function (a) {
      if (!a.name) fail('缺少新名称');
      var r = loadGame(a.path), g = r.game;
      var i = findLocation(g, a.location);
      var old = g.locations[i].name;
      g.locations[i].name = a.name;
      return { ok: true, before: old, after: a.name, saved: saveGame(r.abs, g, a.dryRun !== false) };
    }
  };

  TOOLS.qsp_delete_location = {
    description: '删除位置；默认 dryRun。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, location: { type: ['string', 'number'] }, dryRun: { type: 'boolean' } }, required: ['path', 'location'] },
    handler: function (a) {
      var r = loadGame(a.path), g = r.game;
      var i = findLocation(g, a.location);
      if (g.locations.length <= 1) fail('不能删除最后一个位置');
      var name = g.locations[i].name;
      g.locations.splice(i, 1);
      return { ok: true, deleted: name, saved: saveGame(r.abs, g, a.dryRun !== false) };
    }
  };

  TOOLS.qsp_action = {
    description: '动作管理：list / get / set / delete。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        location: { type: ['string', 'number'] },
        op: { type: 'string' },
        index: { type: 'number' },
        name: { type: 'string' },
        pict: { type: 'string' },
        code: { type: 'string' },
        dryRun: { type: 'boolean' }
      },
      required: ['path', 'location', 'op']
    },
    handler: function (a) {
      var r = loadGame(a.path), g = r.game;
      var i = findLocation(g, a.location), loc = g.locations[i];
      loc.actions = loc.actions || [];
      var op = a.op;
      if (op === 'list') return { actions: loc.actions.map(function (x, k) { return { index: k, pict: x.pict || '', name: x.name || '', codeChars: (x.code || '').length }; }) };
      if (op === 'get') {
        if (a.index == null || !loc.actions[a.index]) fail('动作序号无效');
        return loc.actions[a.index];
      }
      if (op === 'set') {
        if (a.index == null || !loc.actions[a.index]) fail('动作序号无效');
        if (typeof a.name === 'string') loc.actions[a.index].name = a.name;
        if (typeof a.pict === 'string') loc.actions[a.index].pict = a.pict;
        if (typeof a.code === 'string') loc.actions[a.index].code = a.code;
        return { ok: true, action: loc.actions[a.index], saved: saveGame(r.abs, g, a.dryRun !== false) };
      }
      if (op === 'delete') {
        if (a.index == null || !loc.actions[a.index]) fail('动作序号无效');
        var del = loc.actions.splice(a.index, 1)[0];
        return { ok: true, deleted: del, saved: saveGame(r.abs, g, a.dryRun !== false) };
      }
      fail('op 只能是 list / get / set / delete');
    }
  };

  TOOLS.qsp_create = {
    description: '新建空白 QSP 游戏（含 Start 位置）。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, dryRun: { type: 'boolean' } }, required: ['path'] },
    handler: function (a) {
      var g = QSP.newGame();
      return { ok: true, path: resolvePath(a.path), saved: saveGame(resolvePath(a.path), g, a.dryRun !== false) };
    }
  };

  TOOLS.qsp_validate = {
    description: '校验 QSP 文件：能否解析、位置/动作数、无名位置告警。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: function (a) {
      var r = loadGame(a.path), g = r.game;
      var empty = g.locations.filter(function (l) { return !l.name; }).length;
      return {
        ok: true, path: r.abs, size: r.bytes.length,
        locations: g.locations.length,
        actions: g.locations.reduce(function (n, l) { return n + (l.actions || []).length; }, 0),
        emptyNames: empty,
        warning: empty ? '存在 ' + empty + ' 个无名位置' : null
      };
    }
  };

  /* ---------------- 记录表工具 ---------------- */

  function scanFamilies(path, opts) {
    var g = loadGame(path).game;
    var s = QSPRecords.scan(g, opts || {});
    return { game: g, scan: s };
  }

  function pickFamily(scan, ref) {
    var list = scan.families || [];
    var found = null;
    list.forEach(function (f) {
      if (f.descriptor.id === ref || f.descriptor.label === ref) found = f;
    });
    if (!found) fail('找不到记录族：' + ref + '（可先调用 qsp_records_scan）');
    return found;
  }

  TOOLS.qsp_records_scan = {
    description: '扫描 QSP 中可表格化的记录族（物品/敌人/NPC 等），返回候选、记录数、字段数。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        minRecords: { type: 'number' },
        maxFamilies: { type: 'number' },
        maxFields: { type: 'number' }
      },
      required: ['path']
    },
    handler: function (a) {
      var s = scanFamilies(a.path, { maxFields: a.maxFields || 60 }).scan;
      var max = Math.max(1, Math.min(100, a.maxFamilies || 30));
      var families = (s.families || []).slice(0, max).map(function (f) {
        return {
          id: f.descriptor.id,
          label: f.descriptor.label,
          records: f.recordCount,
          fields: f.fieldCount,
          score: Math.round(f.score * 100) / 100,
          locations: f.descriptor.scope ? f.descriptor.scope.locations : null
        };
      });
      return { statements: s.statementCount, families: families, totalFamilies: (s.families || []).length };
    }
  };

  TOOLS.qsp_records_table = {
    description: '按记录族读取表格（默认最多 100 行），返回列、行值、缺失/冲突标记。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        family: { type: 'string' },
        limit: { type: 'number' },
        filter: { type: 'string' }
      },
      required: ['path', 'family']
    },
    handler: function (a) {
      var x = scanFamilies(a.path, { maxFields: 60 });
      var f = pickFamily(x.scan, a.family);
      var t = QSPRecords.buildTable(x.game, f.descriptor, {});
      if (!t.ok) fail((t.errors || []).join('；') || '建表失败');
      var limit = Math.max(1, Math.min(1000, a.limit || 100));
      var q = (a.filter || '').toLowerCase();
      var rows = [];
      t.rows.forEach(function (r) {
        if (q && String(r.id).toLowerCase().indexOf(q) < 0) return;
        if (rows.length >= limit) return;
        rows.push({ id: r.id, values: r.values, flags: r.flags });
      });
      return {
        family: f.descriptor.label,
        id: f.descriptor.id,
        columns: t.columns.map(function (c) { return { key: c.key, label: c.label, type: c.type, source: c.source }; }),
        rows: rows,
        totalRows: t.rows.length,
        shown: rows.length,
        warnings: t.warnings || []
      };
    }
  };

  TOOLS.qsp_records_update = {
    description: '按“记录族 + 行 id + 字段”批量改值；改的是 QSP 原文偏移，默认 dryRun=true，确认后传 dryRun:false。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              family: { type: 'string' },
              id: { type: 'string' },
              field: { type: 'string' },
              value: { type: ['string', 'number', 'boolean'] }
            },
            required: ['family', 'id', 'field', 'value']
          }
        },
        dryRun: { type: 'boolean' }
      },
      required: ['path', 'updates']
    },
    handler: function (a) {
      if (!a.updates || !a.updates.length) fail('updates 不能为空');
      var r = loadGame(a.path), g = r.game;
      var s = QSPRecords.scan(g, { maxFields: 60 });
      var cache = {}, done = [], errors = [];
      a.updates.forEach(function (u, ui) {
        try {
          var fam = cache[u.family];
          if (!fam) {
            var f = pickFamily(s, u.family);
            var t = QSPRecords.buildTable(g, f.descriptor, {});
            if (!t.ok) fail((t.errors || []).join('；') || '建表失败');
            fam = cache[u.family] = { t: t, cols: {} };
            t.columns.forEach(function (c) { fam.cols[c.key] = c; });
          }
          var row = null;
          for (var i = 0; i < fam.t.rows.length; i++) if (fam.t.rows[i].id === u.id) { row = fam.t.rows[i]; break; }
          if (!row) fail('记录族里找不到 id：' + u.id);
          var c = fam.cols[u.field];
          if (!c) fail('找不到字段：' + u.field);
          var fl = row.flags[u.field] || [];
          if (fl.indexOf('conflict') >= 0) fail('字段存在冲突，拒绝自动修改：' + u.field);
          if (fl.indexOf('missing') >= 0 || !row.sources[u.field]) fail('该记录没有字段：' + u.field);
          var src = row.sources[u.field];
          var res = QSPRecords.updateValue(g, {
            location: src.location, start: src.start, end: src.end,
            source: c.source, type: c.type
          }, u.value);
          if (!res.ok) fail(res.error || '修改失败');
          done.push({ index: ui, family: u.family, id: u.id, field: u.field, edit: res.edit });
        } catch (e) {
          errors.push({ index: ui, error: e.message });
        }
      });
      if (errors.length) return { ok: false, changed: 0, errors: errors };
      var saved = saveGame(r.abs, g, a.dryRun !== false);
      return { ok: true, changed: done.length, errors: [], saved: saved };
    }
  };

  /* ---------------- 分发 ---------------- */

  function callTool(name, args) {
    var t = TOOLS[name];
    if (!t) fail('未知工具：' + name);
    return t.handler(args || {});
  }

  function toolList() {
    return Object.keys(TOOLS).map(function (n) {
      return { name: n, description: TOOLS[n].description, inputSchema: TOOLS[n].inputSchema };
    });
  }

  function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code: code, message: message } };
  }

  function handleRpc(raw) {
    var req;
    try { req = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (e) { return rpcError(null, -32700, 'JSON 解析失败：' + e.message); }
    if (!req || req.jsonrpc !== '2.0' || !req.method) return rpcError(req && req.id, -32600, '不是合法的 JSON-RPC 2.0 请求');
    var id = req.id;
    var isNotification = (id === undefined || id === null);
    var p = req.params || {};

    if (req.method === 'notifications/initialized' || req.method === 'notifications/cancelled') return null;
    if (req.method === 'ping') return isNotification ? null : { jsonrpc: '2.0', id: id, result: {} };

    if (req.method === 'initialize') {
      var proto = p.protocolVersion || '2024-11-05';
      return {
        jsonrpc: '2.0', id: id,
        result: {
          protocolVersion: proto,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'qgen', title: 'QGen Android 内置 MCP', version: VERSION },
          instructions: '直接传绝对路径，例如 /storage/emulated/0/DSH/game.qsp。修改类工具默认 dryRun=true，确认返回的 diff/计数后再传 dryRun:false。'
        }
      };
    }

    if (req.method === 'tools/list') {
      return isNotification ? null : { jsonrpc: '2.0', id: id, result: { tools: toolList() } };
    }

    if (req.method === 'tools/call') {
      var name = p.name;
      var args = p.arguments || {};
      var t = TOOLS[name];
      if (!t) return rpcError(id, -32602, '未知工具：' + name);
      try {
        var result = t.handler(args);
        var text = JSON.stringify(result, null, 2);
        var out = {
          jsonrpc: '2.0', id: id,
          result: { content: [{ type: 'text', text: text }], structuredContent: result, isError: false }
        };
        if (isNotification) return null;
        return out;
      } catch (e) {
        var msg = e && e.message ? e.message : String(e);
        if (isNotification) return null;
        return {
          jsonrpc: '2.0', id: id,
          result: { content: [{ type: 'text', text: '错误：' + msg }], isError: true }
        };
      }
    }

    return isNotification ? null : rpcError(id, -32601, '未知方法：' + req.method);
  }

  return {
    version: VERSION,
    toolNames: function () { return Object.keys(TOOLS); },
    toolListJson: function () { return JSON.stringify(toolList()); },
    handleRpc: handleRpc,
    dispatch: function (name, args) {
      try {
        var r = callTool(name, args);
        return JSON.stringify({ ok: true, result: r });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message || String(e) });
      }
    }
  };
});
