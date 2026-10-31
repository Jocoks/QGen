/*!
 * records.js — QSP 通用记录表：扫描、描述符、聚合、CSV
 * ------------------------------------------------------------------
 * 目标不是理解任意 QSP 语义，而是把“按 key 聚合的静态数据”抽成表：
 *   - array['id'] = value
 *   - array['id'] = { ... }
 *   - dynamic $helper, 'id', arg2, arg3, ...
 *
 * 自动扫描给出候选记录族；用户可以用描述符人工补充/修正字段。
 * 浏览器与 Node 共用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.QSPRecords = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var SLUG_MAX = 48;

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                            */
  /* ------------------------------------------------------------------ */

  function trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }

  function slug(s) {
    var out = String(s == null ? '' : s)
      .replace(/^\$/, '')
      .replace(/[^\w\u0080-\uFFFF]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!out) out = 'field';
    if (/^\d/.test(out)) out = 'f_' + out;
    return out.slice(0, SLUG_MAX);
  }

  function clone(o) {
    if (o == null || typeof o !== 'object') return o;
    if (Array.isArray(o)) {
      var a = [];
      for (var i = 0; i < o.length; i++) a.push(clone(o[i]));
      return a;
    }
    var r = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = clone(o[k]);
    return r;
  }

  function isQuoted(s) {
    s = trim(s);
    return s.length >= 2 && s.charAt(0) === "'" && s.charAt(s.length - 1) === "'";
  }

  function decodeString(s) {
    s = trim(s);
    if (!isQuoted(s)) return null;
    var body = s.slice(1, -1);
    // QSP 用两个单引号表示字符串内的一个单引号
    return body.replace(/''/g, "'");
  }

  function isNumberLiteral(s) {
    return /^-?(?:\d+\.?\d*|\.\d+)$/.test(trim(s));
  }

  function literalValue(s) {
    s = trim(s);
    var str = decodeString(s);
    if (str !== null) return { ok: true, value: str, kind: 'string', raw: s };
    if (isNumberLiteral(s)) return { ok: true, value: Number(s), kind: 'number', raw: s };
    return { ok: false, value: s, kind: 'expr', raw: s };
  }

  /* ------------------------------------------------------------------ */
  /* 词法：按顶层 & / 换行拆语句，跳过字符串、注释、代码块               */
  /* ------------------------------------------------------------------ */

  function splitStatements(code) {
    var out = [];
    var n = code.length;
    var start = 0;
    var quote = false, comment = false;
    var brace = 0, brack = 0, paren = 0;
    var i, c;

    function emit(end) {
      if (end > start) {
        var text = code.slice(start, end);
        if (trim(stripComments(text))) out.push({ start: start, end: end, text: text });
      }
      start = end + 1;
    }

    for (i = 0; i < n; i++) {
      c = code.charAt(i);

      if (comment) {
        if (c === '\n') {
          comment = false;
          if (brace === 0 && brack === 0 && paren === 0) emit(i);
        }
        continue;
      }
      if (quote) {
        if (c === "'") {
          if (code.charAt(i + 1) === "'") i++;
          else quote = false;
        }
        continue;
      }
      if (c === "'") { quote = true; continue; }
      if (c === '!') { comment = true; continue; }

      if (c === '{') { brace++; continue; }
      if (c === '}') { if (brace > 0) brace--; continue; }
      if (c === '[') { brack++; continue; }
      if (c === ']') { if (brack > 0) brack--; continue; }
      if (c === '(') { paren++; continue; }
      if (c === ')') { if (paren > 0) paren--; continue; }

      if (brace === 0 && brack === 0 && paren === 0 && (c === '&' || c === '\n')) {
        emit(i);
      }
    }
    if (n > start) emit(n);
    return out;
  }

  /** 去掉字符串外的 ! 注释（保持长度，不破坏位置感） */
  function stripComments(text) {
    var out = '';
    var quote = false;
    var i, c;
    for (i = 0; i < text.length; i++) {
      c = text.charAt(i);
      if (quote) {
        out += c;
        if (c === "'") {
          if (text.charAt(i + 1) === "'") { out += "'"; i++; }
          else quote = false;
        }
        continue;
      }
      if (c === "'") { quote = true; out += c; continue; }
      if (c === '!') {
        while (i < text.length && text.charAt(i) !== '\n') { out += ' '; i++; }
        if (i < text.length) out += '\n';
        continue;
      }
      out += c;
    }
    return out;
  }

  function splitArgs(text) {
    var out = [];
    var n = text.length;
    var start = 0;
    var quote = false, brace = 0, brack = 0, paren = 0;
    var i, c;
    for (i = 0; i < n; i++) {
      c = text.charAt(i);
      if (quote) {
        if (c === "'") {
          if (text.charAt(i + 1) === "'") i++;
          else quote = false;
        }
        continue;
      }
      if (c === "'") { quote = true; continue; }
      if (c === '{') { brace++; continue; }
      if (c === '}') { if (brace > 0) brace--; continue; }
      if (c === '[') { brack++; continue; }
      if (c === ']') { if (brack > 0) brack--; continue; }
      if (c === '(') { paren++; continue; }
      if (c === ')') { if (paren > 0) paren--; continue; }
      if (c === ',' && brace === 0 && brack === 0 && paren === 0) {
        out.push(trim(text.slice(start, i)));
        start = i + 1;
      }
    }
    out.push(trim(text.slice(start)));
    return out;
  }

  /** 读取从 open（指向 [）开始的括号内容，返回结束位置 +1 */
  function bracketEnd(s, open) {
    var quote = false;
    for (var i = open + 1; i < s.length; i++) {
      var c = s.charAt(i);
      if (quote) {
        if (c === "'") {
          if (s.charAt(i + 1) === "'") i++;
          else quote = false;
        }
        continue;
      }
      if (c === "'") { quote = true; continue; }
      if (c === ']') return i + 1;
    }
    return -1;
  }

  function parseBracket(raw) {
    var s = trim(raw);
    var str = decodeString(s);
    if (str !== null) return { static: true, value: str, raw: s, kind: 'string' };
    if (isNumberLiteral(s)) return { static: true, value: String(Number(s)), raw: s, kind: 'number' };
    return { static: false, value: null, raw: s, kind: 'expr' };
  }

  /** 解析 LHS：base[expr][expr]... = / += ... */
  function parseLHS(s) {
    var m = /^\s*(\$?[^\s\[\]=+\-*\/&]+)/.exec(s);
    if (!m) return null;
    var base = m[1];
    var pos = m[0].length;
    var path = [];
    while (pos < s.length) {
      while (pos < s.length && /\s/.test(s.charAt(pos))) pos++;
      if (s.charAt(pos) !== '[') break;
      var end = bracketEnd(s, pos);
      if (end < 0) return null;
      path.push(parseBracket(s.slice(pos + 1, end - 1)));
      pos = end;
    }
    while (pos < s.length && /\s/.test(s.charAt(pos))) pos++;
    var op = null;
    var two = s.substr(pos, 2);
    if (two === '+=' || two === '-=' || two === '*=' || two === '/=') {
      op = two; pos += 2;
    } else if (s.charAt(pos) === '=' && s.charAt(pos + 1) !== '=') {
      op = '='; pos += 1;
    } else {
      return null;
    }
    return {
      base: base,
      path: path,
      op: op,
      rhs: trim(s.slice(pos))
    };
  }

  function parseStatement(text, loc) {
    var clean = stripComments(text);
    var m = /^dynamic\s+([^\s,]+)\s*,\s*([\s\S]*)$/i.exec(trim(clean));
    if (m && m[2].length) {
      var args = splitArgs(m[2]);
      var key = literalValue(args[0]);
      return {
        loc: loc,
        kind: 'helper',
        helper: m[1],
        args: args,
        key: key.ok ? String(key.value) : null,
        dynamicKey: !key.ok,
        value: key,
        text: text
      };
    }
    var lhs = parseLHS(clean);
    if (!lhs) return null;
    var keyPart = lhs.path[0];
    var key = keyPart && keyPart.static ? String(keyPart.value) : null;
    var path = [];
    for (var i = 1; i < lhs.path.length; i++) {
      if (lhs.path[i].static) path.push(String(lhs.path[i].value));
      else path.push(null);
    }
    return {
      loc: loc,
      kind: 'array',
      base: lhs.base,
      path: path,
      pathRaw: lhs.path.slice(1).map(function (p) { return p.raw; }),
      op: lhs.op,
      key: key,
      dynamicKey: !keyPart || !keyPart.static,
      rhs: lhs.rhs,
      value: literalValue(lhs.rhs),
      text: text
    };
  }

  function indexGame(game, scope) {
    var allowed = null;
    if (scope && Array.isArray(scope.locations) && scope.locations.length &&
        scope.locations.indexOf('*') < 0) {
      allowed = {};
      for (var i = 0; i < scope.locations.length; i++) allowed[scope.locations[i]] = true;
    }
    var stmts = [];
    var order = 0;
    for (var li = 0; li < game.locations.length; li++) {
      var loc = game.locations[li];
      if (allowed && !allowed[loc.name]) continue;
      var raw = splitStatements(loc.code || '');
      for (var si = 0; si < raw.length; si++) {
        var p = parseStatement(raw[si].text, loc.name);
        if (!p) continue;
        p.order = order++;
        p.start = raw[si].start;
        p.end = raw[si].end;
        p.location = loc.name;
        stmts.push(p);
      }
    }
    return stmts;
  }

  function arrayFieldId(p) {
    return '$' + p.base + (p.path.length ? '[' + p.path.join('][') + ']' : '');
  }

  function fieldIdForArray(p) {
    return 'a:' + p.base + '\u0000' + p.path.join('\u0000');
  }

  function fieldIdForHelperArg(helper, index) {
    return 'h:' + helper + '\u0000' + index;
  }

  function fieldLabelForArray(p) {
    return p.base + (p.path.length ? '[' + p.path.join('][') + ']' : '');
  }

  function fieldLabelForHelperArg(helper, index) {
    return helper + ' 参数 ' + index;
  }

  function inferType(values) {
    var has = false, allNum = true, hasBlock = false;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v == null || v === '') continue;
      has = true;
      var s = String(v);
      if (/^\s*\{/.test(s)) hasBlock = true;
      if (!isNumberLiteral(s) && typeof v !== 'number') allNum = false;
    }
    if (!has) return 'text';
    if (hasBlock) return 'code';
    return allNum ? 'number' : 'text';
  }

  function uniqueKey(base, used) {
    var k = base, n = 2;
    while (used[k]) { k = base + '_' + n; n++; }
    used[k] = true;
    return k;
  }

  /* ------------------------------------------------------------------ */
  /* 自动发现记录族                                                      */
  /* ------------------------------------------------------------------ */

  function scan(game, opts) {
    opts = opts || {};
    var minRecords = opts.minRecords || 3;
    var minFields = opts.minFields || 2;
    var maxFields = opts.maxFields || 80;
    var maxRecords = opts.maxRecords || 5000;
    var stmts = indexGame(game, null);
    var byLoc = {};
    var i, p;

    for (i = 0; i < stmts.length; i++) {
      p = stmts[i];
      if (p.dynamicKey || p.key == null) continue;
      if (p.kind === 'helper' && p.args.length < 2) continue;
      if (p.kind === 'array' && p.pathRaw && p.pathRaw.some(function (x) { return x == null; })) continue;
      var bucket = byLoc[p.loc] || (byLoc[p.loc] = {
        name: p.loc,
        keys: {},
        keyOrder: [],
        arrayFields: {},
        helperFields: {},
        arrays: {},
        helpers: {},
        stmtCount: 0
      });
      bucket.stmtCount++;
      var key = p.key;
      if (!bucket.keys[key]) { bucket.keys[key] = true; bucket.keyOrder.push(key); }
      if (p.kind === 'array') {
        var fid = fieldIdForArray(p);
        var af = bucket.arrayFields[fid] || (bucket.arrayFields[fid] = {
          id: fid, base: p.base, path: p.path, keys: {}, values: []
        });
        af.keys[key] = true;
        af.values.push(p.value.value != null ? p.value.value : p.rhs);
        bucket.arrays[p.base] = true;
      } else {
        for (var ai = 1; ai < p.args.length; ai++) {
          var hfid = fieldIdForHelperArg(p.helper, ai + 1);
          var hf = bucket.helperFields[hfid] || (bucket.helperFields[hfid] = {
            id: hfid, helper: p.helper, arg: ai + 1, keys: {}, values: []
          });
          var av = literalValue(p.args[ai]);
          hf.keys[key] = true;
          hf.values.push(av.ok ? av.value : p.args[ai]);
        }
        bucket.helpers[p.helper] = true;
      }
    }

    var families = [];
    Object.keys(byLoc).forEach(function (locName) {
      var b = byLoc[locName];
      var keyFieldCount = {};
      var f;
      for (var fid in b.arrayFields) {
        f = b.arrayFields[fid];
        for (var k in f.keys) keyFieldCount[k] = (keyFieldCount[k] || 0) + 1;
      }
      for (var hid in b.helperFields) {
        f = b.helperFields[hid];
        for (var hk in f.keys) keyFieldCount[hk] = (keyFieldCount[hk] || 0) + 1;
      }
      var keys = [];
      for (var ki = 0; ki < b.keyOrder.length; ki++) {
        var kk = b.keyOrder[ki];
        if ((keyFieldCount[kk] || 0) >= 2) keys.push(kk);
      }
      if (keys.length < minRecords || keys.length > maxRecords) return;
      var records = {};
      keys.forEach(function (k) { records[k] = true; });

      var used = {};
      var fields = [];
      var allFields = [];
      Object.keys(b.arrayFields).forEach(function (fid) { allFields.push({ kind: 'array', f: b.arrayFields[fid] }); });
      Object.keys(b.helperFields).forEach(function (fid) { allFields.push({ kind: 'helper', f: b.helperFields[fid] }); });

      // 优先包含覆盖率高、字段数多的列；限制最大列数，避免异常表撑爆
      allFields.sort(function (x, y) {
        return Object.keys(y.f.keys).length - Object.keys(x.f.keys).length;
      });
      for (var fi = 0; fi < allFields.length && fields.length < maxFields; fi++) {
        var item = allFields[fi];
        var count = 0;
        for (var kx in item.f.keys) if (records[kx]) count++;
        if (count < 2) continue;
        var fld, baseKey, label, type;
        if (item.kind === 'array') {
          fld = item.f;
          baseKey = slug(fld.base + (fld.path.length ? '_' + fld.path.join('_') : ''));
          label = fieldLabelForArray(fld);
          type = inferType(fld.values);
          var vals = [];
          for (var m in fld.keys) if (records[m]) vals.push(fld.base);
          fields.push({
            key: uniqueKey(baseKey, used),
            label: label,
            type: type,
            source: { kind: 'array', name: fld.base, path: fld.path.slice() }
          });
        } else {
          fld = item.f;
          baseKey = slug(fld.helper + '_arg' + fld.arg);
          label = fieldLabelForHelperArg(fld.helper, fld.arg);
          type = inferType(fld.values);
          fields.push({
            key: uniqueKey(baseKey, used),
            label: label,
            type: type,
            source: { kind: 'helperArg', helper: fld.helper, arg: fld.arg }
          });
        }
      }
      if (fields.length < minFields) return;

      var sources = [];
      Object.keys(b.arrays).forEach(function (name) {
        sources.push({ kind: 'array', name: name });
      });
      Object.keys(b.helpers).forEach(function (name) {
        sources.push({ kind: 'helper', name: name });
      });

      var helperList = Object.keys(b.helpers);
      var label = locName;
      if (helperList.length === 1) label = locName + ' · ' + helperList[0];
      else if (helperList.length > 1) label = locName + ' · ' + helperList.length + ' 个 helper';

      var family = {
        id: 'auto:' + slug(locName) + ':' + families.length,
        label: label,
        location: locName,
        recordCount: keys.length,
        fieldCount: fields.length,
        score: keys.length * Math.log(fields.length + 1),
        descriptor: {
          version: VERSION,
          id: 'auto:' + slug(locName),
          label: label,
          scope: { locations: [locName] },
          records: { kind: 'keyed', sources: sources },
          fields: fields
        },
        preview: []
      };
      for (var pi = 0; pi < keys.length && pi < 3; pi++) {
        family.preview.push(keys[pi]);
      }
      families.push(family);
    });

    families.sort(function (a, b) { return b.score - a.score; });
    return {
      version: VERSION,
      statementCount: stmts.length,
      families: families,
      warnings: stmts.filter(function (s) { return s.dynamicKey; }).length
        ? ['存在动态 key 的语句，未纳入自动扫描']
        : []
    };
  }

  /* ------------------------------------------------------------------ */
  /* 描述符                                                              */
  /* ------------------------------------------------------------------ */

  function validateSource(src, path) {
    var errors = [];
    if (!src || typeof src !== 'object') {
      errors.push(path + ' 缺少 source');
      return errors;
    }
    var k = src.kind;
    if (k === 'array') {
      if (!src.name || typeof src.name !== 'string') errors.push(path + '.name 必须是数组名');
      if (src.path != null && !Array.isArray(src.path)) errors.push(path + '.path 必须是数组');
    } else if (k === 'helperArg') {
      if (!src.helper || typeof src.helper !== 'string') errors.push(path + '.helper 必须是 helper 名');
      if (!Number.isInteger(src.arg) || src.arg < 1) errors.push(path + '.arg 必须是 >=1 的整数');
    } else if (k === 'block') {
      if (!src.name || typeof src.name !== 'string') errors.push(path + '.name 必须是数组名');
    } else if (k === 'literal') {
      if (src.value == null) errors.push(path + '.value 不能为空');
    } else if (k === 'manual') {
      if (!src.name || typeof src.name !== 'string') errors.push(path + '.name 必须是标记名');
    } else {
      errors.push(path + '.kind 不支持：' + k);
    }
    return errors;
  }

  function validateDescriptor(desc) {
    var errors = [];
    if (!desc || typeof desc !== 'object') return { ok: false, errors: ['描述符必须是对象'], descriptor: null };
    if (desc.version != null && desc.version !== VERSION) {
      errors.push('描述符版本不支持：' + desc.version);
    }
    var d = clone(desc);
    d.version = VERSION;
    d.id = d.id || 'table';
    d.label = d.label || d.id;
    d.scope = d.scope || {};
    if (!Array.isArray(d.scope.locations) || d.scope.locations.length === 0) d.scope.locations = ['*'];
    d.records = d.records || { kind: 'keyed' };
    if (d.records.kind !== 'keyed') errors.push('records.kind 目前仅支持 keyed');
    if (d.records.sources != null) {
      if (!Array.isArray(d.records.sources)) errors.push('records.sources 必须是数组');
      else d.records.sources.forEach(function (s, i) {
        if (!s || (s.kind !== 'array' && s.kind !== 'helper')) errors.push('records.sources[' + i + '] 类型不支持');
        else if (!s.name) errors.push('records.sources[' + i + '].name 不能为空');
      });
    }
    if (d.records.keys != null) {
      if (!Array.isArray(d.records.keys)) errors.push('records.keys 必须是数组');
      else d.records.keys = d.records.keys.map(String);
    }
    if (d.manual != null && (typeof d.manual !== 'object' || Array.isArray(d.manual))) {
      errors.push('manual 必须是对象');
    }
    if (!Array.isArray(d.fields) || d.fields.length === 0) {
      errors.push('至少需要一个字段');
    } else {
      var seen = {};
      d.fields.forEach(function (f, i) {
        var p = 'fields[' + i + ']';
        if (!f || typeof f !== 'object') { errors.push(p + ' 必须是对象'); return; }
        if (!f.key || typeof f.key !== 'string') errors.push(p + '.key 不能为空');
        else if (seen[f.key]) errors.push(p + '.key 重复：' + f.key);
        else seen[f.key] = true;
        if (!f.label) f.label = f.key;
        f.type = f.type || 'text';
        if (['text', 'number', 'code', 'boolean'].indexOf(f.type) < 0) errors.push(p + '.type 不支持：' + f.type);
        errors = errors.concat(validateSource(f.source, p + '.source'));
      });
    }
    return { ok: errors.length === 0, errors: errors, descriptor: errors.length ? null : d };
  }

  function addField(desc, field) {
    var d = clone(desc);
    d.fields = d.fields || [];
    d.fields.push(clone(field));
    return validateDescriptor(d);
  }

  function removeField(desc, key) {
    var d = clone(desc);
    d.fields = (d.fields || []).filter(function (f) { return f.key !== key; });
    return validateDescriptor(d);
  }

  /* ------------------------------------------------------------------ */
  /* 建表                                                                */
  /* ------------------------------------------------------------------ */

  function indexForTable(stmts) {
    var arrays = {};   // base \0 path \0 key -> [stmt]
    var helpers = {};  // helper \0 key -> [stmt]
    var allKeys = {};
    var keyOrder = [];
    var i;
    function addKey(k) {
      if (k == null) return;
      if (!allKeys[k]) { allKeys[k] = true; keyOrder.push(k); }
    }
    for (i = 0; i < stmts.length; i++) {
      var p = stmts[i];
      if (p.key == null) continue;
      addKey(p.key);
      if (p.kind === 'array') {
        var ak = p.base + '\u0000' + p.path.join('\u0000') + '\u0000' + p.key;
        (arrays[ak] || (arrays[ak] = [])).push(p);
      } else {
        var hk = p.helper + '\u0000' + p.key;
        (helpers[hk] || (helpers[hk] = [])).push(p);
      }
    }
    return { arrays: arrays, helpers: helpers, allKeys: allKeys, keyOrder: keyOrder };
  }

  function pickLast(list) {
    return list && list.length ? list[list.length - 1] : null;
  }

  function extractField(field, key, idx, manual) {
    var src = field.source;
    var p, value, raw, flags = [], alternatives = [];
    if (src.kind === 'manual') {
      var bucket = manual && manual[src.name];
      value = bucket && Object.prototype.hasOwnProperty.call(bucket, key) ? bucket[key] : '';
      return { value: value, raw: value, missing: value === '', flags: flags };
    }
    if (src.kind === 'array' || src.kind === 'block') {
      var path = Array.isArray(src.path) ? src.path.map(String) : [];
      var mapKey = src.name + '\u0000' + path.join('\u0000') + '\u0000' + key;
      p = pickLast(idx.arrays[mapKey]);
      if (!p) return { value: '', raw: '', missing: true, flags: flags };
      if (src.kind === 'block') {
        value = p.rhs;
        raw = p.rhs;
        if (!/^\s*\{/.test(value)) flags.push('not-block');
      } else {
        value = p.value.ok ? p.value.value : p.rhs;
        raw = p.rhs;
      }
      var list = idx.arrays[mapKey];
      for (var i = 0; i < list.length; i++) {
        var v = list[i].value.ok ? list[i].value.value : list[i].rhs;
        if (String(v) !== String(value)) alternatives.push(v);
      }
    } else if (src.kind === 'helperArg') {
      p = pickLast(idx.helpers[src.helper + '\u0000' + key]);
      if (!p) return { value: '', raw: '', missing: true, flags: flags };
      var arg = p.args[src.arg - 1];
      if (arg == null) return { value: '', raw: '', missing: true, flags: flags };
      var av = literalValue(arg);
      value = av.ok ? av.value : arg;
      raw = arg;
      var hlist = idx.helpers[src.helper + '\u0000' + key];
      for (var j = 0; j < hlist.length; j++) {
        var hv = literalValue(hlist[j].args[src.arg - 1]);
        var vv = hv.ok ? hv.value : hlist[j].args[src.arg - 1];
        if (String(vv) !== String(value)) alternatives.push(vv);
      }
    } else if (src.kind === 'literal') {
      value = src.value; raw = String(src.value);
    } else {
      return { value: '', raw: '', missing: true, flags: ['unknown-source'] };
    }
    if (alternatives.length) flags.push('conflict');
    return {
      value: value,
      raw: raw,
      missing: false,
      flags: flags,
      alternatives: alternatives.length ? alternatives : undefined,
      source: p ? { location: p.location, start: p.start, end: p.end } : undefined
    };
  }

  function buildTable(game, descriptor, opts) {
    opts = opts || {};
    var v = validateDescriptor(descriptor);
    if (!v.ok) return { ok: false, errors: v.errors, columns: [], rows: [] };
    var d = v.descriptor;
    var stmts = indexGame(game, d.scope);
    var idx = indexForTable(stmts);
    var keys = [];
    var keySeen = {};
    function addKey(k) {
      if (k == null || keySeen[k]) return;
      keySeen[k] = true; keys.push(k);
    }
    if (Array.isArray(d.records.keys) && d.records.keys.length) {
      d.records.keys.forEach(addKey);
    } else if (Array.isArray(d.records.sources) && d.records.sources.length) {
      d.records.sources.forEach(function (s) {
        for (var i = 0; i < stmts.length; i++) {
          var p = stmts[i];
          if (p.key == null) continue;
          if (s.kind === 'array' && p.kind === 'array' && p.base === s.name) addKey(p.key);
          if (s.kind === 'helper' && p.kind === 'helper' && p.helper === s.name) addKey(p.key);
        }
      });
    } else {
      idx.keyOrder.forEach(addKey);
    }

    // 按首次出现顺序排序
    var firstOrder = {};
    for (var i = 0; i < stmts.length; i++) {
      if (stmts[i].key != null && firstOrder[stmts[i].key] == null) firstOrder[stmts[i].key] = stmts[i].order;
    }
    keys.sort(function (a, b) {
      var oa = firstOrder[a] == null ? 1e15 : firstOrder[a];
      var ob = firstOrder[b] == null ? 1e15 : firstOrder[b];
      return oa - ob;
    });

    var columns = d.fields.map(function (f) {
      return { key: f.key, label: f.label, type: f.type, readOnly: !!f.readOnly, source: f.source };
    });
    var rows = [];
    var warnings = [];
    var missingCount = {}, conflictCount = {};
    keys.forEach(function (k) {
      var values = {}, raws = {}, flags = {}, sources = {}, alternatives = {};
      d.fields.forEach(function (f) {
        var r = extractField(f, k, idx, d.manual);
        values[f.key] = r.value;
        raws[f.key] = r.raw;
        flags[f.key] = r.flags;
        if (r.source) sources[f.key] = r.source;
        if (r.missing) missingCount[f.key] = (missingCount[f.key] || 0) + 1;
        if (r.flags.indexOf('conflict') >= 0) {
          conflictCount[f.key] = (conflictCount[f.key] || 0) + 1;
          alternatives[f.key] = r.alternatives;
        }
      });
      rows.push({ id: k, values: values, raw: raws, flags: flags, sources: sources, alternatives: alternatives });
    });

    d.fields.forEach(function (f) {
      if (missingCount[f.key]) warnings.push(f.label + '：' + missingCount[f.key] + ' 条记录缺失');
      if (conflictCount[f.key]) warnings.push(f.label + '：' + conflictCount[f.key] + ' 条记录存在冲突值');
    });

    return {
      ok: true,
      descriptor: d,
      columns: columns,
      rows: rows,
      stats: {
        records: rows.length,
        fields: columns.length,
        locations: d.scope.locations,
        statementCount: stmts.length,
        missing: missingCount,
        conflicts: conflictCount
      },
      warnings: warnings
    };
  }

  /* ------------------------------------------------------------------ */
  /* CSV                                                                 */
  /* ------------------------------------------------------------------ */

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function tableToCSV(table, opts) {
    opts = opts || {};
    var lines = [];
    var head = ['id'];
    table.columns.forEach(function (c) { head.push(c.label); });
    lines.push(head.map(csvCell).join(','));
    table.rows.forEach(function (r) {
      var line = [csvCell(r.id)];
      table.columns.forEach(function (c) { line.push(csvCell(r.values[c.key])); });
      lines.push(line.join(','));
    });
    return (opts.bom === false ? '' : '\uFEFF') + lines.join('\r\n') + '\r\n';
  }

  return {
    version: VERSION,
    scan: scan,
    buildTable: buildTable,
    validateDescriptor: validateDescriptor,
    addField: addField,
    removeField: removeField,
    tableToCSV: tableToCSV,
    // 暴露给测试/高级 UI
    _internals: {
      splitStatements: splitStatements,
      stripComments: stripComments,
      splitArgs: splitArgs,
      parseStatement: parseStatement,
      indexGame: indexGame,
      literalValue: literalValue
    }
  };
});
