"""Search recycle bin for ALL .ts/.scss source files deleted today (checkout victims)."""
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

print("=== ALL .ts / .scss source files deleted 08-09 (any time) ===")
for dt, size, path, fn in sorted(rows):
    if dt.date().isoformat() != '2026-08-09':
        continue
    low = path.lower()
    if low.endswith('.ts') or low.endswith('.scss'):
        if 'splatroom' in low and 'node_modules' not in low:
            rname = os.path.join(RB_DIR, '$R' + fn[2:])
            actual = os.path.getsize(rname) if os.path.exists(rname) else -1
            print(f'{dt.strftime("%H:%M:%S")} meta={size:>8} actual={actual:>8} {fn} -> {path}')
