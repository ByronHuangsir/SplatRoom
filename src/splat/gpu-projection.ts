import { Mat4, PROJECTION_ORTHOGRAPHIC, Camera } from 'playcanvas';

// The WebGPU code paths upload their own camera matrices (uSplatView / uSplatViewProj for
// the splat material, uOverlayViewProj for the centers overlay) because the engine's view
// uniform buffer is not usable for those custom shaders there. Rebuilding the projection
// by hand has to mirror Camera._evaluateProjectionMatrix() exactly, otherwise the custom
// geometry does not line up with everything the engine draws itself:
//
// - the app drives the camera with ASPECT_MANUAL and sets `horizontalFov` whenever the
//   render target is wider than it is tall (see Camera.rebuildRenderTargets), so the fov
//   has to be passed on with that flag. Treating it as a vertical fov scales the whole
//   projection by 1/aspect.
// - the app can switch the camera to orthographic, which needs an ortho matrix instead.
const buildGpuProjection = (out: Mat4, cam: Camera) => {
    const { nearClip, farClip, aspectRatio } = cam;

    if (cam.projection === PROJECTION_ORTHOGRAPHIC) {
        const y = cam.orthoHeight;
        const x = y * aspectRatio;
        out.setOrtho(-x, x, -y, y, nearClip, farClip);
    } else {
        out.setPerspective(cam.fov, aspectRatio, nearClip, farClip, cam.horizontalFov);
    }

    return out;
};

export { buildGpuProjection };
