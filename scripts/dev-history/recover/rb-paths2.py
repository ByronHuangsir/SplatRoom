"""Full paths for 512KB js/map items + compare with current dist sizes."""
import struct, datetime, os

RB_DIR = r"C:\$Recycle.Bin\S-1-5-21-3134951201-1836015697-2390204083-1001"
UTC_OFFSET = datetime.timedelta(hours=8)

targets = ['$I2U0V0G.js', '$IR60QF1.js', '$IPCIZNR.js', '$IK3H07L.js',
           '$IRF6YPH.map', '$ILOXT6C.map', '$IPYR3OH.map', '$IQB2MSL.ply']
for fn in targets:
    full = os.path.join(RB_DIR, fn)
    if not os.path.exists(full):
        continue
    with open(full, 'rb') as fp:
        data = fp.read()
    plen = struct.unpack('<I', data[24:28])[0]
    path = data[28:28 + plen].decode('utf-16-le', errors='replace')
    print(f'{fn} -> {path}')

print("\n=== current dist sizes ===")
for f in os.listdir(r"C:\Users\Byon Huang\WorkBuddy\SplatRoom\dist"):
    full = os.path.join(r"C:\Users\Byon Huang\WorkBuddy\SplatRoom\dist", f)
    if os.path.isfile(full):
        print(f'{os.path.getsize(full):>12} {f}')
