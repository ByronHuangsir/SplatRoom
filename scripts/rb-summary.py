"""Summarize recycle bin: date histogram + find index.js.map entries."""
import struct, datetime, os
from collections import Counter

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
        size = struct.unpack('<Q', data[8:16])[0]
        ft = struct.unpack('<Q', data[16:24])[0]
        plen = struct.unpack('<I', data[24:28])[0]
        path = data[28:28 + plen].decode('utf-16-le', errors='replace')
        dt = datetime.datetime(1601, 1, 1) + datetime.timedelta(microseconds=ft / 10)
        rows.append((dt, size, path, fn))
    except Exception:
        pass

dates = Counter(dt.date().isoformat() for dt, _, _, _ in rows)
print("=== 按日期统计 ===")
for d, c in sorted(dates.items()):
    print(f'{d}: {c} items')

print("\n=== 8-09 的条目（非 temp）===")
for dt, size, path, fn in sorted(rows):
    if dt.date().isoformat() == '2026-08-09' and 'Temp' not in path and 'SplatRoom' in path:
        print(f'{dt.strftime("%H:%M:%S")} size={size:>10} {fn} -> {path[:160]}')
