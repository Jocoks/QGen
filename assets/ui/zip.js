/*!
 * zip.js — 极简 ZIP 打包 / 解包（纯 JS，无第三方依赖）
 * ------------------------------------------------------------------
 * 为什么不用 Java 的 java.util.zip？
 *   - 导出时 qsp.js / qsp-text.js 都在 JS 层，直接在 JS 里生成 zip
 *     可以保持「浏览器演示模式」和 Node 测试同样可用；
 *   - Java 侧只负责最后的“选位置 + 写字节”，桥接层保持薄。
 *
 * 特性：
 *   - 写入：UTF-8 文件名，优先用浏览器原生 CompressionStream('deflate-raw')
 *     压缩；不可用时自动退化为 STORE（不压缩，仍是合法 zip）。
 *   - 读取：支持 STORE 与 DEFLATE；需要 DecompressionStream。
 *   - 校验 CRC32 与解压后长度，拒绝加密 / ZIP64 / 未知压缩方式。
 *
 * 本文件同时支持浏览器（window.QSPZip）与 Node（module.exports）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.QSPZip = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_ENTRIES = 50000;
  var MAX_ENTRY = 256 * 1024 * 1024;
  var MAX_TOTAL = 512 * 1024 * 1024;

  var CRC_TABLE = null;
  function crc32(u8) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        CRC_TABLE[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) {
      crc = CRC_TABLE[(crc ^ u8[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function toU8(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && data.buffer instanceof ArrayBuffer) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (typeof data === 'string') return utf8Encode(data);
    throw new Error('ZIP 条目内容必须是字符串或字节数组');
  }

  function utf8Encode(s) {
    return new TextEncoder().encode(String(s));
  }

  function utf8Decode(u8) {
    return new TextDecoder('utf-8').decode(u8);
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

  function hasCompression() {
    return typeof CompressionStream === 'function';
  }

  function hasDecompression() {
    return typeof DecompressionStream === 'function';
  }

  function writeAll(writer, chunks) {
    // 顺序写入，避免大文件一次性占两份内存
    var p = Promise.resolve();
    for (var i = 0; i < chunks.length; i++) {
      (function (chunk) {
        p = p.then(function () { return writer.write(chunk); });
      })(chunks[i]);
    }
    return p.then(function () { return writer.close(); });
  }

  function readAll(readable) {
    return new Response(readable).arrayBuffer().then(function (ab) {
      return new Uint8Array(ab);
    });
  }

  function deflateRaw(u8) {
    if (!hasCompression()) return Promise.reject(new Error('当前环境不支持压缩'));
    var cs;
    try { cs = new CompressionStream('deflate-raw'); }
    catch (e) { return Promise.reject(e); }
    // 必须同时消费 readable，否则大数据会把 writer.write() 背压死
    var readP = readAll(cs.readable);
    // 用 Promise.all 同时挂上两个分支的失败处理，避免解压流报错时
    // readP 的 rejection 在 Node 里变成 unhandled rejection。
    return Promise.all([writeAll(cs.writable.getWriter(), [u8]), readP])
      .then(function (r) { return r[1]; });
  }

  function inflateRaw(u8) {
    if (!hasDecompression()) {
      return Promise.reject(new Error('当前 WebView 不支持解压 DEFLATE 条目，请升级 Android System WebView'));
    }
    var ds;
    try { ds = new DecompressionStream('deflate-raw'); }
    catch (e) { return Promise.reject(e); }
    var readP = readAll(ds.readable);
    return Promise.all([writeAll(ds.writable.getWriter(), [u8]), readP])
      .then(function (r) { return r[1]; });
  }

  function dosDateTime(d) {
    var year = Math.max(1980, Math.min(2107, d.getFullYear()));
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  function localHeader(nameBytes, method, dt, crc, csize, usize) {
    var b = new Uint8Array(30 + nameBytes.length);
    var dv = new DataView(b.buffer);
    dv.setUint32(0, 0x04034b50, true);      // local file header signature
    dv.setUint16(4, 20, true);              // version needed
    dv.setUint16(6, 0x0800, true);          // flags: UTF-8 filename
    dv.setUint16(8, method, true);
    dv.setUint16(10, dt.time, true);
    dv.setUint16(12, dt.date, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, csize, true);
    dv.setUint32(22, usize, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    b.set(nameBytes, 30);
    return b;
  }

  function centralHeader(nameBytes, method, dt, crc, csize, usize, offset) {
    var b = new Uint8Array(46 + nameBytes.length);
    var dv = new DataView(b.buffer);
    dv.setUint32(0, 0x02014b50, true);      // central directory signature
    dv.setUint16(4, 20, true);              // version made by
    dv.setUint16(6, 20, true);              // version needed
    dv.setUint16(8, 0x0800, true);          // flags: UTF-8 filename
    dv.setUint16(10, method, true);
    dv.setUint16(12, dt.time, true);
    dv.setUint16(14, dt.date, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, csize, true);
    dv.setUint32(24, usize, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint16(30, 0, true);              // extra len
    dv.setUint16(32, 0, true);              // comment len
    dv.setUint16(34, 0, true);              // disk start
    dv.setUint16(36, 0, true);              // internal attrs
    dv.setUint32(38, 0, true);              // external attrs
    dv.setUint32(42, offset, true);
    b.set(nameBytes, 46);
    return b;
  }

  /**
   * 生成 zip。
   * @param {Array<{name:string, data:string|Uint8Array}>} entries
   * @param {object} [opts] { compress?:boolean, onProgress?:fn(done,total,name) }
   * @returns {Promise<Uint8Array>}
   */
  function create(entries, opts) {
    opts = opts || {};
    if (!Array.isArray(entries)) return Promise.reject(new Error('ZIP 条目必须是数组'));
    if (entries.length > MAX_ENTRIES) return Promise.reject(new Error('ZIP 条目过多：' + entries.length));
    var compress = opts.compress !== false;
    var dt = dosDateTime(opts.date instanceof Date ? opts.date : new Date());
    var done = 0;
    var total = entries.length;
    var localParts = [];
    var centralParts = [];
    var offset = 0;
    var totalSize = 0;

    function step(i) {
      if (i >= entries.length) return Promise.resolve();
      var e = entries[i] || {};
      var name = String(e.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!name) return Promise.reject(new Error('第 ' + (i + 1) + ' 个 ZIP 条目缺少文件名'));
      var nameBytes = utf8Encode(name);
      var raw;
      try { raw = toU8(e.data); } catch (err) { return Promise.reject(err); }
      totalSize += raw.length;
      if (raw.length > MAX_ENTRY) return Promise.reject(new Error('ZIP 条目过大：' + name));
      if (totalSize > MAX_TOTAL) return Promise.reject(new Error('ZIP 总大小超过 512 MB'));

      var compressThis = compress && raw.length > 64 && hasCompression();
      var payloadP = compressThis
        ? deflateRaw(raw).catch(function () { return null; })
        : Promise.resolve(null);
      return payloadP.then(function (deflated) {
        var method = 0;
        var payload = raw;
        if (deflated && deflated.length < raw.length) {
          method = 8;
          payload = deflated;
        }
        var crc = crc32(raw);
        var lh = localHeader(nameBytes, method, dt, crc, payload.length, raw.length);
        var ch = centralHeader(nameBytes, method, dt, crc, payload.length, raw.length, offset);
        localParts.push(lh, payload);
        centralParts.push(ch);
        offset += lh.length + payload.length;
        done++;
        if (typeof opts.onProgress === 'function') {
          try { opts.onProgress(done, total, name); } catch (ignore) { }
        }
        return step(i + 1);
      });
    }

    return step(0).then(function () {
      var cdOffset = offset;
      var cdSize = 0;
      for (var i = 0; i < centralParts.length; i++) cdSize += centralParts[i].length;
      var eocd = new Uint8Array(22);
      var dv = new DataView(eocd.buffer);
      dv.setUint32(0, 0x06054b50, true);
      dv.setUint16(4, 0, true);
      dv.setUint16(6, 0, true);
      dv.setUint16(8, entries.length, true);
      dv.setUint16(10, entries.length, true);
      dv.setUint32(12, cdSize, true);
      dv.setUint32(16, cdOffset, true);
      dv.setUint16(20, 0, true);
      var all = localParts.concat(centralParts, [eocd]);
      var out = concat(all);
      return out;
    });
  }

  function findEocd(u8) {
    if (u8.length < 22) return -1;
    var min = Math.max(0, u8.length - 22 - 65535);
    for (var i = u8.length - 22; i >= min; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4B && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) return i;
    }
    return -1;
  }

  function u32(dv, off) { return dv.getUint32(off, true); }
  function u16(dv, off) { return dv.getUint16(off, true); }

  /**
   * 解包 zip。
   * @param {Uint8Array|ArrayBuffer} bytes
   * @returns {Promise<Array<{name:string, data:Uint8Array, method:number}>>}
   */
  function read(bytes) {
    return Promise.resolve().then(function () {
      var u8 = toU8(bytes);
      var eocd = findEocd(u8);
      if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到中央目录）');
      var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      var count = u16(dv, eocd + 10);
      var cdSize = u32(dv, eocd + 12);
      var cdOff = u32(dv, eocd + 16);
      if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) {
        throw new Error('不支持 ZIP64 文件');
      }
      if (cdOff + cdSize > u8.length) throw new Error('ZIP 中央目录越界，文件可能已损坏');
      if (count > MAX_ENTRIES) throw new Error('ZIP 条目过多：' + count);

      var entries = [];
      var p = cdOff;
      var totalUncompressed = 0;

      function step(i) {
        if (i >= count) return Promise.resolve(entries);
        if (p + 46 > u8.length) throw new Error('ZIP 中央目录不完整');
        if (u32(dv, p) !== 0x02014b50) throw new Error('ZIP 中央目录签名错误');
        var flags = u16(dv, p + 8);
        var method = u16(dv, p + 10);
        var crc = u32(dv, p + 16);
        var csize = u32(dv, p + 20);
        var usize = u32(dv, p + 24);
        var nameLen = u16(dv, p + 28);
        var extraLen = u16(dv, p + 30);
        var commentLen = u16(dv, p + 32);
        var localOff = u32(dv, p + 42);
        if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || localOff === 0xFFFFFFFF) {
          throw new Error('不支持 ZIP64 条目');
        }
        if (p + 46 + nameLen + extraLen + commentLen > u8.length) throw new Error('ZIP 文件名越界');
        var name = utf8Decode(u8.subarray(p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;

        if (usize > MAX_ENTRY) throw new Error('ZIP 条目解压后过大：' + name);
        if (totalUncompressed + usize > MAX_TOTAL) {
          throw new Error('ZIP 解压后总大小超过 512 MB');
        }
        if (flags & 0x0001) throw new Error('不支持加密 ZIP 条目：' + name);
        if (localOff + 30 > u8.length || u32(dv, localOff) !== 0x04034b50) {
          throw new Error('ZIP 本地文件头损坏：' + name);
        }
        var lNameLen = u16(dv, localOff + 26);
        var lExtraLen = u16(dv, localOff + 28);
        var dataStart = localOff + 30 + lNameLen + lExtraLen;
        if (dataStart + csize > u8.length) throw new Error('ZIP 数据越界：' + name);
        var comp = u8.subarray(dataStart, dataStart + csize);

        var dataP;
        if (method === 0) dataP = Promise.resolve(comp);
        else if (method === 8) dataP = inflateRaw(comp);
        else return Promise.reject(new Error('不支持的 ZIP 压缩方式 ' + method + '：' + name));

        return dataP.then(function (data) {
          if (data.length !== usize) {
            throw new Error('ZIP 条目解压后大小不符：' + name);
          }
          if (crc32(data) !== crc) {
            throw new Error('ZIP 条目 CRC 校验失败：' + name);
          }
          totalUncompressed += data.length;
          if (totalUncompressed > MAX_TOTAL) throw new Error('ZIP 解压后总大小超过 512 MB');
          entries.push({ name: name, data: data, method: method });
          return step(i + 1);
        });
      }

      return step(0);
    });
  }

  return {
    create: create,
    read: read,
    crc32: crc32,
    utf8Encode: utf8Encode,
    utf8Decode: utf8Decode,
    // 供调试 / 测试
    _hasCompression: hasCompression,
    _hasDecompression: hasDecompression
  };
});
