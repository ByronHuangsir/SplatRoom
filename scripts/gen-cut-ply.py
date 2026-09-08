#!/usr/bin/env python3
"""Comprehensive test: sphere shell + interior volumetric gaussians +
spherical bumps + oversized shards + overflat pancakes.

Verifies the three new Level-1 behaviours:
  1. Splitting happens ONLY on the surface (interior volume gaussians are
     compressed, never split).
  2. Protruding spherical bumps get flattened first, then split.
  3. Oversized / overflat / over-angled gaussians are CUT (deleted).
"""
import math
import os
import random
import struct
import sys

random.seed(21)

SH_C0 = 0.28209479177387814
N_SPHERE = 4000
N_INTERIOR = 300
N_BUMP = 18
N_SHARD = 3
N_PANCAKE = 3


def dc_encode(v):
    return (v - 0.5) / SH_C0


def logit(p):
    p = max(1e-6, min(1 - 1e-6, p))
    return math.log(p / (1 - p))


out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'dist', 'test-cut.ply')

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

# ---- interior volumetric gaussians (uniform in sphere, r<0.75) ----
for i in range(N_INTERIOR):
    th = math.acos(random.uniform(-1, 1))
    ph = random.uniform(0.0, 2.0 * math.pi)
    r = (random.uniform(0, 1) ** (1/3)) * 0.75
    positions.append((math.sin(th)*math.cos(ph)*r, math.cos(th)*r, math.sin(th)*math.sin(ph)*r))
    normals.append((0.0, 0.0, 1.0))
    colors.append((dc_encode(0.5), dc_encode(0.5), dc_encode(0.5)))
    opacities.append(logit(0.8))
    s = 0.05
    scales.append((math.log(s), math.log(s), math.log(s)))
    rotations.append((1.0, 0.0, 0.0, 0.0))

# ---- spherical bumps (few large spheres on the shell) ----
for i in range(N_BUMP):
    th = math.radians(random.uniform(0.0, 30.0))
    ph = random.uniform(0.0, 2.0 * math.pi)
    rr = 0.98 + random.uniform(0.1, 0.3)
    sx = math.sin(th) * math.cos(ph)
    sy = math.cos(th)
    sz = math.sin(th) * math.sin(ph)
    positions.append((sx * rr, sy * rr, sz * rr))
    normals.append((sx, sy, sz))
    colors.append((dc_encode(0.95), dc_encode(0.15), dc_encode(0.15)))
    opacities.append(logit(0.9))
    s = random.uniform(0.07, 0.11)
    scales.append((math.log(s), math.log(s), math.log(s)))
    rotations.append((1.0, 0.0, 0.0, 0.0))

# ---- oversized shards (outside the sphere but close enough not to blow up
#      the scene diagonal, which would dilute the absolute cut threshold) ----
for i in range(N_SHARD):
    positions.append((1.3 + i * 0.25, 0.9 + i * 0.2, 0.6))
    normals.append((0.0, 0.0, 1.0))
    colors.append((dc_encode(0.9), dc_encode(0.9), dc_encode(0.2)))
    opacities.append(logit(0.9))
    s = 0.4
    scales.append((math.log(s), math.log(s), math.log(s)))
    rotations.append((1.0, 0.0, 0.0, 0.0))

# ---- overflat pancakes (ultra-thin discs on the shell) ----
for i in range(N_PANCAKE):
    th = math.radians(random.uniform(50.0, 70.0))
    ph = random.uniform(0.0, 2.0 * math.pi)
    r = 0.95
    sx = math.sin(th) * math.cos(ph)
    sy = math.cos(th)
    sz = math.sin(th) * math.sin(ph)
    positions.append((sx * r, sy * r, sz * r))
    normals.append((sx, sy, sz))
    colors.append((dc_encode(0.2), dc_encode(0.9), dc_encode(0.2)))
    opacities.append(logit(0.9))
    # long axes lie in the tangent plane
    t1 = (sy, -sx, 0.0)
    ln = math.sqrt(t1[0]**2 + t1[1]**2)
    if ln < 1e-6:
        t1 = (1.0, 0.0, 0.0)
    else:
        t1 = (t1[0]/ln, t1[1]/ln, t1[2]/ln)
    t2 = (sy*t1[2]-sz*t1[1], sz*t1[0]-sx*t1[2], sx*t1[1]-sy*t1[0])
    # rotation matrix R = [t1 | t2 | n] -> quat
    m00, m10, m20 = t1
    m01, m11, m21 = t2
    m02, m12, m22 = (sx, sy, sz)
    tr = m00 + m11 + m22
    if tr > 0:
        s = 0.5 / math.sqrt(tr + 1.0)
        w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s
    elif m00 > m11 and m00 > m22:
        s = 2.0 * math.sqrt(1.0 + m00 - m11 - m22)
        w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s
    elif m11 > m22:
        s = 2.0 * math.sqrt(1.0 + m11 - m00 - m22)
        w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s
    else:
        s = 2.0 * math.sqrt(1.0 + m22 - m00 - m11)
        w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s
    rotations.append((w, x, y, z))
    scales.append((math.log(0.3), math.log(0.3), math.log(0.008)))

N = N_SPHERE + N_INTERIOR + N_BUMP + N_SHARD + N_PANCAKE

header = f"""ply
format binary_little_endian 1.0
comment generated comprehensive surface-refine test model
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
