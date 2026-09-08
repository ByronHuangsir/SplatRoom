#!/usr/bin/env python3
"""Generate a small INRIA-style 3DGS .ply test model for headless bug reproduction."""
import math
import os
import random
import struct
import sys

random.seed(42)

SH_C0 = 0.28209479177387814
N = 100000

def dc_encode(v):
    return (v - 0.5) / SH_C0

def logit(p):
    p = max(1e-6, min(1 - 1e-6, p))
    return math.log(p / (1 - p))

out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'dist', 'test.ply')

positions = []
normals = []
colors = []
opacities = []
scales = []
rotations = []

# A sphere of gaussians (radius ~0.9) with colorful surface + a few interior points
for i in range(N):
    # fibonacci sphere distribution on the shell for a "solid" look
    golden = math.pi * (3.0 - math.sqrt(5.0))
    y = 1.0 - (i / max(1, N - 1)) * 2.0
    rad = math.sqrt(max(0.0, 1.0 - y * y))
    theta = golden * i
    x = math.cos(theta) * rad
    z = math.sin(theta) * rad
    # slight radial jitter so it isn't a perfect shell
    r = 0.85 + 0.15 * random.random()
    positions.append((x * r, y * r, z * r))
    normals.append((0.0, 0.0, 1.0))

    # rainbow-ish colors
    h = (i / N) * 360.0
    hp = h / 60.0
    c = hp % 2.0 - 1.0
    c = 1.0 - abs(c - 1.0)
    seg = int(hp) % 6
    if seg == 0: rgb = (1.0, c, 0.0)
    elif seg == 1: rgb = (c, 1.0, 0.0)
    elif seg == 2: rgb = (0.0, 1.0, c)
    elif seg == 3: rgb = (0.0, c, 1.0)
    elif seg == 4: rgb = (c, 0.0, 1.0)
    else: rgb = (1.0, 0.0, c)
    rgb = tuple(max(0.02, min(0.98, v)) for v in rgb)
    colors.append((dc_encode(rgb[0]), dc_encode(rgb[1]), dc_encode(rgb[2])))

    opacities.append(logit(0.92))
    s = random.uniform(0.008, 0.03)
    scales.append((math.log(s), math.log(s), math.log(s)))
    rotations.append((1.0, 0.0, 0.0, 0.0))  # (w, x, y, z)

header = f"""ply
format binary_little_endian 1.0
comment generated test model
element vertex {N}
property float x
property float y
property float z
property float nx
property float ny
property float nz
property float f_dc_0
property float f_dc_1
property float f_dc_2
property float opacity
property float scale_0
property float scale_1
property float scale_2
property float rot_0
property float rot_1
property float rot_2
property float rot_3
end_header
"""

os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, 'wb') as f:
    f.write(header.encode('ascii'))
    for i in range(N):
        vals = list(positions[i]) + list(normals[i]) + list(colors[i]) + \
               [opacities[i]] + list(scales[i]) + list(rotations[i])
        f.write(struct.pack('<17f', *vals))

print(f"wrote {N} splats -> {out_path} ({os.path.getsize(out_path)} bytes)")
