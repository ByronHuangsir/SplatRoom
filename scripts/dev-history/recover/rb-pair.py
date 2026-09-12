"""Correctly pair $I metadata with $R data files for the 14:26/15:30 batches."""
import struct, datetime, os

RB_DIR = r"C:\$Recycle.Bin\S-1-5-21-3134951201-1836015697-2390204083-1001"
UTC_OFFSET = datetime.timedelta(hours=8)

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
            # $I001W8P -> $R001W8P
            rname = '$R' + fn[2:]
            rfile = os.path.join(RB_DIR, rname)
            actual = os.path.getsize(rfile) if os.path.exists(rfile) else -1
            info[fn] = (dt, size, path, actual, rfile)
        except Exception:
            pass

print("=== 14:26 / 15:30 / 15:41 batches with actual $R sizes ===")
for fn in sorted(info.keys()):
    dt, size, path, actual, rfile = info[fn]
    tstr = dt.strftime("%H:%M:%S")
    if tstr in ('14:26:06', '14:26:07', '15:30:55', '15:41:08', '15:41:09'):
        print(f'{tstr} meta={size:>10} actual={actual:>10} {fn} -> {path[:120]}')

# Show large $R files overall (potential index.js / index.js.map)
print("\n=== All $R files > 500KB ===")
big = []
for fn, (dt, size, path, actual, rfile) in info.items():
    if actual > 500000:
        big.append((dt, actual, path, fn))
for dt, actual, path, fn in sorted(big)[:20]:
    print(f'{dt.strftime("%H:%M:%S")} actual={actual:>10} {fn} -> {path[:120]}')
