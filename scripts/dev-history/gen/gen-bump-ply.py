#!/usr/bin/env python3
"""Generate a sphere + a prominent protrusion ("bump") 3DGS test model.

The bump is made of FEW LARGE gaussians sitting on the sphere surface —
exactly the case where flattening them without splitting leaves
see-through / holes. Used to verify the Level-1 split logic.
"""
import math
import os
import random
import struct
import sys

random.seed(7)

SH_C0 = 0.28209479177387814
N_SPHERE = 4000
N_BUMP = 180


def dc_encode(v):
    return (v - 0.5) / SH_C0


def logit(p):
    p = max(1e-6, min(1 - 1e-6, p))
    return math.log(p / (1 - p))


out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'dist', 'test-bump.ply')

positions, normals, colors, opacities, scales, rotations = [], [], [], [], [], []

# ---- sphere shell ----
for i in range(N_SPHERE):
    golden = math.pi * (3.0 - math.sqrt(5.0))
    y = 1.0 - (i / max(1, N_SPHERE - 1)) * 2.0
    rad = math.sqrt(max(0.0, 1.0 - y * y))
    theta = golden * i
    x = math.cos(theta) * rad
    z = math.sin(theta) * rad
    r = 0.85 + 0.15 * random.random()
    positions.append((x * r, y * r, z * r))
    normals.append((0.0, 0.0, 1.0))

    h = (i / N_SPHERE) * 360.0
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

# ---- bump: FEW LARGE gaussians protruding near the north pole ----
for i in range(N_BUMP):
    # polar cap: theta in [0, 22deg], random azimuth
    th = math.radians(random.uniform(0.0, 22.0))
    ph = random.uniform(0.0, 2.0 * math.pi)
    # protruding: radius extends 0.12 .. 0.42 beyond the shell
    rr = 0.98 + random.uniform(0.12, 0.42)
    sx = math.sin(th) * math.cos(ph)
    sy = math.cos(th)
    sz = math.sin(th) * math.sin(ph)
    positions.append((sx * rr, sy * rr, sz * rr))
    normals.append((sx, sy, sz))

    rgb = (0.95, 0.15, 0.15)  # bright red bump — visually distinct
    colors.append((dc_encode(rgb[0]), dc_encode(rgb[1]), dc_encode(rgb[2])))

    opacities.append(logit(0.9))
    s = random.uniform(0.07, 0.13)  # 3-15x the surface gaussians
    scales.append((math.log(s), math.log(s), math.log(s)))
    rotations.append((1.0, 0.0, 0.0, 0.0))

N = N_SPHERE + N_BUMP

header = f"""ply
format binary_little_endian 1.0
comment generated sphere + bump test model
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

print(f"wrote {N} splats ({N_SPHERE} sphere + {N_BUMP} bump) -> {out_path} ({os.path.getsize(out_path)} bytes)")
