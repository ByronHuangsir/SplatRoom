"""Inspect actual $R data files (paired with $I metadata)."""
import struct, datetime, os, json

RB_DIR = r"C:\$Recycle.Bin\S-1-5-21-3134951201-1836015697-2390204083-1001"
UTC_OFFSET = datetime.timedelta(hours=8)

# Build $I -> (dt, size, path) map
info = {}
for fn in os.listdir(RB_DIR):
    if fn.upper().startswith('$I'):
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
            info[fn] = (dt, size, path)
        except Exception:
            pass

# Find $R files whose $I says path contains dist\index.js or index.js.map or test-crop
print("=== $R files matching index.js / index.js.map / test-crop ===")
found = []
for fn, (dt, size, path) in sorted(info.items()):
    low = path.lower()
    if 'dist\\index.js' in low or 'index.js.map' in low or 'test-crop' in low or 'test-scene' in low:
        rname = '$R' + fn[2:]
        rfile = os.path.join(RB_DIR, rname)
        actual = os.path.getsize(rfile) if os.path.exists(rfile) else -1
        found.append((dt, actual, path, rname))
        print(f'{dt.strftime("%H:%M:%S")} meta={size} actual={actual} {rname} -> {path[:130]}')

# Also list the biggest $R files overall
print("\n=== TOP 20 largest $R files ===")
big = []
for fn, (dt, size, path) in info.items():
    rname = '$R' + fn[2:]
    rfile = os.path.join(RB_DIR, rname)
    if os.path.exists(rfile):
        big.append((os.path.getsize(rfile), dt, path, rname))
big.sort(reverse=True)
for actual, dt, path, rname in big[:20]:
    print(f'{actual:>10} {dt.strftime("%H:%M:%S")} {rname} -> {path[:130]}')
