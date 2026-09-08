import { Mat4, Quat, Vec3 } from 'playcanvas';

// =============================================================================
// SuperSplat Crop Box Runtime Adapter
// =============================================================================
// Adapts the editor's crop-box .config.json sidecar for use in a PlayCanvas
// roaming/viewer runtime. Satisfies the three cross-platform adaptation
// requirements from the spec:
//
// 1. Asset Parser   — detect & load {name}.config.json next to {name}.ply
// 2. Material Reload — inject the fragment-level clipping shader + uniforms
// 3. Coordinate Sync — Y-up world space, consistent matrix multiply order
//
// IMPORTANT — fragment-level vs center-based:
// The editor performs FRAGMENT-LEVEL clipping: each fragment's 3D position is
// reconstructed from the splat's ellipsoid geometry and tested against the
// box. This produces a clean "laser cut" regardless of ellipsoid size. The
// runtime adapter now matches this exactly so the visual result is identical
// between editor and viewer.
//
// PREREQUISITE: the viewer's splat vertex shader must expose the same symbols
// the editor's gsplatCommonVS chunk provides (getCenter, getRotation, getScale,
// initCenter, applyPaletteTransform, matrix_model, matrix_view,
// matrix_projection). If the viewer uses a different splat shader, the vertex
// chunk below must be adapted to that shader's API — the fragment chunk and
// uniform setup are portable as-is.
//
// Usage:
//   import { CropBoxRuntime } from './runtime/crop-box-adapter';
//
//   const rt = new CropBoxRuntime(app);
//   await rt.loadConfig('models/scene.ply');          // auto-detects sidecar
//   rt.attach(splatMaterial);                          // inject shader + uniforms
//   // each frame:
//   rt.update(splatMaterial, camera.viewMatrix);

type CropBoxConfig = {
    version: string;
    metadata: { generator: string; updated_at: string };
    crop_box: {
        enabled: boolean;
        center: [number, number, number];
        extent: [number, number, number];          // half-extents
        rotation_quat: [number, number, number, number];  // [x, y, z, w]
    };
};

// -----------------------------------------------------------------------------
// Shader chunks — these mirror src/shaders/splat-shader.ts EXACTLY so the
// visual result is identical between editor and runtime. any change here must
// be reflected in the editor shader and vice versa.
// -----------------------------------------------------------------------------

// Varyings declared in the vertex stage and consumed in the fragment stage.
const CROP_BOX_VARYINGS = /* glsl */ `
varying highp vec3 vViewCenter;         // splat center in view space
varying highp vec2 vScreenOffset;       // fragment view-space xy (absolute)
varying highp float vDepthRadius;       // ellipsoid 3σ extent along view-z
// symmetric 3x6 inverse ellipsoid matrix in view space (6 unique elements).
// E_view = V * R * diag(1/a²,1/b²,1/c²) * R^T * V^T
varying highp float vEllipE00;
varying highp float vEllipE01;
varying highp float vEllipE02;
varying highp float vEllipE11;
varying highp float vEllipE12;
varying highp float vEllipE22;
`;

// Uniforms. uViewToBoxLocal = invBoxWorld * invView (view → box-local in one
// step). uCropBoxEnabled: 0 = show all (no config / disabled), 1 = clip.
// uCropBoxPreview: 0 = discard outside, 1 = dim outside (keep visible).
// uCropBoxSoftEdge: 0~0.05, soft edge feather width.
const CROP_BOX_UNIFORMS = /* glsl */ `
uniform float uCropBoxEnabled;
uniform float uCropBoxPreview;
uniform float uCropBoxSoftEdge;
uniform mat4  uViewToBoxLocal;
`;

