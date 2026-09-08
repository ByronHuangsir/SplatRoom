#!/usr/bin/env python3
"""Sphere + GIANT FLAT PANCAKE gaussians.

Pancakes: scale (0.4, 0.05, 0.05) — long axis 0.4 in the tangent plane,
thin 0.05 along the surface normal. 20x larger than the 0.02 local surface
gaussians. The OLD split criterion used only the middle axis (~0.05) for the
footprint → underestimated needed copies by ~8x → see-through persisted.
New criterion uses the full tangent-plane ellipse (tA x tB) → dense coverage.
"""
import math
import os
import random
import struct
import sys

random.seed(11)

SH_C0 = 0.28209479177387814
N_SPHERE = 4000
N_PANCAKE = 6


def dc_encode(v):
    return (v - 0.5) / SH_C0


def logit(p):
    p = max(1e-6, min(1 - 1e-6, p))
    return math.log(p / (1 - p))


def quat_from_axes(x_axis, y_axis, z_axis):
    """Rotation matrix R = [x|y|z] (columns) -> quaternion (w,x,y,z)."""
    m00, m10, m20 = x_axis
    m01, m11, m21 = y_axis
    m02, m12, m22 = z_axis
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
    return (w, x, y, z)


out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'dist', 'test-flat.ply')

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

# ---- giant flat pancakes (long axis 0.4 in tangent plane, thin 0.05 normal) ----
for i in range(N_PANCAKE):
    # random point on sphere
    th = math.acos(random.uniform(-1, 1))
    ph = random.uniform(0.0, 2.0 * math.pi)
    n = (math.sin(th) * math.cos(ph), math.cos(th), math.sin(th) * math.sin(ph))
    r = 0.92 + 0.03 * random.random()
    positions.append((n[0] * r, n[1] * r, n[2] * r))
    normals.append(n)

    rgb = (0.1, 0.6, 1.0)  # bright blue pancakes — visually distinct
    colors.append((dc_encode(rgb[0]), dc_encode(rgb[1]), dc_encode(rgb[2])))

    opacities.append(logit(0.9))

    # local x = long axis in tangent plane, local z = surface normal
    t1 = (n[1], -n[0], 0.0)
    ln = math.sqrt(t1[0]**2 + t1[1]**2 + t1[2]**2)
    if ln < 1e-6:
        t1 = (1.0, 0.0, 0.0)
    else:
        t1 = (t1[0] / ln, t1[1] / ln, t1[2] / ln)
    t2 = (n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0])
    q = quat_from_axes(t1, t2, n)
    rotations.append(q)

    # long axis 0.4 (20x surface), thin 0.05
    scales.append((math.log(0.4), math.log(0.05), math.log(0.05)))

N = N_SPHERE + N_PANCAKE

header = f"""ply
format binary_little_endian 1.0
comment generated sphere + giant flat pancakes
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

print(f"wrote {N} splats ({N_SPHERE} sphere + {N_PANCAKE} pancakes) -> {out_path} ({os.path.getsize(out_path)} bytes)")
