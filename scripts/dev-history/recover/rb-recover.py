"""Extract and compare the recovered source files."""
import os, shutil

RB_DIR = r"C:\$Recycle.Bin\S-1-5-21-3134951201-1836015697-2390204083-1001"
OUT = r"C:\Users\Byon Huang\WorkBuddy\SplatRoom\scripts\rb-recovered"
os.makedirs(OUT, exist_ok=True)

files = [
    ("$IXXV3UH.ts", "timeline-panel_15-28.ts"),
    ("$IGEZO3M.ts", "splat_17-56.ts"),
    ("$ITJ2LG4.ts", "timeline-panel_18-33.ts"),
    ("$IRIVLGN.scss", "timeline-panel_18-33.scss"),
]
for ifile, outname in files:
    rname = os.path.join(RB_DIR, '$R' + ifile[2:])
    dst = os.path.join(OUT, outname)
    if os.path.exists(rname):
        shutil.copy2(rname, dst)
        print(f'copied {ifile} -> {outname} ({os.path.getsize(dst)} bytes)')
    else:
        print(f'MISSING $R for {ifile}')

print("\n=== content features ===")
def probe(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as fp:
        c = fp.read()
    return {
        'len': len(c),
        'audio': ('audio' in c.lower()),
        'resizeHandle': ('resize-handle' in c or 'resizeHandle' in c),
        'mediaRecorder': ('MediaRecorder' in c),
        'waveform': ('waveform' in c.lower() or 'drawWaveform' in c),
        'fadeInOut': ('fadeInOut' in c),
        'playBtn_audioSync': ('timeline.setPlaying' in c),
    }
for _, outname in files:
    p = os.path.join(OUT, outname)
    if os.path.exists(p):
        print(f'{outname}: {probe(p)}')
