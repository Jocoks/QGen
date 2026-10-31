/*!
 * syntax.js — QSP 代码语法高亮 + 查找命中标记
 * 纯函数：tokenize() 得到词法片段，render() 输出 HTML（可选 mark 命中区间）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QSPHL = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KEYWORDS = ('if elseif else end act goto gosub gt gs jump clr cls cla killall killvar ' +
    'addobj delobj addloc delloc loc obj xgt xnl scanstr dynamic nvar nl pl pnl print msg ' +
    'input wait menu exit loop unloop func setvar getvar inc dec copyarr sortarr flushobj ' +
    'clearscreen show desc set_counter err def return local global and or not xor mod').split(' ');
  var KW = Object.create(null);
  for (var i = 0; i < KEYWORDS.length; i++) KW[KEYWORDS[i]] = 1;

  // 控制流 / 逻辑词 / 常量单独着色，避免所有关键字挤在同一种棕色里
  var CONTROL = Object.create(null);
  ('if elseif else end act goto gosub gt gs jump exit loop unloop func return local global')
    .split(' ').forEach(function (w) { CONTROL[w] = 1; });
  var LOGICAL = Object.create(null);
  ('and or not xor mod').split(' ').forEach(function (w) { LOGICAL[w] = 1; });
  var CONST = Object.create(null);
  ('true false null').split(' ').forEach(function (w) { CONST[w] = 1; });

  var OPS = '+-*/=<>!&.,:;()[]{}';

  function esc(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 38) out += '&amp;';
      else if (c === 60) out += '&lt;';
      else if (c === 62) out += '&gt;';
      else out += s[i];
    }
    return out;
  }
  function isDigit(c) { return c >= 48 && c <= 57; }
  function isWord(c) {
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c === 35;
  }
  function opClass(ch) {
    if ('<>=!'.indexOf(ch) >= 0) return 'oc';       // 比较 / 逻辑
    if ('+-*/'.indexOf(ch) >= 0) return 'oa';       // 算术
    return 'op';                                     // 标点、分隔符
  }

  /** 词法切片：返回 [{s,e,cls}]，按源码顺序且互不重叠；未覆盖的字符是普通文本 */
  function tokenize(src) {
    var toks = [];
    var n = src.length, i = 0, lineStart = true;
    while (i < n) {
      var c = src.charCodeAt(i);
      if (c === 33 && lineStart) {                     // ! 行注释
        var j = src.indexOf('\n', i);
        if (j < 0) j = n;
        toks.push({ s: i, e: j, cls: 'cm' });
        i = j;
        continue;
      }
      if (c === 39) {                                  // '字符串'
        var k = i + 1;
        while (k < n) {
          if (src.charCodeAt(k) === 39) {
            if (k + 1 < n && src.charCodeAt(k + 1) === 39) { k += 2; continue; }
            k++;
            break;
          }
          k++;
        }
        toks.push({ s: i, e: k, cls: 'st' });
        i = k; lineStart = false;
        continue;
      }
      if (isDigit(c) || (c === 45 && i + 1 < n && isDigit(src.charCodeAt(i + 1)) &&
          (i === 0 || !isWord(src.charCodeAt(i - 1))))) {  // 数字
        var m = i;
        if (c === 45) m++;
        while (m < n && (isDigit(src.charCodeAt(m)) || src.charCodeAt(m) === 46)) m++;
        toks.push({ s: i, e: m, cls: 'nu' });
        i = m; lineStart = false;
        continue;
      }
      if (isWord(c)) {                                 // 标识符 / $变量
        var e = i + 1;
        while (e < n && isWord(src.charCodeAt(e))) e++;
        var w = src.slice(i, e), low = w.toLowerCase();
        var cls = null;
        if (KW[low]) cls = CONTROL[low] ? 'kc' : (LOGICAL[low] ? 'ko' : 'kf');
        else if (CONST[low]) cls = 'cn';
        else if (w.charCodeAt(0) === 36) cls = 'vr';
        else if (w.charCodeAt(0) === 35) cls = 'lc';
        if (cls) toks.push({ s: i, e: e, cls: cls });
        i = e; lineStart = false;
        continue;
      }
      if (OPS.indexOf(src[i]) >= 0) {                  // 运算符（按类别连续合并）
        var ocls = opClass(src[i]);
        var p = i + 1;
        while (p < n && OPS.indexOf(src[p]) >= 0 && opClass(src[p]) === ocls) p++;
        toks.push({ s: i, e: p, cls: ocls });
        i = p; lineStart = false;
        continue;
      }
      if (c === 10) lineStart = true;
      else if (c !== 32 && c !== 9 && c !== 13) lineStart = false;
      i++;
    }
    return toks;
  }

  /**
   * @param {string} src
   * @param {Array<{s:number,e:number,cur:boolean}>} [marks] 查找命中区间（有序、不重叠）
   */
  function highlight(src, marks) {
    var toks = tokenize(src);
    var out = [];
    var mptr = 0;
    var useMarks = marks && marks.length;

    function pushText(a, b, cls) {
      if (b <= a) return;
      var t = esc(src.slice(a, b));
      out.push(cls ? '<span class="' + cls + '">' + t + '</span>' : t);
    }
    function pushMark(a, b, cls, cur) {
      if (b <= a) return;
      var t = esc(src.slice(a, b));
      var inner = cls ? '<span class="' + cls + '">' + t + '</span>' : t;
      out.push('<mark class="' + (cur ? 'fc' : 'fh') + '">' + inner + '</mark>');
    }

    function emit(a, b, cls) {
      if (!useMarks) { pushText(a, b, cls); return; }
      var pos = a;
      while (mptr < marks.length && marks[mptr].e <= pos) mptr++;
      var k = mptr;
      while (k < marks.length && marks[k].s < b) {
        var mk = marks[k];
        var ms = Math.max(mk.s, pos), me = Math.min(mk.e, b);
        if (ms > pos) pushText(pos, ms, cls);
        if (me > ms) pushMark(ms, me, cls, mk.cur);
        pos = me;
        if (mk.e > b) break;
        k++;
      }
      if (pos < b) pushText(pos, b, cls);
      mptr = (k < marks.length && marks[k].e > b) ? k : k + 1;
    }

    // 按 token 顺序输出，未覆盖处为普通文本
    var cursor = 0;
    for (var t = 0; t < toks.length; t++) {
      var tok = toks[t];
      if (tok.s > cursor) emit(cursor, tok.s, null);
      emit(tok.s, tok.e, tok.cls);
      cursor = tok.e;
    }
    if (cursor < src.length) emit(cursor, src.length, null);
    return out.join('');
  }

  return { highlight: highlight, tokenize: tokenize, esc: esc };
});
