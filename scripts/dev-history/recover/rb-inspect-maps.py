"""Inspect the .map and .js files recovered from recycle bin batches."""
import os, json

RB_DIR = r"C:\$Recycle.Bin\S-1-5-21-3134951201-1836015697-2390204083-1001"

# candidates from 14:26 / 15:30 batches
cands = [
    ("$IPYR3OH.map", "14:26 batch"),   # index.js.map?
    ("$IK3H07L.js", "14:26 batch"),    # index.js?
    ("$IRF6YPH.map", "15:30 batch"),
    ("$IPCIZNR.js", "15:30 batch"),
    ("$ILOXT6C.map", "15:41 batch"),
    ("$IR60QF1.js", "15:41 batch"),
]

for rname, batch in cands:
    full = os.path.join(RB_DIR, rname)
    if not os.path.exists(full):
        print(f'{rname} ({batch}): MISSING')
        continue
    size = os.path.getsize(full)
    with open(full, 'rb') as fp:
        head = fp.read(200)
    is_json = head.lstrip().startswith(b'{')
    is_map = b'sourcesContent' in head or b'"sources"' in head
    print(f'\n=== {rname} ({batch}) size={size} ===')
    print(f'  json_start={is_json} map_marker={is_map}')
    print(f'  head: {head[:120]!r}')
    if is_json:
        try:
            with open(full, 'r', encoding='utf-8', errors='replace') as fp:
                data = json.load(fp)
            srcs = data.get('sources', [])
            contents = data.get('sourcesContent', [])
            print(f'  sources={len(srcs)} sourcesContent={len(contents) if contents else 0}')
            if srcs:
                for s in srcs[:10]:
                    print(f'    - {s}')
            if contents:
                tl = [c for s, c in zip(srcs, contents) if 'timeline-panel' in s]
                for c in tl[:1]:
                    print(f'  timeline-panel.ts in this map! len={len(c)}')
        except Exception as e:
            print(f'  json parse error: {e}')
