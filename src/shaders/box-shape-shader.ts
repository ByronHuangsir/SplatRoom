const vertexShader = /* glsl */ `
    attribute vec3 vertex_position;

    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;

    void main() {
        gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0);
    }
`;

const fragmentShader = /* glsl */ `
    // ray-box intersection in box space
    bool intersectBox(out float t0, out float t1, out int axis0, out int axis1, vec3 pos, vec3 dir, vec3 boxCen, vec3 boxLen)
    {
        bvec3 validDir = notEqual(dir, vec3(0.0));
        vec3 absDir = abs(dir);
        vec3 signDir = sign(dir);
        vec3 m = vec3(
            validDir.x ? 1.0 / absDir.x : 0.0,
            validDir.y ? 1.0 / absDir.y : 0.0,
            validDir.z ? 1.0 / absDir.z : 0.0
        ) * signDir;

        vec3 n = m * (pos - boxCen);
        vec3 k = abs(m) * boxLen;

        vec3 v0 = -n - k;
        vec3 v1 = -n + k;

        // replace invalid axes with -inf and +inf so the tests below ignore them
        v0 = mix(vec3(-1.0 / 0.0000001), v0, validDir);
        v1 = mix(vec3(1.0 / 0.0000001), v1, validDir);

        axis0 = (v0.x > v0.y) ? ((v0.x > v0.z) ? 0 : 2) : ((v0.y > v0.z) ? 1 : 2);
        axis1 = (v1.x < v1.y) ? ((v1.x < v1.z) ? 0 : 2) : ((v1.y < v1.z) ? 1 : 2);

        t0 = v0[axis0];
        t1 = v1[axis1];

        if (t0 > t1 || t1 < 0.0) {
            return false;
        }

        return true;
    }

    float calcDepth(in vec3 pos, in mat4 viewProjection) {
        vec4 v = viewProjection * vec4(pos, 1.0);
        return (v.z / v.w) * 0.5 + 0.5;
    }

    uniform sampler2D blueNoiseTex32;
    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;
    uniform mat4 boxInvMat;
    uniform vec3 boxLen;

    uniform vec3 near_origin;
    uniform vec3 near_x;
    uniform vec3 near_y;

    uniform vec3 far_origin;
    uniform vec3 far_x;
    uniform vec3 far_y;

    uniform vec2 targetSize;

    // Strip colours. The volume used to be white strips for the near side and black for the
    // far side, which disappears against a grey model (and the black strips vanish into the
    // dark background). A saturated pair reads on any content and still separates near from
    // far: cyan for the side facing the camera, deep blue for the far side. Red stays
    // reserved for the "ray missed the volume" fallback above.
    const vec4 FRONT_COLOR = vec4(0.10, 0.95, 1.00, 0.75);
    const vec4 BACK_COLOR = vec4(0.05, 0.35, 1.00, 0.75);

    // ---- strip pattern ---------------------------------------------------------------
    // The strips live in box-metric space (boxLen carries half the side lengths) with a
    // spacing of STRIP_PERIOD world units, drawn as lines covering STRIP_WIDTH of that
    // spacing. That spacing is FIXED in world space, so a volume that covers more of the
    // screen - a big selection, or simply zooming in - packs more and more lines into the
    // same pixels. Once a line is thinner than a pixel the fixed pattern aliases: it turns
    // into sparse speckle that shimmers as the camera moves (moire), which is exactly what
    // makes a large selection volume hard to read.
    //
    // Two things fix that, both driven by the screen-space footprint of the pattern:
    //   * LOD: the spacing doubles while the lines would be closer than MIN_LINE_SPACING_PX
    //     pixels, blended between levels so zooming does not pop. The grid therefore gets
    //     coarser as the volume gets bigger on screen instead of denser.
    //   * analytic antialiasing: a line is never thinner than about a pixel, and its edges
    //     fade over the pixel footprint, so what used to be missing sub-pixel lines becomes
    //     a smooth, stable coverage (the same trick as pristineGrid in infinite-grid-shader).
    //
    // A third fix came from a user report: with a SMALL volume the fixed 0.5 world spacing left
    // at most one or two lines inside it, so there was nothing to read the boundary from ("when
    // the box is set very small only two lines remain"). So:
    //   * the spacing is now capped per axis at (side length / MIN_STRIPS_PER_AXIS), which keeps
    //     at least that many lines across every axis at any volume size, and
    //   * the 12 edges are drawn on top of the strips with a CONSTANT screen-space width
    //     (edgeCoverage below), so the extent is unambiguous even when the strips are sparse.
    const float STRIP_PERIOD = 0.5;
    const float STRIP_WIDTH = 0.03;
    const float MIN_LINE_SPACING_PX = 7.0;
    const float COVERAGE_CUTOFF = 0.012;
    const float MIN_STRIPS_PER_AXIS = 4.0;
    // edge line: about EDGE_HALF_PX pixels wide on each side of the border, fading over
    // EDGE_FADE_PX more, whatever the zoom level or the volume size
    const float EDGE_HALF_PX = 1.0;
    const float EDGE_FADE_PX = 1.25;

    bool writeDepth(float alpha) {
        ivec2 uv = ivec2(gl_FragCoord.xy);
        ivec2 size = textureSize(blueNoiseTex32, 0);
        return alpha > texelFetch(blueNoiseTex32, uv % size, 0).y;
    }

    // coverage of one grid line along 'coord', antialiased over the fragment footprint:
    // 'deriv' is how many metric units one pixel covers on that axis
    float lineCoverage(float coord, float deriv, float period) {
        float cell = fract(coord / period + 0.015);
        float dist = min(cell, 1.0 - cell) * period;      // metric distance to the line
        // the line is about a pixel and a half wide on screen whatever the zoom, and the fade
        // spreads over another pixel and a half: measured, this wider fade is what keeps the
        // pattern from flickering when the camera moves (a tighter one flipped 41% of its
        // pixels for a 0.1 degree nudge, against 17% here)
        float halfWidth = max(period * STRIP_WIDTH * 0.5, deriv * 0.6);
        return 1.0 - smoothstep(halfWidth, halfWidth + deriv * 1.5, dist);
    }

    // per-axis strips with the level-of-detail blend: the spacing doubles while the lines would
    // come closer together than MIN_LINE_SPACING_PX pixels
    float axisCoverage(float coord, float deriv, float base) {
        float level = max(0.0, log2(max(deriv * MIN_LINE_SPACING_PX / base, 1e-6)));
        float level0 = floor(level);
        float blend = smoothstep(0.0, 1.0, level - level0);
        float period0 = base * exp2(level0);
        float period1 = period0 * 2.0;
        return mix(lineCoverage(coord, deriv, period0), lineCoverage(coord, deriv, period1), blend);
    }

    // coverage of the strip pattern at 'pos' (box-metric) whose screen footprint is 'fw',
    // on a face normal to 'axis' - the strips run along the two other axes, each with its own
    // spacing so a thin box still shows a few lines on its narrow faces
    float stripCoverage(vec3 pos, vec3 fw, int axis, vec3 periods) {
        float cov = 0.0;
        if (axis != 0) cov = max(cov, axisCoverage(pos.x, fw.x, periods.x));
        if (axis != 1) cov = max(cov, axisCoverage(pos.y, fw.y, periods.y));
        if (axis != 2) cov = max(cov, axisCoverage(pos.z, fw.z, periods.z));
        return cov;
    }

    // spacing per axis: never coarser than STRIP_PERIOD, never so coarse that the axis shows
    // fewer than MIN_STRIPS_PER_AXIS lines
    vec3 stripPeriods() {
        vec3 extents = max(boxLen * 2.0, vec3(1e-5));
        return min(vec3(STRIP_PERIOD), extents / MIN_STRIPS_PER_AXIS);
    }

    // coverage of the volume's edges, at a constant width in screen space: 'edge' is the metric
    // distance to the nearest border of the face, 'edgeFw' how much that distance changes per pixel
    float edgeCoverage(vec3 metric, vec3 fw, int axis) {
        vec3 extent = max(boxLen * 2.0, vec3(1e-5));
        vec3 n = metric / extent;              // -1 at the low face, +1 at the high face
        vec3 nFw = fw / extent;

        float edge = 1.0;
        float edgeFw = 0.0;
        if (axis != 0) {
            edge = min(edge, 1.0 - abs(n.x));
            edgeFw = max(edgeFw, nFw.x);
        }
        if (axis != 1) {
            edge = min(edge, 1.0 - abs(n.y));
            edgeFw = max(edgeFw, nFw.y);
        }
        if (axis != 2) {
            edge = min(edge, 1.0 - abs(n.z));
            edgeFw = max(edgeFw, nFw.z);
        }

        float pixels = edge / max(edgeFw, 1e-9);
        return 1.0 - smoothstep(EDGE_HALF_PX, EDGE_HALF_PX + EDGE_FADE_PX, pixels);
    }

    void main() {
        // the camera-ray uniforms are laid out from the bottom-left, so WebGPU's top-left
        // fragment origin has to be flipped (see applyFragCoordDefine)
        #ifdef GSPLAT_FRAGCOORD_TOPLEFT
            vec2 fragCoord = vec2(gl_FragCoord.x, targetSize.y - gl_FragCoord.y);
        #else
            vec2 fragCoord = gl_FragCoord.xy;
        #endif
        vec2 clip = fragCoord / targetSize;
        vec3 worldNear = near_origin + near_x * clip.x + near_y * clip.y;
        vec3 worldFar = far_origin + far_x * clip.x + far_y * clip.y;

        // transform the ray into the box's local space, where the box is the
        // axis-aligned unit cube centered on the origin (the pivot's scale
        // carries the box lengths)
        vec3 localNear = (boxInvMat * vec4(worldNear, 1.0)).xyz;
        vec3 localDir = normalize((boxInvMat * vec4(worldFar, 1.0)).xyz - localNear);

        float t0, t1;
        int axis0, axis1;
        bool hit = intersectBox(t0, t1, axis0, axis1, localNear, localDir, vec3(0.0), vec3(0.5));

        // strips operate on box-metric offsets (local * lengths) so the grid rotates with the
        // box. Their screen footprint (how many metric units one pixel covers) has to be taken
        // BEFORE the branch below: WGSL only allows derivative functions in uniform control
        // flow, and the transpiled gl_FragCoord is a module-scope private variable, so any
        // branch that reads it counts as non-uniform and fwidth after it fails to compile.
        vec3 frontMetric = (localNear + localDir * t0) * boxLen * 2.0;
        vec3 backMetric = (localNear + localDir * t1) * boxLen * 2.0;
        vec3 frontFw = fwidth(frontMetric);
        vec3 backFw = fwidth(backMetric);

        if (!hit) {
            gl_FragColor = vec4(1.0, 0.0, 0.0, 0.6);
            return;
        }

        float frontCov = t0 > 0.0 ? max(stripCoverage(frontMetric, frontFw, axis0, stripPeriods()),
                                        edgeCoverage(frontMetric, frontFw, axis0)) : 0.0;
        float backCov = max(stripCoverage(backMetric, backFw, axis1, stripPeriods()),
                            edgeCoverage(backMetric, backFw, axis1));

        if (frontCov > COVERAGE_CUTOFF && frontCov >= backCov) {
            vec3 frontPos = (matrix_model * vec4(localNear + localDir * t0, 1.0)).xyz;
            float alpha = FRONT_COLOR.a * frontCov;
            gl_FragColor = vec4(FRONT_COLOR.rgb, alpha);
            gl_FragDepth = writeDepth(alpha) ? calcDepth(frontPos, matrix_viewProjection) : 1.0;
        } else if (backCov > COVERAGE_CUTOFF) {
            vec3 backPos = (matrix_model * vec4(localNear + localDir * t1, 1.0)).xyz;
            float alpha = BACK_COLOR.a * backCov;
            gl_FragColor = vec4(BACK_COLOR.rgb, alpha);
            gl_FragDepth = writeDepth(alpha) ? calcDepth(backPos, matrix_viewProjection) : 1.0;
        } else {
            discard;
        }
    }
`;

export { vertexShader, fragmentShader };
