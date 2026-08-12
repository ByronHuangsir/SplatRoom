"""Get full paths for key $I entries + check truncation."""
import struct, datetime, os

RB_DIR = r"C:\$Recycle.Bin\S-1-5-21-3134951201-1836015697-2390204083-1001"
UTC_OFFSET = datetime.timedelta(hours=8)

targets = ['$I2U0V0G.js', '$IR60QF1.js', '$IPCIZNR.js', '$IK3H07L.js', '$I12Y2F5.map',
           '$IRF6YPH.map', '$ILOXT6C.map', '$I9Q2K4A.jpg', '$IQB2MSL.ply', '$IRDMUCTU.ply', '$IRYNAE9R.ply']
for fn in targets:
    full = os.path.join(RB_DIR, fn)
    if not os.path.exists(full):
        print(f'{fn}: MISSING')
        continue
    with open(full, 'rb') as fp:
        data = fp.read()
    size = struct.unpack('<Q', data[8:16])[0]
    ft = struct.unpack('<Q', data[16:24])[0]
    plen = struct.unpack('<I', data[24:28])[0]
    path = data[28:28 + plen].decode('utf-16-le', errors='replace')
    dt = datetime.datetime(1601, 1, 1) + datetime.timedelta(microseconds=ft / 10) + UTC_OFFSET
    rname = os.path.join(RB_DIR, '$R' + fn[2:])
    actual = os.path.getsize(rname) if os.path.exists(rname) else -1
    print(f'{fn}: meta_size={size} actual={actual} deleted={dt.strftime("%H:%M:%S")}')
    print(f'   -> {path}')
