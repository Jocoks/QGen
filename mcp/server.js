#!/usr/bin/env node
/**
 * qsp-mcp —— 给 QGen Android 用的本地 MCP 服务（stdio）
 *
 * 让 AI 能直接「查找 / 阅读 / 修改」.qsp 游戏文件：
 *   - 读取：概览、位置列表、位置详情、全文搜索（带命中次数与上下文行）
 *   - 修改：整段替换、查找替换（单点/全部/正则）、增删位置、增删改动作
 *   - 安全：写入前备份 .bak、临时文件原子替换、写完重新解析校验
 *
 * 用法（在 dsh 的 MCP 配置里）：
 *   command: node
 *   args:    ["<项目目录>/mcp/server.js"]
 *
 * 协议：JSON-RPC 2.0 / 按行分隔；stdout 只输出协议消息，日志走 stderr。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// 两种部署布局都支持：
//   项目内         mcp/server.js + ../assets/ui/qsp.js
//   APK 内置资源   assets/mcp/server.js + ./qsp.js
const QSP_PATH = fs.existsSync(path.join(__dirname, 'qsp.js'))
  ? path.join(__dirname, 'qsp.js')
  : path.join(__dirname, '..', 'assets', 'ui', 'qsp.js');
const QSP = require(QSP_PATH);

const SERVER_INFO = { name: 'qsp-mcp', version: '1.0.0' };
const DEFAULT_ROOT = '/storage/emulated/0';

/* ------------------------------------------------------------------ */
/* 文件读写                                                            */
/* ------------------------------------------------------------------ */

function resolvePath(p) {
  if (!p || typeof p !== 'string') throw err('缺少文件路径');
  let abs = path.isAbsolute(p) ? p : path.join(DEFAULT_ROOT, p);
  abs = path.normalize(abs);
  return abs;
}

function loadGame(p) {
  const abs = resolvePath(p);
  if (!fs.existsSync(abs)) throw err('文件不存在：' + abs);
  const buf = fs.readFileSync(abs);
  let game;
  try {
    game = QSP.parse(buf);
  } catch (e) {
    throw err('不是有效的 QSP 文件（' + abs + '）：' + e.message);
  }
  return { abs, game, size: buf.length, md5: crypto.createHash('md5').update(buf).digest('hex') };
}

function saveGame(abs, game, opts) {
  const bytes = QSP.serialize(game);
  // 重新解析校验，避免写坏
  const check = QSP.parse(bytes);
  if (check.locations.length !== game.locations.length) {
    throw err('内部错误：序列化后位置数量不一致，已放弃写入');
  }
  if (opts && opts.dryRun) {
    return { dryRun: true, size: bytes.length, md5: crypto.createHash('md5').update(bytes).digest('hex') };
  }
  const bak = abs + '.bak';
  try { fs.copyFileSync(abs, bak); } catch (e) { /* 忽略备份失败 */ }
  const tmp = abs + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, bytes);
  try {
    fs.renameSync(tmp, abs);
  } catch (e) {
    fs.writeFileSync(abs, bytes);
    try { fs.unlinkSync(tmp); } catch (e2) { }
  }
  const newBuf = fs.readFileSync(abs);
  return {
    size: newBuf.length,
    md5: crypto.createHash('md5').update(newBuf).digest('hex'),
    backup: bak,
    locations: check.locations.length
  };
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function err(message) {
  const e = new Error(message);
  e.isToolError = true;
  return e;
}

function findLocation(game, ref) {
  if (ref == null) throw err('缺少位置名或序号');
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const i = Number(ref);
    if (i < 0 || i >= game.locations.length) throw err('位置序号越界：' + i);
    return i;
  }
  const name = String(ref);
  for (let i = 0; i < game.locations.length; i++) {
    if (game.locations[i].name === name) return i;
  }
  // 宽松匹配：忽略大小写
  const low = name.toLowerCase();
  for (let i = 0; i < game.locations.length; i++) {
    if ((game.locations[i].name || '').toLowerCase() === low) return i;
  }
  const names = game.locations.slice(0, 40).map(l => l.name);
  throw err('找不到位置「' + name + '」。前 40 个位置：' + names.join(', '));
}

function countOccurrences(hay, needle) {
  let n = 0, from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    n++;
    from = at + needle.length;
  }
  return n;
}

