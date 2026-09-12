"""Search recycle bin with full-path decoding (ignore truncated plen) for ALL source files."""
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
        # decode full tail as UTF-16LE, strip trailing nulls
        path = data[28:].decode('utf-16-le', errors='replace').rstrip('\x00')
        dt = datetime.datetime(1601, 1, 1) + datetime.timedelta(microseconds=ft / 10) + UTC_OFFSET
        rows.append((dt, size, path, fn))
    except Exception:
        pass

print("=== 08-09 deleted source files under SplatRoom\\src (full decode) ===")
count = 0
for dt, size, path, fn in sorted(rows):
    if dt.date().isoformat() != '2026-08-09':
        continue
    low = path.lower().replace('\\', '/')
    if 'splatroom/src/' in low and low.endswith(('.ts', '.scss', '.json')):
        if 'node_modules' in low:
            continue
        count += 1
        print(f'{dt.strftime("%H:%M:%S")} size={size:>9} {fn} -> {path}')
print(f'... {count} source files total')
