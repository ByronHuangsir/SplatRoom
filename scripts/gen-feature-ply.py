#!/usr/bin/env python3
"""Generate an ELLIPSOID 3DGS .ply (anisotropic shell) for align testing.
Usage: gen-feature-ply.py <out.ply> [rx ry rz]  (default 1.5 0.8 1.1)
"""
import math
import os
import random
import struct
import sys

random.seed(42)

SH_C0 = 0.28209479177387814
N = 4000

def dc_encode(v):
    return (v - 0.5) / SH_C0

def logit(p):
    p = max(1e-6, min(1 - 1e-6, p))
    return math.log(p / (1 - p))

out_path = sys.argv[1] if len(sys.argv) > 1 else 'dist/feature.ply'
rx, ry, rz = 1.5, 0.8, 1.1
if len(sys.argv) >= 5:
    rx, ry, rz = float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])

positions = []
normals = []
colors = []
opacities = []
scales = []
rotations = []

for i in range(N):
    golden = math.pi * (3.0 - math.sqrt(5.0))
    y = 1.0 - (i / max(1, N - 1)) * 2.0
    rad = math.sqrt(max(0.0, 1.0 - y * y))
    theta = golden * i
    x = math.cos(theta) * rad
    z = math.sin(theta) * rad
    r = 0.85 + 0.15 * random.random()
    bx, by, bz = x * r * rx, y * r * ry, z * r * rz
    if i < N // 4:
        # bump: offset toward +Y corner (breaks central symmetry)
        bx += 0.5 * rx * x
        by += 0.9 * ry
        bz += 0.3 * rz
    positions.append((bx, by, bz))
    normals.append((0.0, 0.0, 1.0))
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
    rotations.append((1.0, 0.0, 0.0, 0.0))

header = f"""ply
format binary_little_endian 1.0
comment generated feature test model
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

print(f"wrote {N} splats (ellipsoid {rx}x{ry}x{rz}) -> {out_path} ({os.path.getsize(out_path)} bytes)")