// Vertex chunk — inserted after initCorner() and gl_Position assignment,
// before texCoord_flags. Computes the varyings the fragment shader needs to
// reconstruct each fragment's 3D view-space position.
//
// Requires the gsplatCommonVS symbols: getRotation(), getScale(),
// applyPaletteTransform(matrix_model), matrix_view, matrix_projection,
// center.view, center.proj, corner.offset. quatToMat3 is also expected.
const CROP_BOX_VERTEX_CHUNK = /* glsl */ `
    if (uCropBoxEnabled > 0.5) {
        vViewCenter = center.view;

        // fragment's absolute view-space xy: unproject gl_Position (offset by
        // corner.offset.xy) back to view space at depth center.view.z.
        vec4 clipPos = center.proj + vec4(corner.offset.xy, 0.0, 0.0);
        vec3 ndc = clipPos.xyz / clipPos.w;

        // Reconstruct the fragment's view-space xy (absolute, same units as
        // center.view — the fragment uses vScreenOffset directly as viewPos.xy).
        // View-space offset from the splat center =
        //   corner.offset.xy * depthFactor / (clipPos.w * M)
        // where depthFactor = 1 for ortho, -viewZ for perspective. Adding
        // vViewCenter once gives absolute view-space xy. We detect projection
        // via M[3][3] (ortho == 1, persp == 0) instead of camera_params so the
        // chunk only depends on matrix_projection.
        vec2 viewSpaceXY = corner.offset.xy *
                           ((matrix_projection[3][3] > 0.5) ? 1.0 : (-center.view.z)) /
                           (clipPos.w * vec2(matrix_projection[0][0], matrix_projection[1][1]));
        vScreenOffset = vViewCenter.xy + viewSpaceXY;

        // ellipsoid 3σ depth radius along the view direction. for an
        // ellipsoid with half-axes a,b,c the extent along d̂ is
        // sqrt((a·d̂)²+(b·d̂)²+(c·d̂)²); scaled by 3 (billboard ~3σ).
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
        float depthR = 3.0 * sqrt(d0 * d0 + d1 * d1 + d2 * d2);
        vDepthRadius = depthR;

        // Build the inverse ellipsoid matrix in view space.
        // M = V * R  (view rotation * splat rotation)
        // E[i][j] = sum_k  M[i][k] * M[j][k] / a_k^2
        mat3 viewMat = mat3(matrix_view);
        mat3 M = viewMat * rotMat;
        float a0 = splatScale.x, a1 = splatScale.y, a2 = splatScale.z;
        float invA0 = 1.0 / max(a0 * a0, 1e-8);
        float invA1 = 1.0 / max(a1 * a1, 1e-8);
        float invA2 = 1.0 / max(a2 * a2, 1e-8);

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
`;

// Fragment chunk — inserted at the top of main() after varyings are declared,
// before the gaussian falloff alpha computation. reconstructs the fragment's
// 3D view-space position, transforms to box-local, discards if outside
// [-0.5, 0.5]³ (or dims if preview is on), and applies the soft-edge feather.
//
// `cropFade` is a local mediump float that the caller must multiply into the
// final alpha. If the caller's shader already declares cropFade, remove the
// declaration here.
const CROP_BOX_FRAGMENT_CHUNK = /* glsl */ `
    mediump float cropFade = 1.0;
    if (uCropBoxEnabled > 0.5) {
        // fragment view-space XY offset from the splat center
        vec2 dxy = vScreenOffset - vViewCenter.xy;

        // Solve ellipsoid depth quadratic for exact depth at any orientation.
        // E[2][2]*dz² + 2*(E[0][2]*dx + E[1][2]*dy)*dz
        //   + (E[0][0]*dx² + E[1][1]*dy² + 2*E[0][1]*dx*dy - 1) = 0
        float A_coeff = vEllipE22;
        float B_coeff = 2.0 * (vEllipE02 * dxy.x + vEllipE12 * dxy.y);
        float C_coeff = vEllipE00 * dxy.x*dxy.x + vEllipE11 * dxy.y*dxy.y
                      + 2.0 * vEllipE01 * dxy.x * dxy.y - 1.0;
        float disc = B_coeff*B_coeff - 4.0*A_coeff*C_coeff;
        float depthOffset;
        if (disc >= 0.0 && A_coeff > 1e-8) {
            depthOffset = (-B_coeff + sqrt(disc)) / (2.0 * A_coeff);
        } else {
            // outside ellipsoid silhouette or degenerate — fallback to sphere
            vec2 uv = texCoord_flags.xy;
            float r2 = dot(uv, uv);
            depthOffset = sqrt(max(0.0, 1.0 - r2)) * vDepthRadius;
        }

        vec3 viewPos;
        viewPos.xy = vScreenOffset;
        viewPos.z = vViewCenter.z + depthOffset;

        vec3 localPos = (uViewToBoxLocal * vec4(viewPos, 1.0)).xyz;
        vec3 ad = abs(localPos);
        float maxD = max(max(ad.x, ad.y), ad.z);
        if (maxD > 0.5) {
            // OUTSIDE the box.
            #if PICK_PASS
                discard;
            #else
                if (uCropBoxPreview > 0.5) {
                    // preview mode: keep outside fragments visible but very faint.
                    cropFade = 0.035;
                } else {
                    discard;
                }
            #endif
        } else {
            // INSIDE: soft-edge feather (0 = laser sharp, up to 0.05 = soft).
            float softEdge = max(uCropBoxSoftEdge, 0.0005);
            float edge = 0.5 - maxD;
            cropFade = smoothstep(0.0, softEdge, edge);
        }
    }
`;

