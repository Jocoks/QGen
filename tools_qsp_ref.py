import sys, struct

COD = 5

def enc(s: str, coded: bool) -> bytes:
    out = bytearray()
    for ch in s:
        c = ord(ch)
        if coded:
            if c == COD:
                v = 0xFFFB
            else:
                v = (c - COD) & 0xFFFF
        else:
            v = c & 0xFFFF
        out += struct.pack('<H', v)
    return bytes(out)

def dec(b: bytes, coded: bool) -> str:
    n = len(b)//2
    vals = struct.unpack('<%dH' % n, b[:n*2])
    chars = []
    for v in vals:
        if coded:
            v = COD if v == 0xFFFB else (v + COD) & 0xFFFF
        chars.append(chr(v))
    return ''.join(chars)

DELIM = enc('\r\n', False)

def split(buf: bytes):
    parts, cur, i = [], 0, 0
    while True:
        j = buf.find(DELIM, i)
        if j < 0:
            break
        parts.append(buf[cur:j]); cur = j + len(DELIM); i = cur
    parts.append(buf[cur:])
    return parts

def load(path):
    raw = open(path,'rb').read()
    parts = split(raw)
    # UCS2 detection like qgen: !buf[1]
    assert parts[0][1] == 0, 'not ucs2'
    strs = [dec(p, False) for p in parts]  # raw text (not decoded) for header
    # header is not coded; body is coded
    hdr = [dec(parts[0],False), dec(parts[1],False), dec(parts[2],False), dec(parts[3],False)]
    assert hdr[0] == 'QSPGAME'
    passwd = dec(parts[2], True)
    locs_count = int(dec(parts[3], True).strip())
    idx = 4
    locs = []
    for _ in range(locs_count):
        name = dec(parts[idx], True); idx += 1
        desc = dec(parts[idx], True).replace('\r\n', '\n'); idx += 1
        code = dec(parts[idx], True).replace('\r\n', '\n'); idx += 1
        acount = int(dec(parts[idx], True).strip() or 0); idx += 1
        acts = []
        for _ in range(acount):
            pict = dec(parts[idx], True).replace('\r\n','\n'); idx += 1
            aname = dec(parts[idx], True).replace('\r\n','\n'); idx += 1
            acode = dec(parts[idx], True).replace('\r\n','\n'); idx += 1
            acts.append((pict, aname, acode))
        locs.append((name, desc, code, acts))
    return dict(parts=parts, header=hdr, passwd=passwd, locs=locs, idx=idx)

def save(game, path=None):
    parts = []
    def w(s, coded):
        parts.append(enc(s.replace('\n','\r\n'), coded))
    # header strings un-coded
    parts.append(enc('QSPGAME', False))
    parts.append(enc(game.get('date','4.0.0 beta 1'), False))
    parts.append(enc(game['passwd'], True))
    parts.append(enc(str(len(game['locs'])), True))
    for name, desc, code, acts in game['locs']:
        w(name, True); w(desc, True); w(code, True)
        parts.append(enc(str(len(acts)), True))
        for pict, aname, acode in acts:
            w(pict, True); w(aname, True); w(acode, True)
    out = DELIM.join(parts) + DELIM
    if path: open(path,'wb').write(out)
    return out

if __name__ == '__main__':
    g = load('jack.qsp')
    print('header:', g['header'], 'locs:', len(g['locs']), 'passwd:', repr(g['passwd']))
    print('first locs:', [(n, len(d), len(c), len(a)) for n,d,c,a in g['locs'][:5]])
    print('names sample:', [n for n,_,_,_ in g['locs'][:10]])
    out = save(g)
    orig = open('jack.qsp','rb').read()
    print('roundtrip identical:', out == orig, 'len', len(out), len(orig))
    open('/tmp/jack_rt.qsp','wb').write(out)
