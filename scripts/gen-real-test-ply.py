#!/usr/bin/env python3
"""Generate a realistic-ish 3DGS .ply with several distinct colored objects
so the SAM 2D->3D segmentation can be validated on a 'real' model.

Objects: a red ball, a blue box, a green torus-ish ring, plus a scattered
grey "background" cloud. Adjustable total gaussian count via --n.
"""
import argparse, struct, math, random

def gaussian_blob(cx, cy, cz, rx, ry, rz, n, color, jitter=0.02):
    pts = []
    for _ in range(n):
        # random point inside an ellipsoid
        u = random.random(); v = random.random(); w = random.random()
        r = (u*v*w) ** (1/3)
        th = random.uniform(0, 2*math.pi)
        ph = math.acos(2*random.random()-1)
        x = cx + rx * r * math.sin(ph) * math.cos(th) + random.gauss(0,jitter)
        y = cy + ry * r * math.sin(ph) * math.sin(th) + random.gauss(0,jitter)
        z = cz + rz * r * math.cos(ph) + random.gauss(0,jitter)
        pts.append((x,y,z,color))
    return pts

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--n', type=int, default=200000)
    ap.add_argument('--out', default='scripts/real-test.ply')
    args = ap.parse_args()
    random.seed(7)

    pts = []
    # red ball (object 1)
    pts += gaussian_blob(-1.4, 0.2, 0.3, 0.55, 0.55, 0.55, int(args.n*0.15), (0.9,0.15,0.12))
    # blue box (object 2)
    pts += gaussian_blob(1.3, -0.1, 0.2, 0.7, 0.5, 0.4, int(args.n*0.18), (0.12,0.25,0.9))
    # green ring (object 3)
    ring = []
    R=0.9; T=0.12; m=int(args.n*0.17)
    for _ in range(m):
        a = random.uniform(0,2*math.pi)
        rr = R + random.gauss(0,T)
        x = 0.0 + rr*math.cos(a)
        y = 1.4 + rr*math.sin(a)
        z = -0.6 + random.gauss(0,T)
        ring.append((x,y,z,(0.15,0.85,0.3)))
    pts += ring
    # background scattered cloud (grey), fills the volume
    bg = []
    mb = args.n - len(pts)
    for _ in range(mb):
        x = random.uniform(-3,3)
        y = random.uniform(-2,2.2)
        z = random.uniform(-2.5,2.5)
        g = random.uniform(0.35,0.6)
        bg.append((x,y,z,(g,g,g*1.02)))
    pts += bg

    N = len(pts)
    # header
    props = [
        'x','y','z','nx','ny','nz',
        'f_dc_0','f_dc_1','f_dc_2','opacity',
        'scale_0','scale_1','scale_2',
        'rot_0','rot_1','rot_2','rot_3'
    ]
    header = "ply\nformat binary_little_endian 1.0\n"
    header += f"element vertex {N}\n"
    for p in props:
        header += f"property float {p}\n"
    header += "end_header\n"

    bbox = bytearray()
    for (x,y,z,c) in pts:
        bbox += struct.pack('<fff', x,y,z)
        bbox += struct.pack('<fff', 0.0, 0.0, 0.0)  # normals placeholder (nx,ny,nz)
        # SH C0: rgb = c; dc = (rgb-0.5)/0.28209
        SH=0.28209479177387814
        bbox += struct.pack('<fff', (c[0]-0.5)/SH, (c[1]-0.5)/SH, (c[2]-0.5)/SH)
        bbox += struct.pack('<f', 1.5)  # logit opacity ~ 0.82
        # scales ~ 0.03
        bbox += struct.pack('<fff', math.log(0.03), math.log(0.03), math.log(0.03))
        # rotation identity (w=1)
        bbox += struct.pack('<ffff', 1.0, 0.0, 0.0, 0.0)

    with open(args.out,'wb') as f:
        f.write(header.encode('ascii'))
        f.write(bbox)
    print(f'wrote {N} gaussians -> {args.out}')

if __name__ == '__main__':
    main()