/** 取匹配所在行 + 上下文（默认前后 40 字），用于搜索展示 */
function lineSnippet(text, at, len, ctx) {
  ctx = ctx == null ? 40 : ctx;
  const ls = text.lastIndexOf('\n', at - 1) + 1;
  let le = text.indexOf('\n', at + len);
  if (le < 0) le = text.length;
  const line = text.slice(ls, le);
  const col = at - ls;
  const a = Math.max(0, col - ctx);
  const b = Math.min(line.length, col + len + ctx);
  const lineNo = text.slice(0, at).split('\n').length;
  return {
    line: lineNo,
    snippet: (a > 0 ? '…' : '') + line.slice(a, col) + '⟦' + line.slice(col, col + len) + '⟧' +
      line.slice(col + len, b) + (b < line.length ? '…' : '')
  };
}

function fieldList(game, loc) {
  const fields = [
    { field: 'name', label: '名称', text: loc.name || '' },
    { field: 'desc', label: '描述', text: loc.desc || '' },
    { field: 'code', label: '代码', text: loc.code || '' }
  ];
  (loc.actions || []).forEach((a, i) => {
    fields.push({ field: 'action:' + i + ':name', label: '动作[' + i + ']名', text: a.name || '' });
    fields.push({ field: 'action:' + i + ':code', label: '动作[' + i + ']代码', text: a.code || '' });
    fields.push({ field: 'action:' + i + ':pict', label: '动作[' + i + ']图片', text: a.pict || '' });
  });
  return fields;
}

/** 依据 field 标识取出/写回文本 */
function getField(loc, field) {
  switch (field) {
    case 'name': return loc.name || '';
    case 'desc': return loc.desc || '';
    case 'code': return loc.code || '';
  }
  const m = /^action:(\d+):(name|code|pict)$/.exec(field);
  if (m) {
    const a = loc.actions[Number(m[1])];
    if (!a) throw err('动作序号不存在：' + m[1]);
    return a[m[2]] || '';
  }
  throw err('未知字段：' + field + '（可用：name / desc / code / action:<序号>:name|code|pict）');
}

function setField(loc, field, value) {
  switch (field) {
    case 'name': loc.name = value; return;
    case 'desc': loc.desc = value; return;
    case 'code': loc.code = value; return;
  }
  const m = /^action:(\d+):(name|code|pict)$/.exec(field);
  if (m) {
    const a = loc.actions[Number(m[1])];
    if (!a) throw err('动作序号不存在：' + m[1]);
    a[m[2]] = value;
    return;
  }
  throw err('未知字段：' + field);
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

const TOOLS = {};

TOOLS.qsp_info = {
  description: '查看 .qsp 文件概要：大小、位置数、动作数、密码、文件头、md5。',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: '文件路径（绝对路径，或相对 /storage/emulated/0）' } },
    required: ['path']
  },
  handler: (args) => {
    const { abs, game, size, md5 } = loadGame(args.path);
    return {
      path: abs,
      size,
      md5,
      header: game.date,
      password: game.password,
      locations: game.locations.length,
      actions: game.locations.reduce((n, l) => n + (l.actions || []).length, 0),
      codeChars: game.locations.reduce((n, l) => n + (l.code || '').length, 0),
      descChars: game.locations.reduce((n, l) => n + (l.desc || '').length, 0)
    };
  }
};

TOOLS.qsp_list_locations = {
  description: '列出所有位置（序号、名称、描述/代码字数、动作数），可按名称过滤。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      filter: { type: 'string', description: '只返回名称包含该串的位置（不区分大小写）' }
    },
    required: ['path']
  },
  handler: (args) => {
    const { game } = loadGame(args.path);
    const f = (args.filter || '').toLowerCase();
    const out = [];
    game.locations.forEach((l, i) => {
      if (f && (l.name || '').toLowerCase().indexOf(f) < 0) return;
      out.push({
        index: i,
        name: l.name,
        descChars: (l.desc || '').length,
        codeChars: (l.code || '').length,
        actions: (l.actions || []).length
      });
    });
    return { total: game.locations.length, matched: out.length, locations: out };
  }
};

