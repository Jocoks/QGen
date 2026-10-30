/* Node 端测试：node tools/test-qsp.js [file.qsp] */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const QSP = require('../assets/ui/qsp.js');

function eq(a, b) { return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0; }

const file = process.argv[2];
if (!file) { console.error('用法: node tools/test-qsp.js <file.qsp>'); process.exit(2); }
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log(' FAIL ' + name + ' -> ' + e.message); }
}

console.log('== 读入 ' + file + ' (' + fs.statSync(file).size + ' 字节)');
const t0 = Date.now();
const buf = fs.readFileSync(file);
const game = QSP.parse(buf);
const t1 = Date.now();
console.log('   解析耗时 ' + (t1 - t0) + 'ms，位置 ' + game.locations.length +
  '，动作 ' + game.stats.actions + '，密码 "' + game.password + '"，头 "' + game.date + '"');

t('位置数量 = 194', () => assert.strictEqual(game.locations.length, 194));
t('第一个位置为 Start', () => assert.strictEqual(game.locations[0].name, 'Start'));

const t2 = Date.now();
const out = QSP.serialize(game);
const t3 = Date.now();
console.log('   序列化耗时 ' + (t3 - t2) + 'ms，输出 ' + out.length + ' 字节');
t('未修改时逐字节无损往返', () => assert.ok(eq(out, buf), '输出与原始文件不一致'));

// 二次解析一致性
const again = QSP.parse(out);
t('再次解析得到相同模型', () => assert.deepStrictEqual(JSON.parse(JSON.stringify(again.locations)), JSON.parse(JSON.stringify(game.locations))));

// 编辑后保存再读回
game.locations[0].code += '\n# 由 qsp.js 测试追加';
game.password = 'No';
const out2 = QSP.serialize(game);
const g2 = QSP.parse(out2);
t('编辑后保存可回读', () => assert.ok(g2.locations[0].code.indexOf('由 qsp.js 测试追加') > 0));
t('编辑后其他位置保持不变', () => assert.strictEqual(g2.locations[1].code, game.locations[1].code));

// 边界：字符 5、\n、emoji（代理对）、引号
t('特殊字符往返（5 / 换行 / emoji / 引号）', () => {
  const g = QSP.newGame();
  g.date = '2026-10-28 (QGen Android 1.0)';
  g.locations[0].name = '测试';
  g.locations[0].desc = '第一行\n第二行\n\t制表符 \u0005 字符5';
  g.locations[0].code = 'a = 5\nif (a) {\n  $desc = "含 \u0005 与 😀 与 \'单引号\'"\n}';
  g.locations[0].actions.push({ pict: 'img/a.png', name: '动作1', code: 'goto $curloc' });
  const bytes = QSP.serialize(g);
  const back = QSP.parse(bytes);
  assert.strictEqual(back.locations[0].desc, g.locations[0].desc);
  assert.strictEqual(back.locations[0].code, g.locations[0].code);
  assert.strictEqual(back.locations[0].actions[0].name, '动作1');
  assert.strictEqual(back.date, g.date);
});

t('拒绝非 QSP 文件', () => {
  assert.throws(() => QSP.parse(Buffer.from('hello world, not a qsp file at all')), /QSP/);
});

// 写回一份供 Android 端人工验证
const outFile = path.join(__dirname, 'jack-rt.qsp');
fs.writeFileSync(outFile, Buffer.from(out));
console.log('   已写出 ' + outFile);
console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
