"""Find recycle bin items deleted in local time 14:20~15:00 on 08-09 (UTC 06:20~07:00)."""
import struct, datetime, os

RB_DIR = r"C:\$Recycle.Bin\S-1-5-21-3134951201-1836015697-2390204083-1001"
UTC_OFFSET = datetime.timedelta(hours=8)

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
        dt = datetime.datetime(1601, 1, 1) + datetime.timedelta(microseconds=ft / 10) + UTC_OFFSET
        rows.append((dt, size, path, fn))
    except Exception:
        pass

print("=== LOCAL 08-09 14:20~15:00 deleted (SplatRoom) ===")
for dt, size, path, fn in sorted(rows):
    if dt.date().isoformat() == '2026-08-09' and datetime.time(14, 20) <= dt.time() <= datetime.time(15, 0):
        if 'SplatRoom' in path:
            print(f'{dt.strftime("%H:%M:%S")} size={size:>10} {fn} -> {path[:170]}')

print("\n=== LOCAL 08-09 14:00~14:20 deleted ===")
for dt, size, path, fn in sorted(rows):
    if dt.date().isoformat() == '2026-08-09' and datetime.time(14, 0) <= dt.time() < datetime.time(14, 20):
        if 'SplatRoom' in path:
            print(f'{dt.strftime("%H:%M:%S")} size={size:>10} {fn} -> {path[:170]}')