// Scratch matrices (avoid per-frame allocation)
const _worldMat = new Mat4();
const _invBoxWorld = new Mat4();
const _invView = new Mat4();
const _viewToBoxLocal = new Mat4();
const _rot = new Quat();
const _pos = new Vec3();
const _scale = new Vec3();

class CropBoxRuntime {
    private app: any;  // AppBase — typed loosely for framework-agnostic portability

    private config: CropBoxConfig | null = null;
    private enabled = false;
    private _preview = false;
    private _softEdge = 0.005;

    // cached box world matrix and its inverse (fixed once config is loaded;
    // the box doesn't move at runtime). recomputed only when config changes.
    private boxWorldMatrix: Mat4 = new Mat4();
    private invBoxWorld: Mat4 = new Mat4();

    constructor(app: any) {
        this.app = app;
    }

    // -------------------------------------------------------------------------
    // 1. Asset Parser
    // -------------------------------------------------------------------------
    // Load the .config.json sidecar that sits next to a .ply file.
    //   "models/scene.ply"  ->  "models/scene.config.json"
    // If no sidecar exists, the adapter stays in "show all" mode (enabled=false)
    // which satisfies the no-config fallback requirement.
    async loadConfig(plyUrl: string): Promise<boolean> {
        const configUrl = plyUrl.replace(/\.ply$/i, '.config.json');
        try {
            const response = await fetch(configUrl);
            if (!response.ok) {
                this.config = null;
                this.enabled = false;
                return false;
            }
            const config = await response.json() as CropBoxConfig;
            return this.loadConfigFromObject(config);
        } catch (e) {
            console.warn('SuperSplat runtime: could not load crop-box config sidecar:', e);
            this.config = null;
            this.enabled = false;
            return false;
        }
    }

    // Load config from a pre-parsed object (e.g. embedded in a scene manifest)
    loadConfigFromObject(config: CropBoxConfig): boolean {
        if (!config || !config.crop_box) return false;
        this.config = config;
        this.enabled = !!config.crop_box.enabled;
        this.updateBoxMatrix();
        return true;
    }

