"""Find $R data files for the 14:26 and 15:30 deletion batches + check if they're index.js/map."""
import struct, datetime, os

RB_DIR = r"C:\$Recycle.Bin\S-1-5-21-3134951201-1836015697-2390204083-1001"
UTC_OFFSET = datetime.timedelta(hours=8)

# Map $I -> (local_dt, size, path)
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
            info[fn[1:]] = (dt, size, path)  # strip leading $I -> key = random name
        except Exception:
            pass

# For batches at 14:26 and 15:30, list all $R files present
print("=== $R data files for 14:26 / 15:30 / 15:41 batches ===")
for rname in sorted(info.keys()):
    dt, size, path = info[rname]
    rfile = os.path.join(RB_DIR, '$R' + rname)
    actual = os.path.getsize(rfile) if os.path.exists(rfile) else -1
    tstr = dt.strftime("%H:%M:%S")
    if tstr in ('14:26:06', '14:26:07', '15:30:55', '15:41:08', '15:41:09'):
        print(f'{tstr} meta_size={size:>10} actual={actual:>10} $R{rname} -> {path[:150]}')
