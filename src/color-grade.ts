import { Color } from 'playcanvas';

const SH_C0 = 0.28209479177387814;

const dcDecode = (v: number) => v * SH_C0 + 0.5;
const dcEncode = (v: number) => (v - 0.5) / SH_C0;

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));
const invSigmoid = (v: number) => ((v <= 0) ? -400 : ((v >= 1) ? 400 : -Math.log(1 / v - 1)));

const smoothstep = (edge0: number, edge1: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
};

// ---- Per-channel HSL helpers (must match shader) ----

const ZONE_CENTERS = [0, 30 / 360, 60 / 360, 120 / 360, 180 / 360, 225 / 360, 270 / 360, 315 / 360];

const hueDistance = (h1: number, h2: number) => {
    const d = Math.abs(h1 - h2);
    return Math.min(d, 1 - d);
};

const zoneWeight = (hue: number, center: number) => {
    const d = hueDistance(hue, center);
    return 1 - smoothstep(15 / 360, 45 / 360, d);
};

const rgb2hsl = (r: number, g: number, b: number): [number, number, number] => {
    const maxC = Math.max(r, Math.max(g, b));
    const minC = Math.min(r, Math.min(g, b));
    const l = (maxC + minC) * 0.5;
    const d = maxC - minC;
    let h = 0, s = 0;
    if (d > 0.0001) {
        if (maxC === r) {
            h = (((g - b) / d) % 6) / 6;
        } else if (maxC === g) {
            h = ((b - r) / d + 2) / 6;
        } else {
            h = ((r - g) / d + 4) / 6;
        }
        s = d / (1 - Math.abs(2 * l - 1) + 0.0001);
    }
    if (h < 0) h += 1;
    return [h, s, l];
};

const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 0.5) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
};

const hsl2rgb = (h: number, s: number, l: number): [number, number, number] => {
    if (s < 0.0001) return [l, l, l];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
};

type GradeParams = {
    tintClr: Color,
    temperature: number,
    saturation: number,
    brightness: number,
    blackPoint: number,
    whitePoint: number,
    transparency: number,
    highlights?: number,
    shadows?: number,
    contrast?: number,
    colorGradeEnabled?: boolean,
    hslHue?: ArrayLike<number>,
    hslSat?: ArrayLike<number>,
    hslLum?: ArrayLike<number>
};

type RGB = { r: number, g: number, b: number };

class ColorGrade {
    private s: RGB;
    private offset: number;
    private saturation: number;
    private transparency: number;
    private highlights: number;
    private shadows: number;
    private contrast: number;
    private hslHue: number[];
    private hslSat: number[];
    private hslLum: number[];
    readonly hasTint: boolean;
    readonly hasHsl: boolean;

    constructor(p: GradeParams) {
        const enabled = p.colorGradeEnabled !== false;

        const denom = Math.max(0.001, p.whitePoint - p.blackPoint);
        const scale = 1 / denom;
        this.s = {
            r: scale * p.tintClr.r * (1 + p.temperature),
            g: scale * p.tintClr.g,
            b: scale * p.tintClr.b * (1 - p.temperature)
        };
        this.offset = -p.blackPoint + p.brightness;
        this.saturation = p.saturation;
        this.transparency = p.transparency;
        this.highlights = p.highlights ?? 0;
        this.shadows = p.shadows ?? 0;
        this.contrast = p.contrast ?? 0;
        this.hslHue = p.hslHue ? Array.from(p.hslHue) : [0, 0, 0, 0, 0, 0, 0, 0];
        this.hslSat = p.hslSat ? Array.from(p.hslSat) : [0, 0, 0, 0, 0, 0, 0, 0];
        this.hslLum = p.hslLum ? Array.from(p.hslLum) : [0, 0, 0, 0, 0, 0, 0, 0];

        this.hasTint = enabled && (
            !p.tintClr.equals(Color.WHITE) ||
            p.temperature !== 0 ||
            p.saturation !== 1 ||
            p.brightness !== 0 ||
            p.blackPoint !== 0 ||
            p.whitePoint !== 1 ||
            this.highlights !== 0 ||
            this.shadows !== 0 ||
            this.contrast !== 0
        );

        this.hasHsl = enabled && (
            this.hslHue.some(v => v !== 0) ||
            this.hslSat.some(v => v !== 0) ||
            this.hslLum.some(v => v !== 0)
        );
    }

    private apply(c: RGB, offset: number) {
        // scale + offset (tint / brightness / whitePoint / blackPoint)
        c.r = offset + c.r * this.s.r;
        c.g = offset + c.g * this.s.g;
        c.b = offset + c.b * this.s.b;

        // saturation (luma-based, matches vertex shader)
        const grey = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
        c.r = grey + (c.r - grey) * this.saturation;
        c.g = grey + (c.g - grey) * this.saturation;
        c.b = grey + (c.b - grey) * this.saturation;

        // highlights (smoothstep mask, matches fragment shader)
        if (this.highlights !== 0) {
            const lum = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
            const mask = smoothstep(0.4, 0.8, lum);
            c.r += c.r * mask * this.highlights * 0.5;
            c.g += c.g * mask * this.highlights * 0.5;
            c.b += c.b * mask * this.highlights * 0.5;
        }

        // shadows (smoothstep mask, matches fragment shader)
        if (this.shadows !== 0) {
            const lum = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
            const mask = 1 - smoothstep(0.2, 0.5, lum);
            c.r += c.r * mask * this.shadows * 0.5;
            c.g += c.g * mask * this.shadows * 0.5;
            c.b += c.b * mask * this.shadows * 0.5;
        }

        // contrast (around 0.5, matches fragment shader)
        if (this.contrast !== 0) {
            c.r = (c.r - 0.5) * (1 + this.contrast) + 0.5;
            c.g = (c.g - 0.5) * (1 + this.contrast) + 0.5;
            c.b = (c.b - 0.5) * (1 + this.contrast) + 0.5;
        }

        // per-channel HSL (matches fragment shader applyPerChannelHSL)
        if (this.hasHsl) {
            const r = Math.max(0, Math.min(1, c.r));
            const g = Math.max(0, Math.min(1, c.g));
            const b = Math.max(0, Math.min(1, c.b));
            const [h, s, l] = rgb2hsl(r, g, b);

            let totalHue = 0, totalSat = 0, totalLum = 0, totalW = 0;
            for (let i = 0; i < 8; i++) {
                const w = zoneWeight(h, ZONE_CENTERS[i]);
                totalHue += w * this.hslHue[i];
                totalSat += w * this.hslSat[i];
                totalLum += w * this.hslLum[i];
                totalW += w;
            }

            if (totalW > 0.0001) {
                const newH = ((h + (totalHue / totalW) * 0.5) % 1 + 1) % 1;
                const newS = Math.max(0, Math.min(1, s + totalSat / totalW));
                const newL = Math.max(0, Math.min(1, l + (totalLum / totalW) * 0.5));
                const [nr, ng, nb] = hsl2rgb(newH, newS, newL);
                c.r = nr;
                c.g = ng;
                c.b = nb;
            }
        }
    }

    applyDC(c: RGB) {
        this.apply(c, this.offset);
    }

    applySH(c: RGB) {
        this.apply(c, 0);
    }

    applyOpacity(o: number): number {
        return invSigmoid(sigmoid(o) * this.transparency);
    }

    applyAlpha(o: number): number {
        return sigmoid(o) * this.transparency;
    }
}

export { ColorGrade, dcDecode, dcEncode, sigmoid, invSigmoid, SH_C0 };
export type { GradeParams, RGB };