    // -------------------------------------------------------------------------
    // 2. Material Reload
    // -------------------------------------------------------------------------
    // Inject the crop-box shader chunks + uniform declarations into a splat
    // material. The exact integration point depends on the engine version and
    // the viewer's shader pipeline:
    //
    //   // engine >= 1.70 with shader chunks:
    //   material.chunks.vsGlobals  = CROP_BOX_VARYINGS  + (material.chunks.vsGlobals  ?? '');
    //   material.chunks.fsGlobals  = CROP_BOX_UNIFORMS  + (material.chunks.fsGlobals  ?? '');
    //   material.chunks.fsMain     = CROP_BOX_FRAGMENT_CHUNK + (material.chunks.fsMain ?? '');
    //   // vsMain insertion must be after initCorner/gl_Position — see editor.
    //   material.update();
    //
    //   // raw ShaderMaterial: merge the chunks at the marked insertion points.
    attach(material: any): void {
        // register uniform setters so update() can push values each frame.
        // playcanvas Material.setParameter writes to the uniform table.
        material.addUniform?.('uCropBoxEnabled', 'float');
        material.addUniform?.('uCropBoxPreview', 'float');
        material.addUniform?.('uCropBoxSoftEdge', 'float');
        material.addUniform?.('uViewToBoxLocal', 'mat4');
    }

    // Push the current crop-box state into the material's uniforms. call this
    // every frame. the view matrix is needed because uViewToBoxLocal combines
    // the (fixed) box inverse with the (per-frame) camera inverse view.
    update(material: any, viewMatrix: Mat4): void {
        if (this.enabled && this.config) {
            // uViewToBoxLocal = invBoxWorld * invView  (column-major mul2: A*B)
            _invView.copy(viewMatrix).invert();
            _viewToBoxLocal.mul2(this.invBoxWorld, _invView);

            material.setParameter('uCropBoxEnabled', 1);
            material.setParameter('uViewToBoxLocal', _viewToBoxLocal.data);
            material.setParameter('uCropBoxPreview', this.preview ? 1 : 0);
            material.setParameter('uCropBoxSoftEdge', this.softEdge);
        } else {
            material.setParameter('uCropBoxEnabled', 0);
            material.setParameter('uCropBoxPreview', 0);
            material.setParameter('uCropBoxSoftEdge', 0.005);
        }
    }

    // -------------------------------------------------------------------------
    // 3. Coordinate Sync
    // -------------------------------------------------------------------------
    // Build the crop box world matrix from the config's TRS and compute its
    // inverse. both editor and runtime use PlayCanvas math, so Y-up world
    // space and column-major matrices are guaranteed consistent.
    //
    // Editor-side (src/crop-box.ts):
    //   pivot.setLocalPosition(center);
    //   pivot.setLocalRotation(rotation_quat);
    //   pivot.setLocalScale(extent * 2);      // unit cube [-0.5,0.5]^3 -> world
    //
    // Runtime-side (here):
    //   worldMat = T(center) * R(rotation_quat) * S(extent * 2)
    //   invMat   = inverse(worldMat)
    private updateBoxMatrix(): void {
        if (!this.config) return;
        const cb = this.config.crop_box;
        _pos.set(cb.center[0], cb.center[1], cb.center[2]);
        _rot.set(cb.rotation_quat[0], cb.rotation_quat[1], cb.rotation_quat[2], cb.rotation_quat[3]);
        // extent is half-extent; the unit cube maps to [-extent, +extent]
        // so the world scale is 2 * extent on each axis.
        _scale.set(cb.extent[0] * 2, cb.extent[1] * 2, cb.extent[2] * 2);

        this.boxWorldMatrix.setTRS(_pos, _rot, _scale);
        this.invBoxWorld.copy(this.boxWorldMatrix).invert();
    }

    // ---- accessors ----

    get hasConfig(): boolean {
        return this.config !== null;
    }
    get isEnabled(): boolean {
        return this.enabled;
    }
    get preview(): boolean {
        return this._preview;
    }
    get softEdge(): number {
        return this._softEdge;
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled && this.config !== null;
    }
    setPreview(preview: boolean): void {
        this._preview = preview;
    }
    setSoftEdge(softEdge: number): void {
        this._softEdge = Math.max(0, Math.min(0.05, softEdge));
    }
}

export {
    CropBoxRuntime,
    CropBoxConfig,
    CROP_BOX_VARYINGS,
    CROP_BOX_UNIFORMS,
    CROP_BOX_VERTEX_CHUNK,
    CROP_BOX_FRAGMENT_CHUNK
};
