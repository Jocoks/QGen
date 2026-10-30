/* 自测：以 MCP 客户端身份跑一遍服务（node mcp/selftest.js） */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, 'server.js');
const WORK = process.env.QSP_WORK_DIR || require('os').tmpdir();
const SAMPLE = process.env.QSP_FILE || path.join(WORK, 'sample.qsp');
const CHECK_COPY = path.join(WORK, 'mcp-selftest.qsp');

const child = spawn(process.argv0, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '', nextId = 1;
const waiters = new Map();

child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    waiters.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(tool, args) {
  const r = await rpc('tools/call', { name: tool, arguments: args });
  const text = r.result && r.result.content && r.result.content[0] && r.result.content[0].text;
  let parsed = text;
  try { parsed = JSON.parse(text); } catch (e) { }
  return { isError: !!(r.result && r.result.isError), value: parsed };
}

(async () => {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } });
  console.log('initialize ->', init.result.serverInfo);

  const list = await rpc('tools/list', {});
  console.log('tools:', list.result.tools.map(t => t.name).join(', '));

  const info = await call('qsp_info', { path: SAMPLE });
  console.log('\nqsp_info:', JSON.stringify(info.value));

  const locs = await call('qsp_list_locations', { path: SAMPLE, filter: 'menu' });
  console.log('\n列表(menu):', locs.value.matched, '个 ->', locs.value.locations.map(l => l.name).join(', '));

  const s = await call('qsp_search', { path: SAMPLE, query: 'main_menu', snippetsPerLocation: 2, limit: 3 });
  console.log('\n搜索 main_menu: 命中位置', s.value.matchedLocations, '总命中', s.value.totalHits);
  console.log(JSON.stringify(s.value.locations.slice(0, 3), null, 1).slice(0, 900));

  const one = await call('qsp_get_location', { path: SAMPLE, location: 'warning', includeActions: false });
  console.log('\n读取 warning:', JSON.stringify(one.value).slice(0, 300));

  // ---- 写操作：在副本上做 ----
  fs.copyFileSync(SAMPLE, CHECK_COPY);
  const rep = await call('qsp_replace', { path: CHECK_COPY, location: 'warning', field: 'code', find: "gt 'main_menu'", replace: "gt 'main_menu' ! MCP-TEST", all: false, dryRun: true });
  console.log('\n替换(dry):', JSON.stringify(rep.value));
  console.log('dryRun 后文件 md5 未变:', require('crypto').createHash('md5').update(fs.readFileSync(CHECK_COPY)).digest('hex') === info.value.md5);

  const rep2 = await call('qsp_replace', { path: CHECK_COPY, location: 'warning', field: 'code', find: "gt 'main_menu'", replace: "gt 'main_menu' ! MCP-TEST", all: false, dryRun: false });
  console.log('替换(写入):', JSON.stringify(rep2.value));

  const v = await call('qsp_validate', { path: CHECK_COPY });
  console.log('校验:', JSON.stringify(v.value));

  const back = await call('qsp_get_location', { path: CHECK_COPY, location: 'warning', includeActions: false });
  console.log('写后读回包含标记:', /MCP-TEST/.test(back.value.code));

  // 撤销：用 .bak 还原
  fs.copyFileSync(CHECK_COPY + '.bak', CHECK_COPY);
  const v2 = await call('qsp_validate', { path: CHECK_COPY });
  console.log('还原后 md5 是否等于原文件:', v2.value.md5 === info.value.md5);

  child.kill();
  process.exit(0);
})();
