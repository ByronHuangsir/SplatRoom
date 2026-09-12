import { Mat4, PROJECTION_ORTHOGRAPHIC } from 'playcanvas';

import { buildGpuProjection } from './gpu-projection';

// On WebGPU the splat material does not read the engine's view uniform buffer; it takes its
// camera from material parameters instead (see splat-shader-wgsl.ts and the notes in
// splat.ts). Those parameters belong to the MATERIAL, which is shared by everything that
// draws the model - so whichever camera is rendered last wins. The main view used to be the
// only consumer; the picture-in-picture preview renders the same instances from the animation
// camera, and without re-uploading the parameters for that camera the preview came out as a
// copy of the main viewport instead of the camera it is supposed to preview.
//
// Anything that renders the splat material from another camera must therefore write the
// parameters for that camera and write the main view's back afterwards.
const projMat = new Mat4();
const viewProjMat = new Mat4();

type GpuCameraSource = {
    camera: {
        viewMatrix: Mat4;
        nearClip: number;
        farClip: number;
        aspectRatio: number;
        fov: number;
        horizontalFov: boolean;
        projection: number;
        orthoHeight: number;
    };
    targetSize?: { width: number, height: number };
};

const writeGpuCameraUniforms = (instance: { material?: { setParameter: (name: string, value: any) => void } } | null | undefined, source: GpuCameraSource | null | undefined) => {
    const cam = source?.camera;
    const material = instance?.material;
    if (!cam || !material) {
        return;
    }

    const near = cam.nearClip;
    const far = cam.farClip;
    const isOrtho = cam.projection === PROJECTION_ORTHOGRAPHIC;
    const { width, height } = source.targetSize ?? { width: 1, height: 1 };

    // The camera component's own projection matrix is not usable here: the engine refreshes
    // it lazily only while it syncs the render view for a frame, which our custom pass
    // pipeline does after onPreRender runs - reading it there returns zeros. Build the
    // matrix ourselves the way the engine does, including its horizontalFov and orthographic
    // cases (see src/splat/gpu-projection.ts).
    buildGpuProjection(projMat, cam as any);
    viewProjMat.mul2(projMat, cam.viewMatrix);

    material.setParameter('uSplatView', cam.viewMatrix.data);
    material.setParameter('uSplatViewProj', viewProjMat.data);
    material.setParameter('uSplatProj', projMat.data);
    material.setParameter('uSplatCameraParams', [1 / far, far, near, isOrtho ? 1 : 0]);
    material.setParameter('uSplatViewport', [width, height, 1 / width, 1 / height]);
};

export { writeGpuCameraUniforms };
export type { GpuCameraSource };