TOOLS.qsp_get_location = {
  description: '读取一个位置的完整内容（描述、代码、动作列表）。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      location: { type: ['string', 'number'], description: '位置名或序号' },
      includeActions: { type: 'boolean', description: '是否包含动作代码，默认 true' }
    },
    required: ['path', 'location']
  },
  handler: (args) => {
    const { game } = loadGame(args.path);
    const i = findLocation(game, args.location);
    const l = game.locations[i];
    const res = { index: i, name: l.name, desc: l.desc, code: l.code };
    if (args.includeActions !== false) {
      res.actions = (l.actions || []).map((a, k) => ({ index: k, name: a.name, pict: a.pict, code: a.code }));
    } else {
      res.actionCount = (l.actions || []).length;
    }
    return res;
  }
};

TOOLS.qsp_search = {
  description: '全文搜索（名称/描述/代码/动作），返回每个位置的命中次数与上下文行片段。支持正则。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      query: { type: 'string', description: '要查找的文本；regex=true 时按正则' },
      regex: { type: 'boolean', description: '按正则表达式（默认 false，纯文本、不区分大小写）' },
      context: { type: 'number', description: '片段中关键字前后保留的字数，默认 40' },
      snippetsPerLocation: { type: 'number', description: '每个位置最多返回几条片段，默认 3' },
      limit: { type: 'number', description: '最多返回多少个位置，默认 50' }
    },
    required: ['path', 'query']
  },
  handler: (args) => {
    const { game } = loadGame(args.path);
    const q = args.query == null ? '' : String(args.query);
    if (!q) throw err('query 不能为空');
    let re = null;
    if (args.regex) {
      try { re = new RegExp(q, 'g'); } catch (e) { throw err('正则无效：' + e.message); }
    }
    const ctx = args.context == null ? 40 : args.context;
    const perLoc = args.snippetsPerLocation == null ? 3 : args.snippetsPerLocation;
    const limit = args.limit == null ? 50 : args.limit;
    const results = [];
    let totalHits = 0;

    for (let i = 0; i < game.locations.length; i++) {
      const loc = game.locations[i];
      const fields = fieldList(game, loc);
      let hits = 0;
      const byField = {};
      const snippets = [];
      for (const f of fields) {
        const text = f.text;
        if (!text) continue;
        if (re) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(text)) !== null) {
            hits++;
            byField[f.field] = (byField[f.field] || 0) + 1;
            if (snippets.length < perLoc) snippets.push(Object.assign({ field: f.field, label: f.label },
              lineSnippet(text, m.index, m[0].length, ctx)));
            if (m[0].length === 0) re.lastIndex++;
            if (hits > 100000) break;
          }
        } else {
          const hay = text.toLowerCase(), needle = q.toLowerCase();
          let from = 0, at;
          while ((at = hay.indexOf(needle, from)) >= 0) {
            hits++;
            byField[f.field] = (byField[f.field] || 0) + 1;
            if (snippets.length < perLoc) snippets.push(Object.assign({ field: f.field, label: f.label },
              lineSnippet(text, at, needle.length, ctx)));
            from = at + needle.length;
          }
        }
      }
      if (hits) {
        totalHits += hits;
        results.push({ index: i, name: loc.name, hits, byField, snippets });
      }
    }
    results.sort((a, b) => b.hits - a.hits);
    return {
      query: q,
      regex: !!args.regex,
      matchedLocations: results.length,
      totalHits,
      locations: results.slice(0, limit)
    };
  }
};

TOOLS.qsp_set_location = {
  description: '整体替换一个位置的描述/代码（不传的字段保持不变）。写入前自动备份为 .bak。',
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
  handler: (args) => {
    const { abs, game } = loadGame(args.path);
    const i = findLocation(game, args.location);
    const l = game.locations[i];
    const before = { desc: (l.desc || '').length, code: (l.code || '').length };
    if (args.desc != null) l.desc = String(args.desc);
    if (args.code != null) l.code = String(args.code);
    const w = saveGame(abs, game, { dryRun: args.dryRun });
    return Object.assign({ location: l.name, before, after: { desc: l.desc.length, code: l.code.length } }, w);
  }
};

