"""Inspect the 512KB $R data files from 14:26/15:30 batches — check if they're index.js or sourcemaps."""
import os, json

RB_DIR = r"C:\$Recycle.Bin\S-1-5-21-3134951201-1836015697-2390204083-1001"

# $R data files from batches (fn[2:] strips $I)
cands = ['R2U0V0G.js', 'RA7UJOR.webp', 'RGBCXG3.jpg', 'RP CIZNR.js'.replace(' ', ''),
         'RIPCIZNR.js', 'RF6YPH.map', 'RILOXT6C.map', 'RR60QF1.js', 'RIGWQCOZ.map',
         'R12Y2F5.map', 'RIRF6YPH.map', 'RK3H07L.js', 'RPYR3OH.map']

seen = set()
for name in cands:
    rfile = os.path.join(RB_DIR, '$' + name)
    if not os.path.exists(rfile) or name in seen:
        continue
    seen.add(name)
    size = os.path.getsize(rfile)
    with open(rfile, 'rb') as fp:
        head = fp.read(80)
    is_map = b'sourcesContent' in head or b'"version"' in head or b'"sources"' in head
    is_js = head[:4] in (b'/**/', b'/*!', b'var ', b'con', b'fun', b'cla', b'exp')
    print(f'$ {name}: size={size} map={is_map} js={is_js} head={head[:60]!r}')
