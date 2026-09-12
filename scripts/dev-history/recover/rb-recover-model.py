"""Recover the user's real 668MB model from recycle bin ($RDMUCTU.ply / $RYNAE9R.ply)."""
import os, shutil

RB_DIR = r"C:\$Recycle.Bin\S-1-5-21-3134951201-1836015697-2390204083-1001"
OUT = r"C:\Users\Byon Huang\WorkBuddy\SplatRoom\dist\test-scene.ply"

# Find the 668MB model (user's real scene: MIPMAP-场景-牛棚子（全景）-修剪.ply)
for rname in ['$RDMUCTU.ply', '$RYNAE9R.ply']:
    full = os.path.join(RB_DIR, rname)
    if os.path.exists(full):
        size = os.path.getsize(full)
        print(f'{rname}: {size} bytes')
        # check it's the 668MB one
        if size > 600_000_000:
            shutil.copy2(full, OUT)
            print(f'copied -> {OUT} ({os.path.getsize(OUT)} bytes)')
            break
