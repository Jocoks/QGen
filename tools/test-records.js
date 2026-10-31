#!/usr/bin/env node
/*!
 * records.js 测试：用真实 QSP 验证扫描、建表、人工列与 CSV。
 * 用法：node tools/test-records.js [file.qsp]
 */
'use strict';
var fs = require('fs');
var path = require('path');
var QSP = require('../assets/ui/qsp.js');
var R = require('../assets/ui/records.js');

var file = process.argv[2] || '/storage/emulated/0/DSH/测试文件.qsp';
var pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { fail++; console.log('  \u2717 ' + name + ' -> ' + (e && e.message || e)); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}
function truth(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

console.log('records.js test — ' + file);
var game = QSP.parse(fs.readFileSync(file));

ok('parse real qsp', function () {
  eq(game.locations.length, 198, 'locations');
});

var scan = R.scan(game, { minRecords: 3, minFields: 2 });
ok('scan returns many statements', function () {
  truth(scan.statementCount > 30000, 'statementCount=' + scan.statementCount);
});
ok('scan finds candidate families', function () {
  truth(scan.families.length >= 20, 'families=' + scan.families.length);
  scan.families.forEach(function (f) {
    truth(f.recordCount >= 3, 'family records');
    truth(f.fieldCount >= 2, 'family fields');
    truth(f.descriptor && f.descriptor.fields.length === f.fieldCount, 'descriptor fields');
  });
});

var itemFam = scan.families.filter(function (f) {
  return f.label.indexOf('#item_base') >= 0 && f.label.indexOf('$ib_cycle') >= 0;
})[0];
ok('finds #item_base helper family', function () {
  truth(itemFam, '#item_base family missing');
  eq(itemFam.recordCount, 93, 'items');
  truth(itemFam.fieldCount >= 7, 'fields');
});

var itemTable = R.buildTable(game, itemFam.descriptor);
ok('builds item table', function () {
  truth(itemTable.ok, (itemTable.errors || []).join(';'));
  eq(itemTable.rows.length, 93, 'rows');
  eq(itemTable.columns.length, itemFam.fieldCount, 'columns');
});
ok('helper arg and code block extracted', function () {
  var row = itemTable.rows.filter(function (r) { return r.id === 'man_rugs'; })[0];
  truth(row, 'man_rugs missing');
  eq(row.values.ib_cycle_arg2, '破旧衣物', 'name');
  eq(row.values.ib_cycle_arg3, 5, 'price');
  truth(/^\{/.test(row.values.item_property), 'property block=' + row.values.item_property);
});
ok('missing values are reported', function () {
  truth(itemTable.warnings.length > 0, 'warnings');
  var row0 = itemTable.rows.filter(function (r) { return r.id === '0'; })[0];
  truth(row0.values.ib_cycle_arg2 === '', 'id 0 has no helper args');
});

var merged = {
  version: 1,
  id: 'items-merged',
  label: '物品合并',
  scope: { locations: ['#item_base', '#боевые_предметы'] },
  records: {
    kind: 'keyed',
    sources: [{ kind: 'helper', name: '$ib_cycle' }, { kind: 'array', name: '$item_name' }]
  },
  fields: [
    { key: 'name', label: '名称', source: { kind: 'helperArg', helper: '$ib_cycle', arg: 2 } },
    { key: 'price', label: '价格', type: 'number', source: { kind: 'helperArg', helper: '$ib_cycle', arg: 3 } },
    { key: 'w_name', label: '武器名', source: { kind: 'array', name: '$item_name' } },
    { key: 'property', label: '效果', type: 'code', source: { kind: 'block', name: '$item_property' } },
    { key: 'tag', label: '人工标签', source: { kind: 'manual', name: 'tag' } }
  ],
  manual: { tag: { 'man_rugs': '待定, "重点"' } }
};
var mergedTable = R.buildTable(game, merged);
ok('merged descriptor spans two locations', function () {
  truth(mergedTable.ok, (mergedTable.errors || []).join(';'));
  eq(mergedTable.rows.length, 135, 'merged rows');
  var named = mergedTable.rows.filter(function (r) { return r.values.name || r.values.w_name; });
  truth(named.length >= 130, 'named=' + named.length);
});
ok('manual source value is read', function () {
  var r = mergedTable.rows.filter(function (x) { return x.id === 'man_rugs'; })[0];
  truth(r, 'row 1 missing');
  eq(r.values.tag, '待定, "重点"', 'manual tag');
});
ok('manual column exposed with source metadata', function () {
  var c = mergedTable.columns.filter(function (x) { return x.key === 'tag'; })[0];
  truth(c && c.source && c.source.kind === 'manual', 'column source');
});

ok('addField / removeField validate descriptor', function () {
  var a = R.addField(merged, { key: 'note', label: '备注', source: { kind: 'literal', value: 'x' } });
  truth(a.ok, (a.errors || []).join(';'));
  eq(a.descriptor.fields.length, merged.fields.length + 1, 'added');
  var b = R.removeField(a.descriptor, 'note');
  truth(b.ok, (b.errors || []).join(';'));
  eq(b.descriptor.fields.length, merged.fields.length, 'removed');
});
ok('invalid source is rejected', function () {
  var bad = JSON.parse(JSON.stringify(merged));
  bad.fields[0].source = { kind: 'nope' };
  truth(!R.validateDescriptor(bad).ok, 'should reject');
});

var csv = R.tableToCSV(mergedTable);
ok('CSV has BOM and header', function () {
  truth(csv.charAt(0) === '\uFEFF', 'BOM');
  truth(csv.indexOf('id,名称,价格,武器名,效果,人工标签') === 0 + 1, 'header');
});
ok('CSV escapes comma and quote', function () {
  truth(csv.indexOf('"待定, ""重点"""') >= 0, 'escaped cell');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
