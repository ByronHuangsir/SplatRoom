"""Search recycle bin for ALL versions of key source files (any date)."""
import struct, datetime, os

RB_DIR = r"C:\$Recycle.Bin\S-1-5-21-3134951201-1836015697-2390204083-1001"
UTC_OFFSET = datetime.timedelta(hours=8)

KEY_FILES = ['timeline-panel', 'splat.ts', 'scene.ts', 'camera-preview', 'editor.ts',
             'menu.ts', 'data-panel', 'crop-box']

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
        path = data[28:].decode('utf-16-le', errors='replace').rstrip('\x00')
        dt = datetime.datetime(1601, 1, 1) + datetime.timedelta(microseconds=ft / 10) + UTC_OFFSET
        rows.append((dt, size, path, fn))
    except Exception:
        pass

print("=== All deleted versions of key source files (all dates) ===")
for dt, size, path, fn in sorted(rows):
    low = path.lower().replace('\\', '/')
    if 'splatroom' in low and 'node_modules' not in low:
        for k in KEY_FILES:
            if k in low and low.endswith(('.ts', '.scss')):
                rname = os.path.join(RB_DIR, '$R' + fn[2:])
                actual = os.path.getsize(rname) if os.path.exists(rname) else -1
                print(f'{dt.strftime("%Y-%m-%d %H:%M:%S")} meta={size:>8} actual={actual:>8} {fn} -> {path}')
                break
