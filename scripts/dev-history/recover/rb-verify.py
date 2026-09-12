"""Verify FILETIME parsing for specific recycle bin items."""
import struct, datetime, os

RB = r"C:\$Recycle.Bin\S-1-5-21-3134951201-1836015697-2390204083-1001"
for fn in ["$I001W8P", "$I005F9U", "$I005SNB"]:
    d = open(os.path.join(RB, fn), 'rb').read()
    ft = struct.unpack('<Q', d[16:24])[0]
    dt = datetime.datetime(1601, 1, 1) + datetime.timedelta(microseconds=ft / 10)
    plen = struct.unpack('<I', d[24:28])[0]
    path = d[28:28 + plen].decode('utf-16-le', errors='replace')
    print(f'{fn}: FILETIME={ft} -> {dt}')
    print(f'  path: {path}')
    print(f'  fs mtime: {datetime.datetime.fromtimestamp(os.path.getmtime(os.path.join(RB, fn)))}')
