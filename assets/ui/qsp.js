/*!
 * qsp.js — QSP 游戏文件（.qsp）读写核心
 * ------------------------------------------------------------------
 * 格式依据开源项目 QGen 4.3（github.com/QSPFoundation/qgen）的 game.cpp：
 *
 *   QSPGAME\r\n              文件标识（不编码）
 *   <日期/版本>\r\n         不在编码区（不编码）
 *   <密码>\r\n              编码（默认 "No"）
 *   <位置数>\r\n            编码
 *   for each location:
 *     <名称>\r\n            编码
 *     <描述>\r\n            编码
 *     <代码>\r\n            编码
 *     <动作数>\r\n          编码
 *     for each action:
 *       <图片路径>\r\n      编码
 *       <动作名>\r\n        编码
 *       <动作代码>\r\n      编码
 *
 * 编码规则：UCS-2LE（UTF-16LE 码元），每个码元 v 加密为 v-5；
 * 若原字符为 5，则写成 0xFFFB（-5），避免产生 0 终止符。
 * 文本中的换行在文件里用 \r\n 表示。
 *
 * 本文件同时支持浏览器（window.QSP）与 Node（module.exports）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.QSP = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COD = 5;
  var MAGIC = 'QSPGAME';
  var MAX_ACTIONS = 50; // QGEN_MAXACTIONS

  /* ---------- 基础编解码 ---------- */

  function unitsToString(units) {
    var n = units.length;
    if (n === 0) return '';
    if (UnitString) {
      try { return UnitString(units); } catch (e) { /* fallthrough */ }
    }
    var parts = [];
    var CH = 8192;
    for (var i = 0; i < n; i += CH) {
      parts.push(String.fromCharCode.apply(null, units.subarray(i, Math.min(i + CH, n))));
    }
    return parts.join('');
  }
  // 大文件时优先用 TextDecoder（Uint16 输入不走 UTF-8 解码，而是直接拷贝码元）
  var UnitString = null;

  function decodeStr(u8, coded) {
    var n = u8.length >> 1;
    var units = new Uint16Array(n);
    var i, v;
    if (coded) {
      for (i = 0; i < n; i++) {
        v = u8[i * 2] | (u8[(i * 2) + 1] << 8);
        units[i] = (v === 0xFFFB) ? 5 : ((v + 5) & 0xFFFF);
      }
    } else {
      for (i = 0; i < n; i++) {
        units[i] = u8[i * 2] | (u8[(i * 2) + 1] << 8);
      }
    }
    return unitsToString(units);
  }

  function encodeStr(str, coded) {
    var n = str.length;
    var u8 = new Uint8Array(n * 2);
    var i, c;
    if (coded) {
      for (i = 0; i < n; i++) {
        c = str.charCodeAt(i);
        c = (c === COD) ? 0xFFFB : ((c - COD) & 0xFFFF);
        u8[i * 2] = c & 0xFF;
        u8[(i * 2) + 1] = c >>> 8;
      }
    } else {
      for (i = 0; i < n; i++) {
        c = str.charCodeAt(i);
        u8[i * 2] = c & 0xFF;
        u8[(i * 2) + 1] = c >>> 8;
      }
    }
    return u8;
  }

  /* ---------- 分割 / 拼接 ---------- */

  function splitParts(u8) {
    var parts = [];
    var start = 0;
    var len = u8.length;
    for (var i = 0; i + 3 < len; i++) {
      if (u8[i] === 0x0D && u8[i + 1] === 0 && u8[i + 2] === 0x0A && u8[i + 3] === 0) {
        parts.push(u8.subarray(start, i));
        i += 3;
        start = i + 1;
      }
    }
    parts.push(u8.subarray(start));
    return parts;
  }

  function concat(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (i = 0; i < list.length; i++) {
      out.set(list[i], off);
      off += list[i].length;
    }
    return out;
  }

  var DELIM = new Uint8Array([0x0D, 0x00, 0x0A, 0x00]);

  function nlOut(s) { return s.split('\n').join('\r\n'); }
  function nlIn(s) { return s.split('\r\n').join('\n'); }

  /* ---------- 读取 ---------- */

  function toU8(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes && bytes.buffer instanceof ArrayBuffer) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return new Uint8Array(bytes);
  }

  function parse(bytes) {
    var u8 = toU8(bytes);
    if (u8.length < 16) throw new QspError('文件太小，不是有效的 QSP 游戏文件');
    if (u8[1] !== 0) throw new QspError('暂不支持该编码的 QSP 文件（非 UCS-2LE）');
    var parts = splitParts(u8);
    var head = decodeStr(parts[0], false);
    if (head !== MAGIC) {
      throw new QspError('没有找到 QSPGAME 文件头，可能不是 .qsp 文件，或为旧版格式（QGen 4 之前的 .gam）');
    }
    if (parts.length < 5) throw new QspError('QSP 文件头不完整，文件可能已损坏');
    var game = {
      magic: MAGIC,
      date: decodeStr(parts[1], false),
      password: decodeStr(parts[2], true),
      locations: [],
      // 以下为只读统计信息
      stats: { bytes: u8.length }
    };
    var idx = 3;
    var locCount = parseInt(decodeStr(parts[idx++], true), 10);
    if (!(locCount >= 0)) throw new QspError('位置数量无效，文件可能已损坏');
    if (locCount > 100000) throw new QspError('位置数量异常（' + locCount + '），文件可能已损坏');
    for (var i = 0; i < locCount; i++) {
      if (idx + 4 > parts.length) throw new QspError('文件在位置 #' + (i + 1) + ' 处意外结束');
      var loc = {
        name: nlIn(decodeStr(parts[idx++], true)),
        desc: nlIn(decodeStr(parts[idx++], true)),
        code: nlIn(decodeStr(parts[idx++], true)),
        actions: []
      };
      var actCount = parseInt(decodeStr(parts[idx++], true), 10);
      if (!(actCount >= 0)) actCount = 0;
      if (actCount > MAX_ACTIONS) throw new QspError('位置 "' + loc.name + '" 的动作数量超出限制（' + actCount + ' > ' + MAX_ACTIONS + '）');
      for (var j = 0; j < actCount; j++) {
        if (idx + 3 > parts.length) throw new QspError('文件在位置 "' + loc.name + '" 的动作处意外结束');
        loc.actions.push({
          pict: nlIn(decodeStr(parts[idx++], true)),
          name: nlIn(decodeStr(parts[idx++], true)),
          code: nlIn(decodeStr(parts[idx++], true))
        });
      }
      game.locations.push(loc);
    }
    game.stats.locations = game.locations.length;
    game.stats.actions = game.locations.reduce(function (a, l) { return a + l.actions.length; }, 0);
    return game;
  }

  /* ---------- 写入 ---------- */

  function serialize(game) {
    var out = [];
    var push = function (s, coded) { out.push(encodeStr(s, coded), DELIM); };
    push(MAGIC, false);
    push(game.date || '', false);
    push(game.password == null ? 'No' : String(game.password), true);
    push(String(game.locations.length), true);
    for (var i = 0; i < game.locations.length; i++) {
      var loc = game.locations[i];
      push(nlOut(loc.name || ''), true);
      push(nlOut(loc.desc || ''), true);
      push(nlOut(loc.code || ''), true);
      var acts = loc.actions || [];
      push(String(acts.length), true);
      for (var j = 0; j < acts.length; j++) {
        var a = acts[j];
        push(nlOut(a.pict || ''), true);
        push(nlOut(a.name || ''), true);
        push(nlOut(a.code || ''), true);
      }
    }
    return concat(out);
  }

  /* ---------- 辅助 ---------- */

  function QspError(msg) {
    var e = new Error(msg);
    e.name = 'QspError';
    return e;
  }

  function newGame() {
    var d = new Date();
    var p = function (x) { return x < 10 ? '0' + x : '' + x; };
    var stamp = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    return {
      magic: MAGIC,
      date: stamp + ' (QGen Android 1.0.0)',
      password: 'No',
      locations: [{ name: 'Start', desc: '', code: '', actions: [] }],
      stats: { locations: 1, actions: 0, bytes: 0 }
    };
  }

  function stats(game) {
    var chars = 0, codeChars = 0, actions = 0;
    for (var i = 0; i < game.locations.length; i++) {
      var l = game.locations[i];
      chars += (l.desc || '').length;
      codeChars += (l.code || '').length;
      actions += (l.actions || []).length;
      for (var j = 0; j < (l.actions || []).length; j++) codeChars += (l.actions[j].code || '').length;
    }
    return { locations: game.locations.length, actions: actions, descChars: chars, codeChars: codeChars };
  }

  return {
    parse: parse,
    serialize: serialize,
    newGame: newGame,
    stats: stats,
    QspError: QspError,
    // 供测试使用
    _encodeStr: encodeStr,
    _decodeStr: decodeStr
  };
});
