"""Parse specific recycle bin items with correct local time (+8h)."""
import struct, datetime, os

RB_DIR = r"C:\$Recycle.Bin\S-1-5-21-3134951201-1836015697-2390204083-1001"
UTC_OFFSET = datetime.timedelta(hours=8)

# Items of interest: find ALL .ts / .scss / .map / timeline / src related items
targets = []
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
        targets.append((dt, size, path, fn))
    except Exception:
        pass

print("=== ALL .ts/.scss/map/timeline/src-related items (08-09) ===")
for dt, size, path, fn in sorted(targets):
    if dt.date().isoformat() != '2026-08-09':
        continue
    low = path.lower()
    if any(k in low for k in ['src\\', '.ts', '.scss', 'timeline', '.map', 'editor.ts', 'menu.ts', 'splat.ts', 'scene.ts', 'camera-preview']):
        print(f'{dt.strftime("%H:%M:%S")} size={size:>10} {fn} -> {path[:170]}')