TOOLS.qsp_replace = {
  description: '在某个位置的指定字段里做查找替换（默认只替换第一处；all=true 替换全部；支持正则与捕获组）。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      location: { type: ['string', 'number'] },
      field: { type: 'string', description: 'desc | code | name | action:<序号>:code|name|pict，默认 code' },
      find: { type: 'string' },
      replace: { type: 'string' },
      all: { type: 'boolean', description: '替换全部命中，默认 false（只替换第一处）' },
      regex: { type: 'boolean', description: 'find 按正则，replace 可用 $1' },
      dryRun: { type: 'boolean' }
    },
    required: ['path', 'location', 'find', 'replace']
  },
  handler: (args) => {
    const { abs, game } = loadGame(args.path);
    const i = findLocation(game, args.location);
    const l = game.locations[i];
    const field = args.field || 'code';
    const text = getField(l, field);
    const find = String(args.find);
    let out, count = 0;
    if (args.regex) {
      let re;
      try { re = new RegExp(find, args.all ? 'g' : ''); } catch (e) { throw err('正则无效：' + e.message); }
      out = text.replace(re, () => { count++; return args.replace; });
    } else {
      if (args.all) {
        out = text.split(find).join(args.replace);
        count = countOccurrences(text, find);
      } else {
        const at = text.indexOf(find);
        if (at >= 0) { count = 1; out = text.slice(0, at) + args.replace + text.slice(at + find.length); }
        else out = text;
      }
    }
    if (count === 0) throw err('没找到要替换的内容：' + find);
    setField(l, field, out);
    const w = saveGame(abs, game, { dryRun: args.dryRun });
    return Object.assign({ location: l.name, field, replaced: count }, w);
  }
};

TOOLS.qsp_replace_all = {
  description: '在整个游戏里查找替换（跨所有位置、所有动作），适合批量重构。默认 dryRun=true 只报告不写入。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      find: { type: 'string' },
      replace: { type: 'string' },
      regex: { type: 'boolean' },
      fields: { type: 'string', description: '逗号分隔：name,desc,code,action。默认全部' },
      dryRun: { type: 'boolean', description: '默认 true' }
    },
    required: ['path', 'find', 'replace']
  },
  handler: (args) => {
    const { abs, game } = loadGame(args.path);
    const want = (args.fields ? String(args.fields) : 'name,desc,code,action').split(',').map(s => s.trim());
    const find = String(args.find);
    let re = null;
    if (args.regex) { try { re = new RegExp(find, 'g'); } catch (e) { throw err('正则无效：' + e.message); } }
    let total = 0;
    const touched = [];
    game.locations.forEach((loc, i) => {
      let n = 0;
      const fields = [];
      if (want.indexOf('name') >= 0) fields.push('name');
      if (want.indexOf('desc') >= 0) fields.push('desc');
      if (want.indexOf('code') >= 0) fields.push('code');
      if (want.indexOf('action') >= 0) (loc.actions || []).forEach((a, k) => {
        fields.push('action:' + k + ':name');
        fields.push('action:' + k + ':code');
      });
      fields.forEach(f => {
        const text = getField(loc, f);
        if (!text) return;
        let out;
        if (re) {
          re.lastIndex = 0;
          const before = (String(text).match(re) || []).length;
          if (!before) return;
          re.lastIndex = 0;
          out = text.replace(re, () => { n++; return args.replace; });
        } else {
          const c = countOccurrences(text, find);
          if (!c) return;
          n += c;
          out = text.split(find).join(args.replace);
        }
        setField(loc, f, out);
      });
      if (n) { total += n; touched.push({ index: i, name: loc.name, replaced: n }); }
    });
    if (!total) return { replaced: 0, locations: [], dryRun: args.dryRun !== false };
    const dry = args.dryRun !== false;
    const w = saveGame(abs, game, { dryRun: dry });
    return Object.assign({ replaced: total, locations: touched, dryRun: dry }, w);
  }
};

TOOLS.qsp_add_location = {
  description: '新增一个位置（同名已存在会报错）。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      name: { type: 'string' },
      desc: { type: 'string' },
      code: { type: 'string' },
      index: { type: 'number', description: '插入位置，默认追加到末尾' }
    },
    required: ['path', 'name']
  },
  handler: (args) => {
    const { abs, game } = loadGame(args.path);
    const name = String(args.name);
    if (game.locations.some(l => l.name === name)) throw err('已存在同名位置：' + name);
    const loc = { name, desc: args.desc == null ? '' : String(args.desc), code: args.code == null ? '' : String(args.code), actions: [] };
    if (args.index == null) game.locations.push(loc);
    else game.locations.splice(Math.max(0, Math.min(game.locations.length, Number(args.index))), 0, loc);
    const w = saveGame(abs, game, {});
    return Object.assign({ created: name, total: game.locations.length }, w);
  }
};

