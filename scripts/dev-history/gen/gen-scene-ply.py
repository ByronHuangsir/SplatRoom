#!/usr/bin/env python3
"""Multi-object scene for the segmentation lab: a big rainbow sphere
(background) + 3 isolated small spheres far enough apart that region
growing cannot bridge them. Clicking one small sphere should select ONLY
it, giving an obvious visual difference when the rest is faded/hidden.
"""
import math
import os
import random
import struct
import sys

random.seed(99)

SH_C0 = 0.28209479177387814
N_SPHERE = 3000          # main body
OBJS = [                 # (count, radius, center, color)
    (400, 0.28, (1.35, 0.25, 1.15),  (0.90, 0.15, 0.12)),   # red   front-right
    (400, 0.24, (-1.30, -0.15, 1.05), (0.12, 0.55, 0.95)),   # blue  front-left
    (350, 0.32, (0.10, 1.35, 0.60),   (0.20, 0.80, 0.30)),   # green top
]


def dc_encode(v):
    return (v - 0.5) / SH_C0


def logit(p):
    p = max(1e-6, min(1 - 1e-6, p))
    return math.log(p / (1 - p))


def hsl_color(i, n):
    h = (i / max(1, n)) * 360.0
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
    return tuple(max(0.02, min(0.98, v)) for v in rgb)


out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'seg-lab', 'scene.ply')

positions, normals, colors, opacities, scales, rotations = [], [], [], [], [], []

# ---- main sphere (rainbow) ----
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
    rgb = hsl_color(i, N_SPHERE)
    colors.append((dc_encode(rgb[0]), dc_encode(rgb[1]), dc_encode(rgb[2])))
    opacities.append(logit(0.92))
    s = random.uniform(0.012, 0.035)
    scales.append((math.log(s), math.log(s), math.log(s)))
    rotations.append((1.0, 0.0, 0.0, 0.0))

# ---- isolated objects ----
for (cnt, radius, center, color) in OBJS:
    cx, cy, cz = center
    for i in range(cnt):
        # fibonacci on a sphere of `radius`
        golden = math.pi * (3.0 - math.sqrt(5.0))
        yy = 1.0 - (i / max(1, cnt - 1)) * 2.0
        rr = math.sqrt(max(0.0, 1.0 - yy * yy))
        tt = golden * i
        jx = math.cos(tt) * rr
        jz = math.sin(tt) * rr
        jr = radius * (0.7 + 0.3 * random.random())
        positions.append((cx + jx * jr, cy + yy * jr, cz + jz * jr))
        normals.append((0.0, 0.0, 1.0))
        colors.append((dc_encode(color[0]), dc_encode(color[1]), dc_encode(color[2])))
        opacities.append(logit(0.92))
        s = random.uniform(0.01, 0.026)
        scales.append((math.log(s), math.log(s), math.log(s)))
        rotations.append((1.0, 0.0, 0.0, 0.0))

N = len(positions)

header = f"""ply
format binary_little_endian 1.0
comment generated multi-object segmentation scene
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

print(f"wrote {N} splats (sphere {N_SPHERE} + {sum(o[0] for o in OBJS)} objects) -> {out_path}")
