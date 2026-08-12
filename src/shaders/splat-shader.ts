const vertexShader = /* glsl*/`
#include "gsplatCommonVS"

uniform sampler2D splatState;

uniform vec4 selectedClr;
uniform vec4 lockedClr;

uniform vec3 clrOffset;
uniform vec4 clrScale;

varying mediump vec4 texCoord_flags;            // xy: texCoord, z: selected, w: locked
varying mediump vec4 color;
varying mediump float vDeleted;                  // 1.0 if deleted-but-shown, 0.0 otherwise

// oriented crop-box clipping (SplatRoom)
uniform float uCropBoxEnabled;
uniform float uCropBoxPreview;
uniform float uCropBoxSoftEdge;
uniform mat4 uViewToBoxLocal;
varying highp vec3 vViewCenter;
varying highp vec2 vScreenOffset;
varying highp float vDepthRadius;
varying highp float vEllipE00;
varying highp float vEllipE01;
varying highp float vEllipE02;
varying highp float vEllipE11;
varying highp float vEllipE12;
varying highp float vEllipE22;

uniform float showDeleted;

// [DEBUG-ORTHO] placeholder — removed after investigation

#if PICK_PASS
    uniform uint pickOp;                        // 0: add, 1: remove, 2: set
    uniform int pickMode;                       // 0: pick id, 1: depth estimation
#endif

mediump vec4 discardVec = vec4(0.0, 0.0, 2.0, 1.0);

uniform float saturation;

vec3 applySaturation(vec3 color) {
    vec3 grey = vec3(dot(color, vec3(0.299, 0.587, 0.114)));
    return grey + (color - grey) * saturation;
}

void main(void) {
    // read gaussian details
    SplatSource source;
    if (!initSource(source)) {
        gl_Position = discardVec;
        return;
    }

    // get per-gaussian edit state, discard if deleted
    uint vertexState = uint(texelFetch(splatState, splat.uv, 0).r * 255.0 + 0.5) & 7u;

    #if PICK_PASS
        if (pickOp == 0u) {
            // add: skip locked and already-selected; skip deleted unless showDeleted
            if ((vertexState & 2u) != 0u || (vertexState & 1u) != 0u) {
                gl_Position = discardVec;
                return;
            }
            if ((vertexState & 4u) != 0u && showDeleted < 0.5) {
                gl_Position = discardVec;
                return;
            }
        } else if (pickOp == 1u) {
            // remove: pick selected splats (skip locked and unselected)
            if ((vertexState & 2u) != 0u || (vertexState & 1u) == 0u) {
                gl_Position = discardVec;
                return;
            }
        } else {
            // set: skip locked; skip deleted unless showDeleted
            if ((vertexState & 2u) != 0u) {
                gl_Position = discardVec;
                return;
            }
            if ((vertexState & 4u) != 0u && showDeleted < 0.5) {
                gl_Position = discardVec;
                return;
            }
        }
    #else
        // skip deleted splats (unless showDeleted is enabled)
        vDeleted = 0.0;
        if ((vertexState & 4u) != 0u) {
            if (showDeleted < 0.5) {
                gl_Position = discardVec;
                return;
            }
            vDeleted = 1.0;
        }
    #endif

    // get center
    vec3 modelCenter = getCenter();

    SplatCenter center;
    center.modelCenterOriginal = modelCenter;
    center.modelCenterModified = modelCenter;
    if (!initCenter(modelCenter, center)) {
        gl_Position = discardVec;
        return;
    }

    SplatCorner corner;
    if (!initCorner(source, center, corner)) {
        gl_Position = discardVec;
        return;
    }

    gl_Position = center.proj + vec4(corner.offset, 0.0);

    // Safety net for exact axis-aligned ortho views (azim 0/90/180/270 with
    // elev 0). The engine's initCornerCov normalizes the screen-space covariance
    // diagonal, which produces NaN for splats whose on-screen covariance has
    // zero off-diagonal and degenerate lambda1 vs diagonal1 at those exact
    // angles. NaN corner.offset then puts gl_Position outside clip space and
    // the entire model silently disappears. Fall back to a tiny constant
    // offset (a few pixels) so the splat still renders while the engine bug
    // is investigated upstream. The SAME safe offset must also feed the
    // crop-box varyings below — otherwise NaN propagates to the fragment
    // shader (cropFade = smoothstep(NaN)) and the model disappears again
    // whenever the crop box is active.
    vec2 safeOffset = corner.offset.xy;
    if (any(isnan(corner.offset)) || any(isinf(corner.offset))) {
        safeOffset = source.cornerUV * 0.02;
        gl_Position = vec4(center.proj.xy + safeOffset, center.proj.z, 1.0);
    }

    // crop-box vertex data for per-fragment clipping
    if (uCropBoxEnabled > 0.5) {
        vViewCenter = center.view;
        vec4 clipPos = center.proj + vec4(safeOffset, 0.0, 0.0);
        vec3 ndc = clipPos.xyz / clipPos.w;

        // Reconstruct the fragment's view-space position (absolute, same units
        // as center.view — the fragment uses vScreenOffset directly as
        // viewPos.xy). Derive the view-space offset from the splat center as
        //   offset = safeOffset * depthFactor / (clipPos.w * M)
        // where safeOffset is the clip-space offset we added to gl_Position,
        // depthFactor is -viewZ for perspective (the Jacobian scales
        // screen-space offsets by view-z) or 1 for orthographic, and
        // clipPos.w * M[0][0] inverts the linear part of the projection.
        // Adding vViewCenter once gives the absolute fragment view-space xy.
        //
        // The legacy code used ndc * (-viewZ) / M as a single expression. That
        // expression algebraically equals centerView + safeOffset*(-viewZ)/
        // (w*M), which is only correct for perspective: for orthographic the
        // -viewZ factor is wrong (ortho has no view-z Jacobian) and the
        // expression drops to a length quantity that does not match the
        // view-space units of vViewCenter.z — fragments then map to box-local
        // coords far outside ±0.5 and the crop shader discards the splat.
        vec2 viewSpaceXY = safeOffset.xy *
                           ((camera_params.w == 1.0) ? 1.0 : (-center.view.z)) /
                           (clipPos.w * vec2(matrix_projection[0][0], matrix_projection[1][1]));
        vScreenOffset = vViewCenter.xy + viewSpaceXY;
        vec4 rotYZWX = getRotation().yzwx;
        mat3 rotMat = quatToMat3(rotYZWX);
        vec3 splatScale = getScale();
        mat4 worldMat = applyPaletteTransform(matrix_model);
        vec3 axis0 = splatScale.x * (worldMat * vec4(rotMat[0], 0.0)).xyz;
        vec3 axis1 = splatScale.y * (worldMat * vec4(rotMat[1], 0.0)).xyz;
        vec3 axis2 = splatScale.z * (worldMat * vec4(rotMat[2], 0.0)).xyz;
        mat3 viewRot = transpose(mat3(matrix_view));
        vec3 viewDir = viewRot[2];
        float d0 = dot(axis0, viewDir);
        float d1 = dot(axis1, viewDir);
        float d2 = dot(axis2, viewDir);
        vDepthRadius = 3.0 * sqrt(d0*d0 + d1*d1 + d2*d2);
        mat3 viewMat = mat3(matrix_view);
        mat3 M = viewMat * rotMat;
        float a0 = splatScale.x, a1 = splatScale.y, a2 = splatScale.z;
        float invA0 = 1.0 / max(a0*a0, 1e-8);
        float invA1 = 1.0 / max(a1*a1, 1e-8);
        float invA2 = 1.0 / max(a2*a2, 1e-8);
        vEllipE00 = M[0][0]*M[0][0]*invA0 + M[0][1]*M[0][1]*invA1 + M[0][2]*M[0][2]*invA2;
        vEllipE01 = M[0][0]*M[1][0]*invA0 + M[0][1]*M[1][1]*invA1 + M[0][2]*M[1][2]*invA2;
        vEllipE02 = M[0][0]*M[2][0]*invA0 + M[0][1]*M[2][1]*invA1 + M[0][2]*M[2][2]*invA2;
        vEllipE11 = M[1][0]*M[1][0]*invA0 + M[1][1]*M[1][1]*invA1 + M[1][2]*M[1][2]*invA2;
        vEllipE12 = M[1][0]*M[2][0]*invA0 + M[1][1]*M[2][1]*invA1 + M[1][2]*M[2][2]*invA2;
        vEllipE22 = M[2][0]*M[2][0]*invA0 + M[2][1]*M[2][1]*invA1 + M[2][2]*M[2][2]*invA2;
    } else {
        vViewCenter = vec3(0.0);
        vScreenOffset = vec2(0.0);
        vDepthRadius = 0.0;
        vEllipE00 = 0.0; vEllipE01 = 0.0; vEllipE02 = 0.0;
        vEllipE11 = 0.0; vEllipE12 = 0.0; vEllipE22 = 0.0;
    }

    // store texture coord and locked state
    texCoord_flags = vec4(
        corner.uv,
        (vertexState & 1u) != 0u ? 1.0 : 0.0,       // selected
        (vertexState & 2u) != 0u ? 1.0 : 0.0        // locked
    );

    #if PICK_PASS
        if (pickMode == 1) {
            // depth estimation mode: compute normalized depth in vertex shader
            float linearDepth = -center.view.z;
            float normalizedDepth = (linearDepth - camera_params.z) / (camera_params.y - camera_params.z);
            vec4 clr = getColor();
            color = vec4(normalizedDepth, 0.0, 0.0, 1.0) * clr.a;
        } else {
            // pick id
            uvec4 bits = (uvec4(splat.index) >> uvec4(0u, 8u, 16u, 24u)) & uvec4(255u);
            color = vec4(bits) / 255.0;
        }
    // handle splat color
    #elif FORWARD_PASS
        // read color
        color = getColor();

        // evaluate spherical harmonics
        #if SH_BANDS > 0
        // calculate the model-space view direction
            vec3 dir = normalize(center.view * mat3(center.modelView));

            // read sh coefficients
            vec3 sh[SH_COEFFS];
            float scale;
            readSHData(sh, scale);

            // evaluate
            color.xyz += evalSH(sh, dir) * scale;
        #endif

        // apply tint/brightness
        color = color * clrScale + vec4(clrOffset, 0.0);

        // apply saturation
        color.xyz = applySaturation(color.xyz);

        // don't allow out-of-range alpha
        color.a = clamp(color.a, 0.0, 1.0);

        // apply tonemapping
        color = vec4(prepareOutputFromGamma(max(color.xyz, 0.0), -center.view.z), color.w);

        // apply locked/selected colors
        if ((vertexState & 2u) != 0u) {
            // locked
            color *= lockedClr;
        } else if ((vertexState & 1u) != 0u) {
            // selected
            color.xyz = mix(color.xyz, selectedClr.xyz, selectedClr.a);
        }
    #endif
}
`;

