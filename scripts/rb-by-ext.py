"""Search by $I filename extension (.ts/.scss/.json/.py) — Windows keeps original ext."""
import struct, datetime, os

RB_DIR = r"C:\$Recycle.Bin\S-1-5-21-3134951201-1836015697-2390204083-1001"
UTC_OFFSET = datetime.timedelta(hours=8)

interesting_ext = ('.ts', '.scss', '.json', '.py', '.cjs', '.js', '.map')
rows = []
for fn in os.listdir(RB_DIR):
    if not fn.upper().startswith('$I'):
        continue
    # $I + 6 random chars + optional original extension
    base = fn[9:] if len(fn) > 9 else ''
    ext = os.path.splitext(base)[1].lower() if base else ''
    if ext not in interesting_ext:
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
        rname = os.path.join(RB_DIR, '$R' + fn[2:])
        actual = os.path.getsize(rname) if os.path.exists(rname) else -1
        rows.append((dt, size, actual, path, fn, ext))
    except Exception:
        pass

print("=== 08-09 items with source-ish extensions (deleted today) ===")
for dt, size, actual, path, fn, ext in sorted(rows):
    if dt.date().isoformat() == '2026-08-09' and 'SplatRoom' in path and 'node_modules' not in path:
        print(f'{dt.strftime("%H:%M:%S")} meta={size:>9} actual={actual:>9} ext={ext} {fn} -> {path[:160]}')
