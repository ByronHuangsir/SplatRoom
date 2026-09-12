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
    const float STRIP_PERIOD = 0.5;
    const float STRIP_WIDTH = 0.03;
    const float MIN_LINE_SPACING_PX = 7.0;
    const float COVERAGE_CUTOFF = 0.012;

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

    // coverage of the strip pattern at 'pos' (box-metric) whose screen footprint is 'fw',
    // on a face normal to 'axis' - the strips run along the two other axes
    float stripCoverage(vec3 pos, vec3 fw, int axis) {
        // the coarsest-axis footprint decides the level, so no axis of the face aliases
        float deriv = 0.0;
        if (axis != 0) deriv = max(deriv, fw.x);
        if (axis != 1) deriv = max(deriv, fw.y);
        if (axis != 2) deriv = max(deriv, fw.z);

        float level = max(0.0, log2(max(deriv * MIN_LINE_SPACING_PX / STRIP_PERIOD, 1e-6)));
        float level0 = floor(level);
        float blend = smoothstep(0.0, 1.0, level - level0);
        float period0 = STRIP_PERIOD * exp2(level0);
        float period1 = period0 * 2.0;

        float cov0 = 0.0;
        float cov1 = 0.0;
        if (axis != 0) {
            cov0 = max(cov0, lineCoverage(pos.x, fw.x, period0));
            cov1 = max(cov1, lineCoverage(pos.x, fw.x, period1));
        }
        if (axis != 1) {
            cov0 = max(cov0, lineCoverage(pos.y, fw.y, period0));
            cov1 = max(cov1, lineCoverage(pos.y, fw.y, period1));
        }
        if (axis != 2) {
            cov0 = max(cov0, lineCoverage(pos.z, fw.z, period0));
            cov1 = max(cov1, lineCoverage(pos.z, fw.z, period1));
        }
        return mix(cov0, cov1, blend);
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

        float frontCov = t0 > 0.0 ? stripCoverage(frontMetric, frontFw, axis0) : 0.0;
        float backCov = stripCoverage(backMetric, backFw, axis1);

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