const fragmentShader = /* glsl*/`
varying mediump vec4 texCoord_flags;
varying mediump vec4 color;
varying mediump float vDeleted;

uniform bool outlineMode;
uniform float ringSize;
uniform float highlights;
uniform float shadows;
uniform float contrast;

// HSL per-channel uniforms (8 zones packed into 2 vec4s each)
// A = [R, O, Y, G], B = [A, B, P, M]
uniform vec4 hslHueA;
uniform vec4 hslHueB;
uniform vec4 hslSatA;
uniform vec4 hslSatB;
uniform vec4 hslLumA;
uniform vec4 hslLumB;

#if PICK_PASS
    uniform int pickMode;           // 0: id, 1: depth estimation
#endif

const float EXP4 = exp(-4.0);
const float INV_EXP4 = 1.0 / (1.0 - EXP4);

float normExp(float x) {
    return (exp(x * -4.0) - EXP4) * INV_EXP4;
}

vec3 applyHighlights(vec3 c) {
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    float mask = smoothstep(0.4, 0.8, lum);
    return c + c * mask * highlights * 0.5;
}

vec3 applyShadows(vec3 c) {
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    float mask = 1.0 - smoothstep(0.2, 0.5, lum);
    return c + c * mask * shadows * 0.5;
}

vec3 applyContrast(vec3 c) {
    return (c - 0.5) * (1.0 + contrast) + 0.5;
}

// ---- Per-channel HSL (Lightroom-style) ----

// Zone centers in [0,1] hue space (degrees / 360)
const float ZC_RED     = 0.0;
const float ZC_ORANGE  = 30.0 / 360.0;
const float ZC_YELLOW  = 60.0 / 360.0;
const float ZC_GREEN   = 120.0 / 360.0;
const float ZC_AQUA    = 180.0 / 360.0;
const float ZC_BLUE    = 225.0 / 360.0;
const float ZC_PURPLE  = 270.0 / 360.0;
const float ZC_MAGENTA = 315.0 / 360.0;

float hueDistance(float h1, float h2) {
    float d = abs(h1 - h2);
    return min(d, 1.0 - d);
}

float zoneWeight(float hue, float center) {
    float d = hueDistance(hue, center);
    return 1.0 - smoothstep(15.0 / 360.0, 45.0 / 360.0, d);
}

vec3 rgb2hsl(vec3 c) {
    float maxC = max(c.r, max(c.g, c.b));
    float minC = min(c.r, min(c.g, c.b));
    float l = (maxC + minC) * 0.5;
    float d = maxC - minC;
    float h = 0.0;
    float s = 0.0;
    if (d > 0.0001) {
        if (maxC == c.r) {
            h = mod((c.g - c.b) / d, 6.0) / 6.0;
        } else if (maxC == c.g) {
            h = ((c.b - c.r) / d + 2.0) / 6.0;
        } else {
            h = ((c.r - c.g) / d + 4.0) / 6.0;
        }
        s = d / (1.0 - abs(2.0 * l - 1.0) + 0.0001);
    }
    return vec3(h, s, l);
}

float hue2rgb(float p, float q, float t) {
    if (t < 0.0) t += 1.0;
    if (t > 1.0) t -= 1.0;
    if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
    if (t < 0.5) return q;
    if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    return p;
}

vec3 hsl2rgb(float h, float s, float l) {
    if (s < 0.0001) return vec3(l);
    float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
    float p = 2.0 * l - q;
    return vec3(
        hue2rgb(p, q, h + 1.0 / 3.0),
        hue2rgb(p, q, h),
        hue2rgb(p, q, h - 1.0 / 3.0)
    );
}

vec3 applyPerChannelHSL(vec3 c) {
    // Early-out: skip if all adjustments are zero
    vec4 sum = hslHueA + hslHueB + hslSatA + hslSatB + hslLumA + hslLumB;
    if (dot(sum, sum) < 0.0001) return c;

    c = clamp(c, 0.0, 1.0);
    vec3 hsl = rgb2hsl(c);
    float h = hsl.x;
    float s = hsl.y;
    float l = hsl.z;

    float totalHue = 0.0;
    float totalSat = 0.0;
    float totalLum = 0.0;
    float totalW = 0.0;

    // Unrolled 8 zones
    float w;
    w = zoneWeight(h, ZC_RED);     totalHue += w * hslHueA.x; totalSat += w * hslSatA.x; totalLum += w * hslLumA.x; totalW += w;
    w = zoneWeight(h, ZC_ORANGE);  totalHue += w * hslHueA.y; totalSat += w * hslSatA.y; totalLum += w * hslLumA.y; totalW += w;
    w = zoneWeight(h, ZC_YELLOW);  totalHue += w * hslHueA.z; totalSat += w * hslSatA.z; totalLum += w * hslLumA.z; totalW += w;
    w = zoneWeight(h, ZC_GREEN);   totalHue += w * hslHueA.w; totalSat += w * hslSatA.w; totalLum += w * hslLumA.w; totalW += w;
    w = zoneWeight(h, ZC_AQUA);    totalHue += w * hslHueB.x; totalSat += w * hslSatB.x; totalLum += w * hslLumB.x; totalW += w;
    w = zoneWeight(h, ZC_BLUE);    totalHue += w * hslHueB.y; totalSat += w * hslSatB.y; totalLum += w * hslLumB.y; totalW += w;
    w = zoneWeight(h, ZC_PURPLE);  totalHue += w * hslHueB.z; totalSat += w * hslSatB.z; totalLum += w * hslLumB.z; totalW += w;
    w = zoneWeight(h, ZC_MAGENTA); totalHue += w * hslHueB.w; totalSat += w * hslSatB.w; totalLum += w * hslLumB.w; totalW += w;

    if (totalW > 0.0001) {
        h = mod(h + totalHue / totalW * 0.5 + 1.0, 1.0);
        s = clamp(s + totalSat / totalW, 0.0, 1.0);
        l = clamp(l + totalLum / totalW * 0.5, 0.0, 1.0);
    }

    return hsl2rgb(h, s, l);
}

// oriented crop-box clipping uniforms & varyings (SplatRoom)
uniform float uCropBoxEnabled;
uniform float uCropBoxPreview;
uniform float uCropBoxSoftEdge;
uniform mat4 uViewToBoxLocal;
// clip shape: 0 = box, 1 = cylinder (local Y axis), 2 = sphere.
// radiusX/radiusY/radiusZ are the LOCAL-space radii (0.5 = box half-width).
// cylinder: elliptic section (rx, rz), height independent. sphere: triaxial
// ellipsoid (rx, ry, rz).
uniform float uCropBoxShape;
uniform float uCropBoxRadiusX;
uniform float uCropBoxRadiusY;
uniform float uCropBoxRadiusZ;
uniform float uCropBoxHeight;
// 切面（cap plane）：形状外紧贴表面的高斯片元组成切面，让裁切得到实心
// 截面（主视图与导出共用此 shader，行为一致）。capWidth 为盒 local 空间宽度
//（0.5=半盒）。**不**覆盖颜色 —— 切面用被切高斯本色走后续颜色分级管线。
// capAlpha 是切面片元的 alpha 缩放（<1 让切面"轻"些、避免过厚）。
uniform float uCropBoxCapWidth;
uniform float uCropBoxCapAlpha;
uniform vec4 uCropBoxCapColor;        // 保留以兼容 UI 序列化；当前 shader 不用其 RGB
varying highp vec3 vViewCenter;
varying highp vec2 vScreenOffset;
varying highp float vDepthRadius;
varying highp float vEllipE00;
varying highp float vEllipE01;
varying highp float vEllipE02;
varying highp float vEllipE11;
varying highp float vEllipE12;
varying highp float vEllipE22;

void main(void) {
    mediump float A = dot(texCoord_flags.xy, texCoord_flags.xy);

    if (A > 1.0) {
        discard;
    }

    // crop-box per-fragment clipping
    mediump float cropFade = 1.0;
    vec3 finalColor = color.xyz;    // declared here so the cap-plane branch can repaint it
    if (uCropBoxEnabled > 0.5) {
        vec2 dxy = vScreenOffset - vViewCenter.xy;
        float A_coeff = vEllipE22;
        float B_coeff = 2.0 * (vEllipE02 * dxy.x + vEllipE12 * dxy.y);
        float C_coeff = vEllipE00*dxy.x*dxy.x + vEllipE11*dxy.y*dxy.y + 2.0*vEllipE01*dxy.x*dxy.y - 1.0;
        float disc = B_coeff*B_coeff - 4.0*A_coeff*C_coeff;
        float depthOffset;
        if (disc >= 0.0 && A_coeff > 1e-8) {
            depthOffset = (-B_coeff + sqrt(disc)) / (2.0 * A_coeff);
        } else {
            vec2 uv = texCoord_flags.xy;
            float r2 = dot(uv, uv);
            depthOffset = sqrt(max(0.0, 1.0 - r2)) * vDepthRadius;
        }
        vec3 viewPos;
        viewPos.xy = vScreenOffset;
        viewPos.z = vViewCenter.z + depthOffset;
        vec3 localPos = (uViewToBoxLocal * vec4(viewPos, 1.0)).xyz;
        // 到裁剪形状边界的距离（>0 在形状内，<0 在形状外）——统一判据，
        // 支持 box / cylinder（local Y 轴，可椭圆截面）/ sphere（可椭球）三种形状。
        // 椭圆用归一化半径方程 s = sqrt((x/rx)^2 + (y/ry)^2 + (z/rz)^2)，s<=1 在内；
        // dist 近似 = (1 - s) * rmin（边界处为 0，软边/cap 宽度按 rmin 缩放）。
        float dist;
        if (uCropBoxShape > 1.5) {
            // triaxial ellipsoid: radii (rx, ry, rz)
            float rx = max(uCropBoxRadiusX, 1e-4);
            float ry = max(uCropBoxRadiusY, 1e-4);
            float rz = max(uCropBoxRadiusZ, 1e-4);
            vec3 q = vec3(localPos.x / rx, localPos.y / ry, localPos.z / rz);
            float s = length(q);
            dist = (1.0 - s) * min(min(rx, ry), rz);
        } else if (uCropBoxShape > 0.5) {
            // elliptic cylinder along local Y: (x/rx)^2 + (z/rz)^2 <= 1, |y| <= h/2
            float rx = max(uCropBoxRadiusX, 1e-4);
            float rz = max(uCropBoxRadiusZ, 1e-4);
            vec2 q = vec2(localPos.x / rx, localPos.z / rz);
            float s = length(q);
            dist = min((1.0 - s) * min(rx, rz), uCropBoxHeight * 0.5 - abs(localPos.y));
        } else {
            // box
            vec3 ad = abs(localPos);
            float maxD = max(max(ad.x, ad.y), ad.z);
            dist = 0.5 - maxD;
        }
        if (dist < 0.0) {
            #if PICK_PASS
                discard;
            #else
                if (uCropBoxPreview > 0.5) {
                    cropFade = 0.035;
                } else {
                    // 切面（cap plane）：形状外紧贴表面的片元组成切面；保留被切
                    // 高斯本色走颜色分级管线（finalColor 不覆盖）。只有椭球穿过
                    // 形状表面的高斯会贡献片元 → 切面由模型本色形成。
                    float capW = max(uCropBoxCapWidth, 0.0);
                    if (capW > 0.0 && dist > -capW) {
                        // 软边 + capAlpha 缩放避免切面过厚
                        cropFade = smoothstep(-capW, 0.0, dist) * uCropBoxCapAlpha;
                    } else {
                        discard;
                    }
                }
            #endif
        } else {
            float softEdge = max(uCropBoxSoftEdge, 0.0005);
            cropFade = smoothstep(0.0, softEdge, dist);
        }
    }

    #if PICK_PASS
        if (pickMode == 1) {
            // depth estimation
            mediump float alpha = normExp(A);
            if (alpha < 1.0 / 255.0) {
                discard;
            }
            // we should multiply by alpha here to take into account gaussian falloff,
            // but it results in less accurate depth for some reason
            gl_FragColor = color * alpha;
        } else {
            // pick id
            gl_FragColor = color;
        }
    #else
        mediump float norm = normExp(A);
        mediump float alpha = norm * color.a;

        finalColor = applyHighlights(finalColor);
        finalColor = applyShadows(finalColor);
        finalColor = applyContrast(finalColor);
        finalColor = applyPerChannelHSL(finalColor);

        // apply deleted point visual (red tint, reduced opacity)
        if (vDeleted > 0.5) {
            finalColor = mix(finalColor, vec3(1.0, 0.25, 0.25), 0.6);
            alpha *= 0.4;
        }

        // apply crop-box fade
        alpha *= cropFade;

        if (texCoord_flags.w == 0.0 && ringSize > 0.0) {
            // rings mode
            if (A < 1.0 - ringSize) {
                alpha = max(0.05, alpha);
            } else {
                alpha = 0.6;
            }
        }

        bool selected = texCoord_flags.z != 0.0 && texCoord_flags.w == 0.0;

        if (outlineMode) {
            pcFragColor0 = vec4(finalColor * alpha, alpha);
            pcFragColor1 = vec4(0.0, 0.0, 0.0, selected ? norm : 0.0);
        } else {
            if (selected) {
                pcFragColor0 = vec4(finalColor * alpha * 0.8, alpha);
                pcFragColor1 = vec4(finalColor * alpha * 0.2, alpha);
            } else {
                pcFragColor0 = vec4(finalColor * alpha, alpha);
                pcFragColor1 = vec4(0.0, 0.0, 0.0, 0.0);
            }
        }
    #endif
}
`;