TOOLS.qsp_rename_location = {
  description: '重命名一个位置（QSP 里位置名必须唯一）。',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, from: { type: ['string', 'number'] }, to: { type: 'string' } },
    required: ['path', 'from', 'to']
  },
  handler: (args) => {
    const { abs, game } = loadGame(args.path);
    const i = findLocation(game, args.from);
    const to = String(args.to);
    if (game.locations.some((l, k) => k !== i && l.name === to)) throw err('已存在同名位置：' + to);
    const old = game.locations[i].name;
    game.locations[i].name = to;
    const w = saveGame(abs, game, {});
    return Object.assign({ from: old, to }, w);
  }
};

TOOLS.qsp_delete_location = {
  description: '删除一个位置（不可撤销，写入前会生成 .bak）。',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, location: { type: ['string', 'number'] } },
    required: ['path', 'location']
  },
  handler: (args) => {
    const { abs, game } = loadGame(args.path);
    const i = findLocation(game, args.location);
    const name = game.locations[i].name;
    game.locations.splice(i, 1);
    const w = saveGame(abs, game, {});
    return Object.assign({ deleted: name, total: game.locations.length }, w);
  }
};

TOOLS.qsp_action = {
  description: '动作管理：list 列出 / get 读取 / set 新增或修改 / delete 删除。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      location: { type: ['string', 'number'] },
      op: { type: 'string', enum: ['list', 'get', 'set', 'delete'] },
      index: { type: 'number', description: '动作序号（set 修改 / delete 删除时用；set 不带 index 则新增）' },
      name: { type: 'string' },
      pict: { type: 'string', description: '图片路径' },
      code: { type: 'string' }
    },
    required: ['path', 'location', 'op']
  },
  handler: (args) => {
    const { abs, game } = loadGame(args.path);
    const i = findLocation(game, args.location);
    const loc = game.locations[i];
    const op = args.op;
    if (op === 'list') {
      return { location: loc.name, actions: (loc.actions || []).map((a, k) => ({ index: k, name: a.name, pict: a.pict, codeChars: (a.code || '').length })) };
    }
    if (op === 'get') {
      const k = Number(args.index);
      const a = loc.actions[k];
      if (!a) throw err('动作序号不存在：' + args.index);
      return { location: loc.name, index: k, name: a.name, pict: a.pict, code: a.code };
    }
    if (op === 'set') {
      if (args.index == null) {
        loc.actions.push({ name: args.name || '新动作', pict: args.pict || '', code: args.code || '' });
        const w = saveGame(abs, game, {});
        return Object.assign({ added: true, index: loc.actions.length - 1, count: loc.actions.length }, w);
      }
      const k = Number(args.index);
      const a = loc.actions[k];
      if (!a) throw err('动作序号不存在：' + args.index);
      if (args.name != null) a.name = String(args.name);
      if (args.pict != null) a.pict = String(args.pict);
      if (args.code != null) a.code = String(args.code);
      const w = saveGame(abs, game, {});
      return Object.assign({ updated: true, index: k }, w);
    }
    if (op === 'delete') {
      const k = Number(args.index);
      const a = loc.actions[k];
      if (!a) throw err('动作序号不存在：' + args.index);
      loc.actions.splice(k, 1);
      const w = saveGame(abs, game, {});
      return Object.assign({ deleted: a.name, count: loc.actions.length }, w);
    }
    throw err('未知 op：' + op);
  }
};

TOOLS.qsp_create = {
  description: '新建一个空白 .qsp 游戏（含一个 Start 位置），已存在则报错。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      code: { type: 'string', description: 'Start 位置的初始代码' },
      desc: { type: 'string' },
      force: { type: 'boolean', description: '文件已存在时是否覆盖，默认 false' }
    },
    required: ['path']
  },
  handler: (args) => {
    const abs = resolvePath(args.path);
    if (fs.existsSync(abs) && !args.force) throw err('文件已存在：' + abs + '（确认覆盖请传 force=true）');
    const game = QSP.newGame();
    game.locations[0].code = args.code || '';
    game.locations[0].desc = args.desc || '';
    const w = saveGame(abs, game, {});
    return Object.assign({ created: abs, locations: 1 }, w);
  }
};

