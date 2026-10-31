#!/usr/bin/env node
/* syntax.js 测试：词法分组、HTML 转义、查找命中与超长代码（不设字数上限）。 */
'use strict';
const assert = require('assert');
const path = require('path');
const HL = require(path.resolve(__dirname, '..', 'assets/ui/syntax.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' -> ' + e.message); }
}

function classes(src) {
  return HL.tokenize(src).map(x => src.slice(x.s, x.e) + ':' + x.cls).join(' ');
}

t('控制流、命令、逻辑词分组', () => {
  const s = "if $x = 1 and $y > 2\n  msg 'hi'\nelse\n  goto #item_base\nend";
  const got = classes(s);
  assert.ok(/if:kc/.test(got));
  assert.ok(/msg:kf/.test(got));
  assert.ok(/and:ko/.test(got));
  assert.ok(/\$x:vr/.test(got));
  assert.ok(/#item_base:lc/.test(got));
  assert.ok(/else:kc/.test(got));
});

t('字符串、注释、数字、比较/算术运算', () => {
  const s = "! 注释\n$x = -12.5 + 3 * 4\nif $x <> 0";
  const got = classes(s);
  assert.ok(/! 注释:cm/.test(got));
  assert.ok(/-12\.5:nu/.test(got));
  assert.ok(/\+:oa/.test(got));
  assert.ok(/\*:oa/.test(got));
  assert.ok(/<>:oc/.test(got));
  assert.ok(/=:oc/.test(got));
});

t('true/false 常量单独着色', () => {
  const got = classes('$x = true');
  assert.ok(/true:cn/.test(got));
});

t('HTML 特殊字符被转义', () => {
  const html = HL.highlight("$x = '<>&'");
  assert.ok(html.indexOf('&lt;') >= 0);
  assert.ok(html.indexOf('&gt;') >= 0);
  assert.ok(html.indexOf('&amp;') >= 0);
  assert.ok(html.indexOf('<script') < 0);
});

t('查找命中区间保留并生成 mark', () => {
  const src = "$x = 'abc abc'";
  const a = src.indexOf('abc');
  const b = src.indexOf('abc', a + 3);
  const html = HL.highlight(src, [
    { s: a, e: a + 3, cur: false },
    { s: b, e: b + 3, cur: true }
  ]);
  assert.ok(/<mark class="fh">/.test(html));
  assert.ok(/<mark class="fc">/.test(html));
});

t('436K 字符不截断、全部着色', () => {
  const line = "if $item_name = '破旧衣物' and $item_price > 10\n";
  const src = line.repeat(10000);
  assert.ok(src.length > 436000);
  const toks = HL.tokenize(src);
  assert.ok(toks.length > 70000, 'tokens=' + toks.length);
  const html = HL.highlight(src);
  assert.ok(html.length > src.length);
  assert.ok(html.indexOf('超过') < 0);
});

console.log('\n' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