const gsplatCenter = /* glsl*/`
uniform highp usampler2D splatTransform;        // per-splat index into transform palette
uniform sampler2D transformPalette;             // palette of transform matrices

mat4 applyPaletteTransform(mat4 model) {
    uint transformIndex = texelFetch(splatTransform, splat.uv, 0).r;
    if (transformIndex == 0u) {
        return model;
    }

    // read transform matrix
    int u = int(transformIndex % 512u) * 3;
    int v = int(transformIndex / 512u);

    mat4 t;
    t[0] = texelFetch(transformPalette, ivec2(u, v), 0);
    t[1] = texelFetch(transformPalette, ivec2(u + 1, v), 0);
    t[2] = texelFetch(transformPalette, ivec2(u + 2, v), 0);
    t[3] = vec4(0.0, 0.0, 0.0, 1.0);

    return model * transpose(t);
}

uniform mat4 matrix_model;
uniform mat4 matrix_view;
#ifndef GSPLAT_CENTER_NOPROJ
    uniform vec4 camera_params;             // 1 / far, far, near, isOrtho
    uniform mat4 matrix_projection;
#endif

// project the model space gaussian center to view and clip space
bool initCenter(vec3 modelCenter, inout SplatCenter center) {
    mat4 modelView = matrix_view * applyPaletteTransform(matrix_model);
    vec4 centerView = modelView * vec4(modelCenter, 1.0);

    #ifndef GSPLAT_CENTER_NOPROJ

        // early out if splat is behind the camera (perspective only)
        // orthographic projections don't need this check as frustum culling handles it
        if (camera_params.w != 1.0 && centerView.z > 0.0) {
            return false;
        }

        vec4 centerProj = matrix_projection * centerView;

        // ensure gaussians are not clipped by camera near and far
        #if WEBGPU
            centerProj.z = clamp(centerProj.z, 0, abs(centerProj.w));
        #else
            centerProj.z = clamp(centerProj.z, -abs(centerProj.w), abs(centerProj.w));
        #endif

        center.proj = centerProj;
        center.projMat00 = matrix_projection[0][0];

    #endif

    center.view = centerView.xyz / centerView.w;
    center.modelView = modelView;
    return true;
}
`;

export { vertexShader, fragmentShader, gsplatCenter };
