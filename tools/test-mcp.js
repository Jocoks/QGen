#!/usr/bin/env node
/*
 * 内置 MCP 工具层测试：不启动 Android，只验证 JSON-RPC 封装、
 * 文件分块读取、记录表扫描/更新（含真实写回后的重新解析）。
 *
 *   node tools/test-mcp.js [/path/to/game.qsp]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const QSP = require(path.join(ROOT, 'assets/ui/qsp.js'));
const QSPRecords = require(path.join(ROOT, 'assets/ui/records.js'));

const DEFAULT = '/storage/emulated/0/DSH/测试文件.qsp';
const target = process.argv[2] || DEFAULT;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' -> ' + e.message); }
}

if (!fs.existsSync(target)) {
  console.error('找不到测试文件：' + target);
  process.exit(2);
}

const disk = fs.readFileSync(target);
let writeChunks = [];
let written = null;

global.QSP = QSP;
global.QSPRecords = QSPRecords;
global.window = {
  Native: {
    mcpFileStat: function (p) { return { ok: true, path: p, size: disk.length, writable: true }; },
    mcpReadChunk: function (p, off, len) {
      return { ok: true, data: disk.subarray(off, off + len).toString('base64') };
    },
    mcpWriteBegin: function () { writeChunks = []; return { ok: true }; },
    mcpWriteChunk: function (b64) { writeChunks.push(Buffer.from(b64, 'base64')); return { ok: true, size: 1 }; },
    mcpWriteEnd: function () { written = Buffer.concat(writeChunks); return { ok: true, size: written.length }; },
    mcpWriteAbort: function () { writeChunks = []; }
  }
};

const M = require(path.join(ROOT, 'assets/ui/mcp.js'));

function rpc(method, params, id) {
  return M.handleRpc(JSON.stringify({ jsonrpc: '2.0', id: id === undefined ? 1 : id, method: method, params: params || {} }));
}
function tool(name, args) {
  const r = rpc('tools/call', { name: name, arguments: args });
  assert.ok(r && r.result, 'missing result');
  const text = r.result.content[0].text;
  return { isError: !!r.result.isError, data: JSON.parse(text), text: text };
}

console.log('MCP 工具层测试：' + target + ' (' + disk.length + ' 字节)');

t('工具数量与名称', () => {
  assert.strictEqual(M.toolNames().length, 16);
  ['qsp_info', 'qsp_records_scan', 'qsp_records_table', 'qsp_records_update'].forEach(n => {
    assert.ok(M.toolNames().indexOf(n) >= 0, n);
  });
});

t('initialize 返回协议与服务器信息', () => {
  const r = rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.strictEqual(r.result.protocolVersion, '2024-11-05');
  assert.strictEqual(r.result.serverInfo.name, 'qgen');
  assert.ok(r.result.capabilities.tools);
});

t('tools/list 的 schema 可序列化', () => {
  const r = rpc('tools/list');
  assert.strictEqual(r.result.tools.length, 16);
  assert.ok(r.result.tools.every(x => x.name && x.description && x.inputSchema));
});

t('通知请求返回 null（HTTP 202）', () => {
  assert.strictEqual(M.handleRpc(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), null);
});

t('未知方法返回 -32601', () => {
  const r = rpc('bogus/method');
  assert.strictEqual(r.error.code, -32601);
});

t('qsp_info 读取真实文件', () => {
  const x = tool('qsp_info', { path: target });
  assert.strictEqual(x.isError, false);
  assert.strictEqual(x.data.size, disk.length);
  assert.strictEqual(x.data.locations, 198);
});

t('qsp_records_scan 找到 40 个族、30158 条语句', () => {
  const x = tool('qsp_records_scan', { path: target, maxFamilies: 10 });
  assert.strictEqual(x.data.statements, 30158);
  assert.strictEqual(x.data.totalFamilies, 40);
  assert.ok(x.data.families.length > 0);
  assert.ok(x.data.families.every(f => f.records > 0 && f.fields > 0));
});

t('qsp_records_table 读取 item_base 93 行', () => {
  const x = tool('qsp_records_table', { path: target, family: 'auto:item_base', limit: 200 });
  assert.strictEqual(x.isError, false);
  assert.strictEqual(x.data.totalRows, 93);
  assert.ok(x.data.columns.some(c => c.key === 'ib_cycle_arg2'));
  assert.ok(x.data.rows.some(r => r.values.ib_cycle_arg2 === '破旧衣物'));
});

let row, col;
t('qsp_records_update dryRun 不写文件', () => {
  const tbl = tool('qsp_records_table', { path: target, family: 'auto:item_base', limit: 200 }).data;
  row = tbl.rows.find(r => r.values.ib_cycle_arg2 === '破旧衣物');
  col = tbl.columns.find(c => c.key === 'ib_cycle_arg2');
  assert.ok(row && col);
  const before = written;
  const x = tool('qsp_records_update', {
    path: target,
    updates: [{ family: 'auto:item_base', id: row.id, field: 'ib_cycle_arg2', value: '测试物品' }]
  });
  assert.strictEqual(x.isError, false);
  assert.strictEqual(x.data.changed, 1);
  assert.strictEqual(x.data.saved.dryRun, true);
  assert.strictEqual(written, before);
});

t('qsp_records_update 实际写回后 QSP 可解析且值已变', () => {
  const x = tool('qsp_records_update', {
    path: target,
    dryRun: false,
    updates: [{ family: 'auto:item_base', id: row.id, field: 'ib_cycle_arg2', value: '测试物品' }]
  });
  assert.strictEqual(x.isError, false);
  assert.strictEqual(x.data.saved.dryRun, undefined);
  assert.ok(written && written.length > 0);
  const g = QSP.parse(written);
  assert.strictEqual(g.locations.length, 198);
  const base = g.locations.find(l => l.name === '#item_base');
  assert.ok(base.code.indexOf("'测试物品'") >= 0);
  assert.ok(base.code.indexOf("'破旧衣物'") < 0);
});

t('未知工具返回 JSON-RPC 错误', () => {
  const r = rpc('tools/call', { name: 'no_such_tool', arguments: {} });
  assert.strictEqual(r.error.code, -32602);
  assert.ok(/未知工具/.test(r.error.message));
});

console.log('\n' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
