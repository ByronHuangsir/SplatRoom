import {
    BlendState,
    Layer
} from 'playcanvas';

import { Element, ElementType } from './element';
import { vertexShader, fragmentShader } from '../shaders/outline-shader';
import { ShaderQuad, SimpleRenderPass } from '../utils/simple-render-pass';

class Outline extends Element {
    shaderQuad: ShaderQuad;
    renderPass: SimpleRenderPass;
    enabled = true;
    private postRenderHandler: ((layer: Layer, transparent: boolean) => void) | null = null;

    constructor() {
        super(ElementType.other);
    }

    add() {
        const device = this.scene.app.graphicsDevice;

        this.shaderQuad = new ShaderQuad(device, vertexShader, fragmentShader, 'apply-outline');
        this.renderPass = new SimpleRenderPass(device, this.shaderQuad, {
            blendState: BlendState.ALPHABLEND
        });

        const clr = [1, 1, 1, 1];

        const { camera, events } = this.scene;

        this.postRenderHandler = (layer: Layer, transparent: boolean) => {
            // only apply when outline mode is enabled
            if (!this.enabled || !events.invoke('view.outlineSelection')) {
                return;
            }

            // apply at the end of the gizmo layer (after overlay renders)
            if (layer !== this.scene.gizmoLayer || !transparent) {
                return;
            }

            events.invoke('selectedClr').toArray(clr);

            this.renderPass.execute({
                srcTexture: camera.workTarget.colorBuffer,
                alphaCutoff: events.invoke('camera.mode') === 'rings' ? 0.0 : 0.8,
                clr
            });
        };

        camera.camera.on('postRenderLayer', this.postRenderHandler);
    }

    remove() {
        // unregister the render hook: component removal does NOT clear
        // on('postRenderLayer') handlers, so leaving this attached would keep
        // firing against a destroyed element / stale workTarget
        if (this.postRenderHandler) {
            this.scene.camera.camera.off('postRenderLayer', this.postRenderHandler);
            this.postRenderHandler = null;
        }
        this.renderPass?.destroy();
        this.shaderQuad?.destroy();
    }

    onPreRender() {
        // no longer need to manage a separate camera
    }
}

export { Outline };