TOOLS.qsp_validate = {
  description: '校验一个 .qsp 文件能否被正确解析，并报告基本统计（用于改动后自检）。',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  handler: (args) => {
    const { abs, game, size, md5 } = loadGame(args.path);
    const emptyNames = game.locations.filter(l => !l.name).length;
    return {
      ok: true, path: abs, size, md5,
      locations: game.locations.length,
      actions: game.locations.reduce((n, l) => n + (l.actions || []).length, 0),
      emptyNames,
      warning: emptyNames ? '存在 ' + emptyNames + ' 个无名位置，QSP 播放器可能无法正常进入' : null
    };
  }
};

/* ------------------------------------------------------------------ */
/* MCP 协议（stdio / Streamable HTTP 两种传输共用同一套 dispatch）        */
/* ------------------------------------------------------------------ */

const PROTOCOL_VERSION = '2024-11-05';
const HTTP_PORT = Number(process.env.QSP_MCP_PORT || 8790);
const HTTP_PATH = '/mcp';

/** 处理一条 JSON-RPC 消息；通知类返回 null */
function dispatch(msg) {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      }
    };
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0', id,
      result: {
        tools: Object.keys(TOOLS).map(name => ({
          name,
          description: TOOLS[name].description,
          inputSchema: TOOLS[name].inputSchema
        }))
      }
    };
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOLS[name];
    if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: '未知工具：' + name } };
    try {
      const result = tool.handler(args);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '错误：' + e.message }], isError: true } };
    }
  }
  if (id != null) return { jsonrpc: '2.0', id, error: { code: -32601, message: '未实现的方法：' + method } };
  return null;
}

/* ---------------- stdio ---------------- */

function runStdio() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) {
        process.stderr.write('qsp-mcp: 无法解析消息\n');
        continue;
      }
      const out = dispatch(msg);
      if (out) process.stdout.write(JSON.stringify(out) + '\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stderr.write('qsp-mcp 已启动（stdio）\n');
}

/* ---------------- Streamable HTTP ---------------- */

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-ID, MCP-Protocol-Version, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function runHttp(port) {
  const http = require('http');
  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    cors(res);

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // 人看的健康检查 / 说明页
    if (req.method === 'GET' && (url === '/' || url === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        server: SERVER_INFO,
        transport: 'streamable-http',
        endpoint: 'http://127.0.0.1:' + port + HTTP_PATH,
        tools: Object.keys(TOOLS),
        pid: process.pid
      }, null, 2));
      return;
    }

    // 客户端可能开一个 GET SSE 通道接收服务端消息：保持连接心跳
    if (req.method === 'GET' && url === HTTP_PATH) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(': qsp-mcp stream open\n\n');
      const timer = setInterval(() => {
        try { res.write(': ping ' + Date.now() + '\n\n'); } catch (e) { }
      }, 20000);
      req.on('close', () => clearInterval(timer));
      return;
    }

    if (req.method === 'DELETE' && url === HTTP_PATH) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    if (req.method !== 'POST' || url !== HTTP_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('qsp-mcp: 请 POST 到 ' + HTTP_PATH + '（Streamable HTTP），或看 GET /');
      return;
    }

    let body = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      if (body.length > 32 * 1024 * 1024) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return;
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '解析失败' } }));
        return;
      }

      const batch = Array.isArray(payload);
      const msgs = batch ? payload : [payload];
      const out = [];
      for (const m of msgs) {
        const r = dispatch(m);
        if (r) out.push(r);
        if (m && m.method === 'initialize') {
          res.setHeader('Mcp-Session-Id', 'qsp-' + process.pid + '-' + Date.now().toString(36));
        }
      }

      if (out.length === 0) {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end('');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(batch ? out : out[0]));
    });
  });

  server.on('error', (e) => {
    process.stderr.write('qsp-mcp: HTTP 启动失败 ' + e.message + '\n');
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    process.stderr.write('qsp-mcp 已启动（http://127.0.0.1:' + port + HTTP_PATH + '）\n');
  });
}

/* ---------------- 入口 ---------------- */

const argv = process.argv.slice(2);
const httpFlag = argv.indexOf('--http');
if (httpFlag >= 0) {
  const p = Number(argv[httpFlag + 1]) || HTTP_PORT;
  runHttp(p);
} else {
  runStdio();
}
