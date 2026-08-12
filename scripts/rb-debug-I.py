"""Debug the $I file raw bytes for the scss item."""
import struct, os

RB_DIR = r"C:\$Recycle.Bin\S-1-5-21-3134951201-1836015697-2390204083-1001"
fn = '$IRIVLGN.scss'
with open(os.path.join(RB_DIR, fn), 'rb') as fp:
    data = fp.read()
print(f'$I file size: {len(data)}')
print('header:', struct.unpack('<Q', data[0:8])[0])
print('file size field:', struct.unpack('<Q', data[8:16])[0])
print('FILETIME:', struct.unpack('<Q', data[16:24])[0])
print('path len:', struct.unpack('<I', data[24:28])[0])
print('raw tail bytes:', data[28:60].hex())
print('decoded (utf-16le):', data[28:60].decode('utf-16-le', errors='replace'))

# Try full decode up to file end
print('full decoded:', data[28:].decode('utf-16-le', errors='replace'))
