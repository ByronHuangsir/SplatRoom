"""Parse Windows Recycle Bin $I metadata files to find original paths."""
import struct, datetime, os, sys

RB_DIR = r"C:\$Recycle.Bin\S-1-5-21-3134951201-1836015697-2390204083-1001"

rows = []
for fn in os.listdir(RB_DIR):
    if not fn.upper().startswith('$I'):
        continue
    full = os.path.join(RB_DIR, fn)
    try:
        with open(full, 'rb') as fp:
            data = fp.read()
        if len(data) < 28:
            continue
        header = struct.unpack('<Q', data[0:8])[0]
        size = struct.unpack('<Q', data[8:16])[0]
        ft = struct.unpack('<Q', data[16:24])[0]
        plen = struct.unpack('<I', data[24:28])[0]
        path = data[28:28 + plen].decode('utf-16-le', errors='replace')
        dt = datetime.datetime(1601, 1, 1) + datetime.timedelta(microseconds=ft / 10)
        rows.append((dt, size, path, fn))
    except Exception as e:
        rows.append((datetime.datetime.min, -1, f'PARSE_ERR:{e}', fn))

rows.sort()
for dt, size, path, fn in rows:
    print(f'{dt.strftime("%H:%M:%S")} size={size:>10} {fn} -> {path}')
print(f'\nTOTAL {len(rows)} items')
