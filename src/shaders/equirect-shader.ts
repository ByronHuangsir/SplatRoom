// cube faces are rendered with a fov wider than 90° so neighbouring faces
// overlap. splats rasterize with slightly different shapes and composite in a
// different sort order per face, so a hard face boundary shows as a seam;
// blending the overlap feathers the mismatch away. weights ramp from 1 at
// blendStart degrees off-axis to 0 at faceFov / 2.
const faceFov = 100;
const blendStart = 40;

const outerTan = Math.tan((faceFov / 2) * (Math.PI / 180));
const innerTan = Math.tan(blendStart * (Math.PI / 180));
const uvScale = 0.5 / outerTan;

const vertexShader = /* glsl*/ `
    attribute vec2 vertex_position;
    void main(void) {
        gl_Position = vec4(vertex_position, 0.0, 1.0);
    }
`;

// project six overlapping face renders to an equirectangular panorama. faces
// are captured in the (level or full) camera orientation frame, so the
// direction below is a capture-space direction: image center (lon 0, lat 0)
// is the capture forward (-Z), lon +PI/2 is capture right (+X), lat +PI/2 is
// up (+Y).
//
// face textures store camera renders bottom-row-first (flipY: false render
// targets), which matches gl_FragCoord's bottom-left origin, so t is
// up-positive and no flips are needed anywhere.
//
// the face lookups use texture2DLod(..., 0.0) rather than texture2D: they sit inside the
// per-face weight branch, and WGSL only allows implicit-derivative sampling
// (textureSample) in uniform control flow - the branch made the WebGPU shader fail to
// build, which silently produced an empty 360 frame. the faces are single-level
// (mipmaps: false) with linear filtering, so an explicit lod 0 is also the correct filter.
const fragmentShader = /* glsl*/ `
    uniform sampler2D uFace0;   // front -Z
    uniform sampler2D uFace1;   // right +X
    uniform sampler2D uFace2;   // back  +Z
    uniform sampler2D uFace3;   // left  -X
    uniform sampler2D uFace4;   // up    +Y
    uniform sampler2D uFace5;   // down  -Y
    uniform vec2 uTargetSize;

    #define PI 3.141592653589793

    // blend weight and texture uv for a face with the given basis: the
    // direction is mapped to the face's ndc, p = (dot(d, right), dot(d, up)) /
    // dot(d, forward), and the weight feathers to zero towards the face edge
    float faceWeight(vec3 d, vec3 r, vec3 u, vec3 f, out vec2 st) {
        float dn = dot(d, f);
        // a guard rather than a plain 0.0 test: near-tangent directions would divide by ~0
        // and give an infinite uv, and an infinite uv times a zero weight is a NaN
        if (dn <= 1e-5) {
            st = vec2(0.0);
            return 0.0;
        }
        vec2 p = vec2(dot(d, r), dot(d, u)) / dn;
        st = p * ${uvScale.toFixed(8)} + 0.5;
        return 1.0 - smoothstep(${innerTan.toFixed(8)}, ${outerTan.toFixed(8)}, max(abs(p.x), abs(p.y)));
    }

    void main(void) {
        // gl_FragCoord is top-left on WebGPU but the capture basis below is defined the GL
        // way (bottom-left), so the output row has to be flipped (see withFragCoordDefine)
        #ifdef GSPLAT_FRAGCOORD_TOPLEFT
            vec2 uv = vec2(gl_FragCoord.x, uTargetSize.y - gl_FragCoord.y) / uTargetSize;
        #else
            vec2 uv = gl_FragCoord.xy / uTargetSize;
        #endif
        float lon = (uv.x - 0.5) * 2.0 * PI;
        float lat = (uv.y - 0.5) * PI;

        vec3 d = vec3(sin(lon) * cos(lat), sin(lat), -cos(lon) * cos(lat));

        vec4 acc = vec4(0.0);
        float wsum = 0.0;
        vec2 st;
        float w;

        w = faceWeight(d, vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, -1.0), st);
        if (w > 0.0) { acc += w * texture2DLod(uFace0, st, 0.0); wsum += w; }

        w = faceWeight(d, vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), st);
        if (w > 0.0) { acc += w * texture2DLod(uFace1, st, 0.0); wsum += w; }

        w = faceWeight(d, vec3(-1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0), st);
        if (w > 0.0) { acc += w * texture2DLod(uFace2, st, 0.0); wsum += w; }

        w = faceWeight(d, vec3(0.0, 0.0, -1.0), vec3(0.0, 1.0, 0.0), vec3(-1.0, 0.0, 0.0), st);
        if (w > 0.0) { acc += w * texture2DLod(uFace3, st, 0.0); wsum += w; }

        w = faceWeight(d, vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 0.0), st);
        if (w > 0.0) { acc += w * texture2DLod(uFace4, st, 0.0); wsum += w; }

        w = faceWeight(d, vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, -1.0), vec3(0.0, -1.0, 0.0), st);
        if (w > 0.0) { acc += w * texture2DLod(uFace5, st, 0.0); wsum += w; }

        gl_FragColor = acc / max(wsum, 1e-5);
    }
`;

export { faceFov, vertexShader, fragmentShader };
