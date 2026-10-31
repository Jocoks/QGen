/*!
 * qsp-text.js — QSP 游戏与「TXT 工程」之间的拆分 / 还原
 * ------------------------------------------------------------------
 * 「TXT 工程」是一个 .zip 文件，布局固定为：
 *
 *   manifest.json              游戏元数据（密码、文件头、位置顺序、描述、动作）
 *   README.txt                 格式说明（导入时忽略）
 *   locations/0001_Start.txt   每个位置一个 UTF-8 文本，内容就是位置代码
 *   locations/0002_xxx.txt
 *   ...
 *
 * 这样做的好处：
 *   - 每个位置的代码是一个普通 .txt，方便外部编辑器 / AI 批量处理；
 *   - 描述、动作、密码、文件头等当前界面不编辑的数据放在 manifest.json，
 *     导入时原样还原，不会丢失；
 *   - 没有 manifest.json 的 zip 也能导入：每个 .txt 当作一个位置，
 *     文件名（去掉 .txt）作为位置名，代码为文件内容。
 *
 * 本文件同时支持浏览器（window.QSPText）与 Node（module.exports）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.QSPText = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FORMAT = 'qgen-text-project';
  var VERSION = 1;
  var MANIFEST_NAME = 'manifest.json';
  var MAX_LOCATIONS = 200000;

  /* ------------------------------------------------------------------ */
  /* 小工具                                                              */
  /* ------------------------------------------------------------------ */

  function stripBom(s) {
    return (s && s.charCodeAt(0) === 0xFEFF) ? s.slice(1) : (s || '');
  }

  function pad4(n) {
    var s = String(n);
    while (s.length < 4) s = '0' + s;
    return s;
  }

  function todayStamp(extra) {
    var d = new Date();
    var p = function (x) { return x < 10 ? '0' + x : '' + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' (QGen Android ' + (extra || 'TXT import') + ')';
  }

  /** 生成 zip 内安全的文件名（保留中文/emoji，替换路径分隔符与控制字符） */
  function safeName(name) {
    var s = String(name == null ? '' : name);
    s = s.replace(/[\x00-\x1f\x7f]/g, ' ');
    s = s.replace(/[\\/:*?"<>|]/g, '_');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^\.+/, '').replace(/[. ]+$/, '');
    if (!s) s = 'location';
    var chars = Array.from(s);
    if (chars.length > 60) s = chars.slice(0, 60).join('') + '…';
    return s;
  }

  function normalizeZipPath(p) {
    var s = String(p || '').replace(/\\/g, '/');
    s = s.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+/g, '/');
    if (!s) return '';
    var segs = s.split('/');
    for (var i = 0; i < segs.length; i++) {
      if (segs[i] === '..') throw new Error('ZIP 中包含不安全的路径：' + p);
    }
    return s;
  }

  function baseName(p) {
    var s = String(p || '');
    var at = s.lastIndexOf('/');
    return at >= 0 ? s.slice(at + 1) : s;
  }

  function isDir(p) { return /\/$/.test(String(p || '')); }

  function naturalCompare(a, b) {
    // 逐段比较数字，保证 2.txt 排在 10.txt 前面
    var re = /(\d+)|(\D+)/g;
    var aa = String(a).match(re) || [];
    var bb = String(b).match(re) || [];
    var n = Math.min(aa.length, bb.length);
    for (var i = 0; i < n; i++) {
      var x = aa[i], y = bb[i];
      var xn = /^\d/.test(x), yn = /^\d/.test(y);
      if (xn && yn) {
        var d = parseInt(x, 10) - parseInt(y, 10);
        if (d) return d;
      } else if (x !== y) {
        return x < y ? -1 : 1;
      }
    }
    return aa.length - bb.length;
  }

  function str(v) { return v == null ? '' : String(v); }

  function normalizeAction(a) {
    a = a || {};
    return {
      pict: str(a.pict),
      name: str(a.name),
      code: str(a.code)
    };
  }

  /* ------------------------------------------------------------------ */
  /* 导出：game -> TXT 工程                                              */
  /* ------------------------------------------------------------------ */

  function buildReadme(count, generator) {
    return [
      'QGen TXT 工程',
      '=============',
      '',
      '本 zip 由 ' + (generator || 'QGen Android') + ' 从 .qsp 文件导出，共 ' + count + ' 个位置。',
      '',
      '目录说明',
      '  manifest.json              游戏元数据：文件头、密码、位置顺序、描述、动作。',
      '  locations/NNNN_名称.txt     每个位置一个文件，内容是位置代码（UTF-8，不含 BOM）。',
      '  README.txt                 本说明，导入时忽略。',
      '',
      '如何还原为 .qsp',
      '  1. 修改 locations/ 下的 .txt；文件名可以改，但 manifest.json 里的 "file"',
      '     必须和实际文件对应（推荐只改内容，不改文件名）。',
      '  2. 把 manifest.json、locations/ 一起重新压缩成 .zip（manifest.json 在 zip 根目录）。',
      '  3. 在 QGen 首页点「导入 TXT 工程（.zip）」，选择这个 .zip，另存为 .qsp 即可。',
      '',
      '兼容模式',
      '  如果 zip 里没有 manifest.json，导入时会把每个 .txt 当作一个位置：',
      '  - 文件名（去掉 .txt）作为位置名；',
      '  - 文件内容作为位置代码；',
      '  - 描述和动作留空，密码使用默认值 "No"。',
      '',
      '注意',
      '  - txt 请保存为 UTF-8；代码里的换行会原样保留。',
      '  - 描述 / 动作代码只存在于 manifest.json，请不要删除它，否则会退化为兼容模式。',
      ''
    ].join('\n');
  }

  /**
   * 把 game 拆分为 TXT 工程。
   * @param {object} game QSP.parse() 得到的游戏对象
   * @param {object} [opts] { generator }
   * @returns {{manifest:object, files:Array<{name:string,text:string}>}}
   */
  function exportProject(game, opts) {
    if (!game || !Array.isArray(game.locations)) throw new Error('没有可导出的游戏');
    opts = opts || {};
    var generator = opts.generator || 'QGen Android';
    var manifest = {
      format: FORMAT,
      version: VERSION,
      generator: generator,
      game: {
        date: str(game.date),
        password: game.password == null ? 'No' : str(game.password)
      },
      locations: []
    };
    var files = [];
    var width = Math.max(4, String(game.locations.length).length);
    for (var i = 0; i < game.locations.length; i++) {
      var loc = game.locations[i] || {};
      var num = String(i + 1);
      while (num.length < width) num = '0' + num;
      var rel = 'locations/' + num + '_' + safeName(loc.name) + '.txt';
      manifest.locations.push({
        file: rel,
        name: str(loc.name),
        desc: str(loc.desc),
        actions: (loc.actions || []).map(normalizeAction)
      });
      files.push({ name: rel, text: str(loc.code) });
    }
    // manifest / README 放最前面，便于人直接看
    files.unshift({ name: 'README.txt', text: buildReadme(game.locations.length, generator) });
    files.unshift({ name: MANIFEST_NAME, text: JSON.stringify(manifest, null, 2) + '\n' });
    return { manifest: manifest, files: files };
  }

  /* ------------------------------------------------------------------ */
  /* 导入：TXT 工程 -> game                                              */
  /* ------------------------------------------------------------------ */

  function findManifest(map) {
    var cand = [MANIFEST_NAME, 'qgen.json', 'qgen-manifest.json'];
    for (var i = 0; i < cand.length; i++) {
      if (map.has(cand[i])) return map.get(cand[i]);
    }
    // 兼容放在子目录里的 manifest.json（取层级最浅的）
    var best = null;
    map.forEach(function (f, name) {
      if (baseName(name) !== MANIFEST_NAME) return;
      if (!best || name.split('/').length < best.name.split('/').length) best = f;
    });
    return best;
  }

  function parseManifest(text, fileName) {
    var data;
    try {
      data = JSON.parse(stripBom(text));
    } catch (e) {
      throw new Error(fileName + ' 不是合法的 JSON：' + e.message);
    }
    if (!data || typeof data !== 'object') throw new Error(fileName + ' 内容为空或格式错误');
    if (data.format && data.format !== FORMAT) {
      throw new Error('不认识的工程格式：' + data.format + '（期望 ' + FORMAT + '）');
    }
    if (data.version != null && Number(data.version) > VERSION) {
      throw new Error('工程版本 ' + data.version + ' 高于当前支持的 ' + VERSION + '，请升级 QGen');
    }
    if (!Array.isArray(data.locations)) throw new Error(fileName + ' 缺少 locations 数组');
    if (data.locations.length > MAX_LOCATIONS) {
      throw new Error('位置数量异常（' + data.locations.length + '）');
    }
    return data;
  }

  function importFromManifest(manifest, map, fileName) {
    var game = {
      magic: 'QSPGAME',
      date: str(manifest.game && manifest.game.date),
      password: (manifest.game && manifest.game.password != null) ? str(manifest.game.password) : 'No',
      locations: [],
      stats: {}
    };
    for (var i = 0; i < manifest.locations.length; i++) {
      var m = manifest.locations[i] || {};
      var rel = normalizeZipPath(m.file);
      if (!rel) throw new Error('manifest 第 ' + (i + 1) + ' 个位置缺少 file 字段');
      var f = map.get(rel);
      if (!f) throw new Error('manifest 引用的 TXT 不存在：' + rel);
      game.locations.push({
        name: str(m.name),
        desc: str(m.desc),
        code: stripBom(f.text),
        actions: Array.isArray(m.actions) ? m.actions.map(normalizeAction) : []
      });
    }
    game.stats.locations = game.locations.length;
    game.stats.actions = game.locations.reduce(function (a, l) { return a + l.actions.length; }, 0);
    return { game: game, manifest: manifest, fallback: false, manifestFile: fileName };
  }

  function importLoose(files, opts) {
    var list = files.filter(function (f) {
      if (!f || isDir(f.name)) return false;
      if (!/\.txt$/i.test(f.name)) return false;
      if (/^readme\.txt$/i.test(baseName(f.name))) return false;
      return true;
    });
    if (!list.length) {
      throw new Error('ZIP 里没有找到 .txt 文件，也没有 manifest.json，无法导入');
    }
    list.sort(function (a, b) { return naturalCompare(a.name, b.name); });
    var game = {
      magic: 'QSPGAME',
      date: str(opts && opts.date) || todayStamp(opts && opts.version),
      password: 'No',
      locations: [],
      stats: {}
    };
    for (var i = 0; i < list.length; i++) {
      var name = baseName(list[i].name).replace(/\.txt$/i, '');
      // 去掉导出时自动加的 0001_ 前缀
      var stripped = name.replace(/^\d{3,}[ _-]+/, '');
      game.locations.push({
        name: stripped || name,
        desc: '',
        code: stripBom(list[i].text),
        actions: []
      });
    }
    game.stats.locations = game.locations.length;
    game.stats.actions = 0;
    return { game: game, manifest: null, fallback: true, manifestFile: '' };
  }

  /**
   * 把 TXT 工程还原为 game。
   * @param {Array<{name:string,text:string}>} files zip 内的文本文件
   * @param {object} [opts]
   * @returns {{game:object, manifest:object|null, fallback:boolean}}
   */
  function importProject(files, opts) {
    if (!Array.isArray(files)) throw new Error('导入内容必须是文件数组');
    var map = new Map();
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f || !f.name || isDir(f.name)) continue;
      map.set(normalizeZipPath(f.name), { name: f.name, text: str(f.text) });
    }
    var mf = findManifest(map);
    if (!mf) return importLoose(files, opts || {});
    var manifest = parseManifest(mf.text, mf.name);
    return importFromManifest(manifest, map, mf.name);
  }

  function suggestArchiveName(qspName) {
    var s = String(qspName || 'game.qsp').replace(/\.qsp$/i, '');
    if (!s) s = 'game';
    return s + '-txt.zip';
  }

  function suggestQspName(zipName) {
    var s = baseName(String(zipName || 'game.zip')).replace(/\.zip$/i, '');
    s = s.replace(/-txt$/i, '');
    return (s || 'game') + '.qsp';
  }

  return {
    FORMAT: FORMAT,
    VERSION: VERSION,
    MANIFEST_NAME: MANIFEST_NAME,
    exportProject: exportProject,
    importProject: importProject,
    safeName: safeName,
    normalizeZipPath: normalizeZipPath,
    suggestArchiveName: suggestArchiveName,
    suggestQspName: suggestQspName,
    naturalCompare: naturalCompare
  };
});
