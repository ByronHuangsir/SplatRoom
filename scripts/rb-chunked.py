"""Check directory-form $R items (chunked files) via their $I metadata."""
import struct, datetime, os

RB_DIR = r"C:\$Recycle.Bin\S-1-5-21-3134951201-1836015697-2390204083-1001"
UTC_OFFSET = datetime.timedelta(hours=8)

# find $I entries whose $R is a directory
dir_r_names = []
for fn in os.listdir(RB_DIR):
    if fn.upper().startswith('$I'):
        rpath = os.path.join(RB_DIR, '$R' + fn[2:])
        if os.path.isdir(rpath):
            with open(os.path.join(RB_DIR, fn), 'rb') as fp:
                data = fp.read()
            if len(data) < 28:
                continue
            size = struct.unpack('<Q', data[8:16])[0]
            ft = struct.unpack('<Q', data[16:24])[0]
            plen = struct.unpack('<I', data[24:28])[0]
            path = data[28:28 + plen].decode('utf-16-le', errors='replace')
            dt = datetime.datetime(1601, 1, 1) + datetime.timedelta(microseconds=ft / 10) + UTC_OFFSET
            tot = 0
            for rf in os.listdir(rpath):
                if rf.startswith('data_'):
                    tot += os.path.getsize(os.path.join(rpath, rf))
            print(f'{dt.strftime("%H:%M:%S")} meta={size:>10} data_sum={tot:>10} {fn} -> {path[:150]}')
