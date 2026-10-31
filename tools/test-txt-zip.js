/* Node 端测试：TXT 工程 / ZIP 往返
 * 用法: node tools/test-txt-zip.js [file.qsp]
 * 不给文件时用内置的小游戏，仍覆盖完整流程。
 */
'use strict';

const fs = require('fs');
const assert = require('assert');
const QSP = require('../assets/ui/qsp.js');
const QSPText = require('../assets/ui/qsp-text.js');
const QSPZip = require('../assets/ui/zip.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log(' FAIL ' + name + ' -> ' + (e && e.message || e)); }
}

async function main() {
  const file = process.argv[2];
  let game, original = null;
  if (file) {
    console.log('== 读入 ' + file + ' (' + fs.statSync(file).size + ' 字节)');
    original = fs.readFileSync(file);
    game = QSP.parse(original);
  } else {
    console.log('== 未指定 .qsp，使用内置小游戏');
    game = QSP.newGame();
    game.date = '4.0.0 beta 1';
    game.password = 'No';
    game.locations = [
      { name: 'Start', desc: '开场描述', code: 'cls\n*pl "你好 5 emoji 😀"\n', actions: [] },
      { name: '角色/商店', desc: '', code: 'act "买":\n  money -= 5\nend\n', actions: [
        { pict: 'shop.png', name: '进入商店', code: 'goto "商店"' }
      ] }
    ];
  }
  const originalBytes = original || QSP.serialize(game);
  console.log('   位置 ' + game.locations.length + '，代码 ' +
    game.locations.reduce((a, l) => a + (l.code || '').length, 0) + ' 字');

  console.log('== 导出 TXT 工程');
  const proj = QSPText.exportProject(game, { generator: 'test' });
  t('manifest 位置数一致', () => assert.strictEqual(proj.manifest.locations.length, game.locations.length));
  t('文件数 = 位置数 + manifest + README',
    () => assert.strictEqual(proj.files.length, game.locations.length + 2));
  t('位置文件名带序号且以 .txt 结尾',
    () => proj.files.slice(2).every((f, i) =>
      f.name.indexOf('locations/') === 0 && /^\d{4,}_/.test(f.name.slice(10)) && /\.txt$/.test(f.name)));
  t('文件名经过安全处理', () => {
    const f = QSPText.exportProject({
      date: '', password: 'No',
      locations: [{ name: 'a/b:c*?"<>|', desc: '', code: '', actions: [] }]
    });
    assert.ok(f.files[2].name.indexOf('a_b_c') >= 0, f.files[2].name);
  });

  console.log('== 打包 ZIP（DEFLATE）');
  const zip = await QSPZip.create(proj.files.map(f => ({ name: f.name, data: f.text })), {
    compress: true
  });
  console.log('   ' + zip.length + ' 字节');
  const entries = await QSPZip.read(zip);
  t('ZIP 条目数一致', () => assert.strictEqual(entries.length, proj.files.length));
  t('manifest 在根目录', () => assert.ok(entries.some(e => e.name === 'manifest.json')));
  t('解压后文本一致', () => {
    for (const en of entries) {
      const src = proj.files.find(f => f.name === en.name);
      assert.ok(src, '多出条目 ' + en.name);
      assert.strictEqual(QSPZip.utf8Decode(en.data), src.text, en.name);
    }
  });

  console.log('== 还原并重新序列化');
  const files = entries.map(e => ({ name: e.name, text: QSPZip.utf8Decode(e.data) }));
  const back = QSPText.importProject(files, {});
  t('不是兼容模式', () => assert.strictEqual(back.fallback, false));
  t('位置数量一致', () => assert.strictEqual(back.game.locations.length, game.locations.length));
  t('密码一致', () => assert.strictEqual(back.game.password, game.password));
  t('文件头一致', () => assert.strictEqual(back.game.date, game.date));
  t('描述 / 动作完整保留', () => assert.deepStrictEqual(
    back.game.locations.map(l => ({ desc: l.desc, actions: l.actions })),
    game.locations.map(l => ({ desc: l.desc, actions: l.actions }))));
  const out = QSP.serialize(back.game);
  t('逐字节无损往返', () => assert.ok(Buffer.compare(Buffer.from(out), Buffer.from(originalBytes)) === 0));
  t('二次解析一致', () => assert.deepStrictEqual(
    JSON.parse(JSON.stringify(QSP.parse(out).locations)),
    JSON.parse(JSON.stringify(game.locations))));

  console.log('== 无 manifest 的兼容模式');
  const looseZip = await QSPZip.create([
    { name: 'README.txt', data: '说明，应被忽略' },
    { name: '001_Start.txt', data: '第一个位置' },
    { name: '002_Second.txt', data: '第二个位置' }
  ], { compress: true });
  const looseEntries = await QSPZip.read(looseZip);
  const loose = QSPText.importProject(
    looseEntries.map(e => ({ name: e.name, text: QSPZip.utf8Decode(e.data) })), {});
  t('fallback 为 true', () => assert.strictEqual(loose.fallback, true));
  t('README 被忽略', () => assert.strictEqual(loose.game.locations.length, 2));
  t('去掉数字前缀作为位置名', () => {
    assert.deepStrictEqual(loose.game.locations.map(l => l.name), ['Start', 'Second']);
  });
  t('密码默认 No', () => assert.strictEqual(loose.game.password, 'No'));

  console.log('== STORE（不压缩）与 Unicode 文件名');
  const storeZip = await QSPZip.create([
    { name: 'locations/0001_中文 😀.txt', data: '代码' }
  ], { compress: false });
  const storeEntries = await QSPZip.read(storeZip);
  t('STORE 可读', () => assert.strictEqual(storeEntries[0].method, 0));
  t('Unicode 文件名正确', () => assert.strictEqual(storeEntries[0].name, 'locations/0001_中文 😀.txt'));

  console.log('== 错误处理');
  t('manifest 引用缺失文件时报错', () => {
    const bad = {
      name: 'manifest.json',
      text: JSON.stringify({
        format: QSPText.FORMAT, version: 1,
        locations: [{ file: 'locations/missing.txt', name: 'x', desc: '', actions: [] }]
      })
    };
    assert.throws(() => QSPText.importProject([bad], {}), /不存在/);
  });
  const broken = zip.slice();
  // 修改第一个条目（manifest.json）数据区的一个字节：压缩流或 CRC 校验应当失败
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const firstData = 30 + dv.getUint16(26, true);
  broken[firstData + 10] ^= 0xFF;
  let rejected = false;
  try { await QSPZip.read(broken); } catch (e) { rejected = true; }
  t('损坏的 ZIP 被拒绝', () => assert.ok(rejected));

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (fail) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
