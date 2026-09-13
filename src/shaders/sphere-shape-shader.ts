const vertexShader = /* glsl */ `
    attribute vec3 vertex_position;

    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;

    void main() {
        gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0);
    }
`;

const fragmentShader = /* glsl */ `
    bool intersectSphere(out float t0, out float t1, vec3 pos, vec3 dir, vec4 sphere) {
        vec3 L = sphere.xyz - pos;
        float tca = dot(L, dir);

        float d2 = sphere.w * sphere.w - (dot(L, L) - tca * tca);
        if (d2 <= 0.0) {
            return false;
        }

        float thc = sqrt(d2);
        t0 = tca - thc;
        t1 = tca + thc;
        if (t1 <= 0.0) {
            return false;
        }

        return true;
    }

    float calcDepth(in vec3 pos, in mat4 viewProjection) {
        vec4 v = viewProjection * vec4(pos, 1.0);
        return (v.z / v.w) * 0.5 + 0.5;
    }

    vec2 calcAzimuthElev(in vec3 dir) {
        float azimuth = atan(dir.z, dir.x);
        float elev = asin(dir.y);
        return vec2(azimuth, elev) * 180.0 / 3.14159;
    }

    uniform sampler2D blueNoiseTex32;
    uniform mat4 matrix_viewProjection;
    uniform vec4 sphere;

    uniform vec3 near_origin;
    uniform vec3 near_x;
    uniform vec3 near_y;

    uniform vec3 far_origin;
    uniform vec3 far_x;
    uniform vec3 far_y;

    uniform vec2 targetSize;

    // Strip colours: cyan for the side facing the camera, deep blue for the far side. See the
    // box shape shader for why the neutral white/black pair was replaced.
    const vec4 FRONT_COLOR = vec4(0.10, 0.95, 1.00, 0.75);
    const vec4 BACK_COLOR = vec4(0.05, 0.35, 1.00, 0.75);

    // ---- strip pattern ---------------------------------------------------------------
    // The sphere's strips are meridians and parallels every STRIP_ARC world units of arc
    // length (converted to degrees by the radius), drawn as lines covering STRIP_WIDTH of
    // that spacing. As with the box volume, a fixed spacing aliases into shimmering speckle
    // once the lines get thinner than a pixel, so the spacing doubles while the lines would
    // be closer than MIN_LINE_SPACING_PX pixels and every line is antialiased over the pixel
    // footprint. The footprint is measured from the screen-space derivative of the direction
    // to the surface point rather than of the angles themselves, because the azimuth wraps at
    // +-180 degrees and a derivative across that seam would be meaningless.
    //
    // A third fix came from a user report: an arc spacing of 0.5 world units on a SMALL sphere
    // covers more than a full turn (a radius of 0.05 puts the meridians 1146 degrees apart), so
    // the whole sphere showed one meridian and one parallel - "only two lines remain". The
    // spacing is now capped at MAX_STRIP_SPACING_DEG, which keeps at least 12 meridians and 6
    // parallels on any sphere whatever its radius, and the silhouette is drawn on top with a
    // constant screen-space width (rimCoverage below) so the extent always reads.
    const float STRIP_ARC = 0.5;
    const float STRIP_WIDTH = 0.03;
    const float MIN_LINE_SPACING_PX = 7.0;
    const float COVERAGE_CUTOFF = 0.012;
    const float MAX_STRIP_SPACING_DEG = 30.0;     // -> >= 12 meridians, >= 6 parallels
    // silhouette line: about RIM_HALF_PX pixels wide, fading over RIM_FADE_PX more
    const float RIM_HALF_PX = 1.0;
    const float RIM_FADE_PX = 1.25;

    bool writeDepth(float alpha) {
        vec2 uv = fract(gl_FragCoord.xy / 32.0);
        float noise = texture2DLod(blueNoiseTex32, uv, 0.0).y;
        return alpha > noise;
    }

    // coverage of one line along 'coord' (degrees), antialiased over 'deriv' degrees per pixel
    float lineCoverage(float coord, float deriv, float spacing) {
        float cell = fract(coord / spacing + 0.015);
        float dist = min(cell, 1.0 - cell) * spacing;
        // about a pixel and a half wide on screen at any zoom, with the fade spreading over
        // another pixel and a half (see the box shader: the wider fade is measurably steadier)
        float halfWidth = max(spacing * STRIP_WIDTH * 0.5, deriv * 0.6);
        return 1.0 - smoothstep(halfWidth, halfWidth + deriv * 1.5, dist);
    }

    // coverage of the meridian/parallel pattern at sphere-angular coordinate 'ae', whose
    // screen footprint is 'degPerPixel'
    float stripCoverage(vec2 ae, vec2 degPerPixel) {
        float deriv = max(degPerPixel.x, degPerPixel.y);
        // arc length -> degrees, capped so a small sphere still shows a full grid
        float base = min(180.0 / (3.14159265 * max(sphere.w, 1e-4)), MAX_STRIP_SPACING_DEG);

        float level = max(0.0, log2(max(deriv * MIN_LINE_SPACING_PX / base, 1e-6)));
        float level0 = floor(level);
        float blend = smoothstep(0.0, 1.0, level - level0);
        float spacing0 = base * exp2(level0);
        float spacing1 = spacing0 * 2.0;

        float cov0 = max(lineCoverage(ae.x, degPerPixel.x, spacing0),
                         lineCoverage(ae.y, degPerPixel.y, spacing0));
        float cov1 = max(lineCoverage(ae.x, degPerPixel.x, spacing1),
                         lineCoverage(ae.y, degPerPixel.y, spacing1));
        return mix(cov0, cov1, blend);
    }

    // coverage of the silhouette, at a constant width in screen space: 'rim' is 0 exactly on the
    // silhouette (where the surface normal is perpendicular to the view ray) and grows inwards,
    // so dividing by its screen-space rate turns it into a distance in pixels
    float rimCoverage(float rim, float rimFw) {
        float pixels = rim / max(rimFw, 1e-9);
        return 1.0 - smoothstep(RIM_HALF_PX, RIM_HALF_PX + RIM_FADE_PX, pixels);
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

        vec3 rayDir = normalize(worldFar - worldNear);

        float t0, t1;
        bool hit = intersectSphere(t0, t1, worldNear, rayDir, sphere);

        // the surface points, their angular coordinates and the screen footprint of those
        // angles are all evaluated BEFORE the branch below: WGSL only allows derivative
        // functions in uniform control flow, and the transpiled gl_FragCoord is a module-scope
        // private variable, so a branch that reads it counts as non-uniform.
        vec3 frontRel = (worldNear + rayDir * t0) - sphere.xyz;
        vec3 backRel = (worldNear + rayDir * t1) - sphere.xyz;
        vec3 frontN = normalize(frontRel);
        vec3 backN = normalize(backRel);
        vec2 frontAe = calcAzimuthElev(frontN);
        vec2 backAe = calcAzimuthElev(backN);
        float radToDeg = 180.0 / 3.14159265;
        vec2 frontStep = vec2(length(fwidth(frontN)) * radToDeg);
        vec2 backStep = vec2(length(fwidth(backN)) * radToDeg);
        // 0 exactly on the silhouette, growing inwards
        float frontRim = 1.0 - abs(dot(frontN, rayDir));
        float backRim = 1.0 - abs(dot(backN, rayDir));
        float frontRimFw = fwidth(frontRim);
        float backRimFw = fwidth(backRim);

        if (!hit) {
            discard;
        }

        float frontCov = t0 > 0.0 ? max(stripCoverage(frontAe, frontStep), rimCoverage(frontRim, frontRimFw)) : 0.0;
        float backCov = max(stripCoverage(backAe, backStep), rimCoverage(backRim, backRimFw));

        if (frontCov > COVERAGE_CUTOFF && frontCov >= backCov) {
            vec3 frontPos = worldNear + rayDir * t0;
            float alpha = FRONT_COLOR.a * frontCov;
            gl_FragColor = vec4(FRONT_COLOR.rgb, alpha);
            gl_FragDepth = writeDepth(alpha) ? calcDepth(frontPos, matrix_viewProjection) : 1.0;
        } else if (backCov > COVERAGE_CUTOFF) {
            vec3 backPos = worldNear + rayDir * t1;
            float alpha = BACK_COLOR.a * backCov;
            gl_FragColor = vec4(BACK_COLOR.rgb, alpha);
            gl_FragDepth = writeDepth(alpha) ? calcDepth(backPos, matrix_viewProjection) : 1.0;
        } else {
            discard;
        }
    }
`;

export { vertexShader, fragmentShader };
