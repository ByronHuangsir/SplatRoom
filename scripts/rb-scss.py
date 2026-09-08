"""Inspect the scss item deleted at local 18:33 — likely timeline-panel.scss old version."""
import struct, datetime, os

RB_DIR = r"C:\$Recycle.Bin\S-1-5-21-3134951201-1836015697-2390204083-1001"
UTC_OFFSET = datetime.timedelta(hours=8)

for fn in ['$IRIVLGN.scss']:
    full = os.path.join(RB_DIR, fn)
    if not os.path.exists(full):
        print(f'{fn}: MISSING'); continue
    with open(full, 'rb') as fp:
        data = fp.read()
    size = struct.unpack('<Q', data[8:16])[0]
    ft = struct.unpack('<Q', data[16:24])[0]
    plen = struct.unpack('<I', data[24:28])[0]
    path = data[28:28 + plen].decode('utf-16-le', errors='replace')
    dt = datetime.datetime(1601, 1, 1) + datetime.timedelta(microseconds=ft / 10) + UTC_OFFSET
    rname = os.path.join(RB_DIR, '$R' + fn[2:])
    print(f'delete={dt} meta_size={size} actual={os.path.getsize(rname) if os.path.exists(rname) else -1}')
    print(f'path: {path}')
    if os.path.exists(rname):
        with open(rname, 'r', encoding='utf-8', errors='replace') as fp:
            content = fp.read()
        print(f'--- content head ---')
        print(content[:800])
        print(f'--- content tail ---')
        print(content[-500:])
