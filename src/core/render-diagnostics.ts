import type { Splat } from '../splat/splat';

// Facts that decide whether a loaded splat can actually be drawn.
//
// A splat can finish loading while its gsplat instance is not renderable yet:
//   - the instance may not exist (the component was added but the resource
//     never produced one),
//   - the engine creates the instance's sorter lazily, and `orderTexture` only
//     exists on WebGL2 (WebGPU sorts into a storage buffer instead),
//   - the instance only draws once a sort has been applied, so `instancingCount`
//     stays 0 while the sorter has no result (that path needs the culler to
//     hand the instance a camera).
// In any of those states the viewport stays empty without an error, which is the
// worst failure mode to debug. `renderDiagnostics` turns it into a sentence.
type RenderFacts = {
    name: string;
    numSplats: number;
    backend: 'webgl2' | 'webgpu';
    gsplatComponent: boolean;
    hasInstance: boolean;
    hasSorter: boolean;
    hasOrderTexture: boolean;
    entityInScene: boolean;
    entityEnabled: boolean;
    instancingCount: number;
    pendingSortedCount: number;
    hasStreams: boolean;
    // scale vs device limits (the WebGPU backend keeps the sort order in a
    // storage buffer of one u32 per splat, so its size grows with the splat
    // count and can exceed the adapter's binding/buffer limits on large models)
    streamsTexture: string | null;
    orderBufferMB: number | null;
    maxStorageBufferBindingSizeMB: number | null;
    maxBufferSizeMB: number | null;
    maxTextureDimension2D: number | null;
};

const mb = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

const renderDiagnostics = (splat: Splat) => {
    const element = splat as any;
    const entity = element?.entity;
    const instance = entity?.gsplat?.instance;
    const resource = instance?.resource;
    const device = splat?.scene?.graphicsDevice;
    const limits = (device as any)?.limits;

    const dims = resource?.streams?.textureDimensions;
    const numSplats = splat?.numSplats ?? 0;

    const facts: RenderFacts = {
        name: splat?.name ?? null,
        numSplats,
        backend: device?.isWebGPU ? 'webgpu' : 'webgl2',
        gsplatComponent: !!entity?.gsplat,
        hasInstance: !!instance,
        hasSorter: !!instance?.sorter,
        hasOrderTexture: !!instance?.orderTexture,
        entityInScene: !!entity?.parent,
        entityEnabled: !!entity?.enabled,
        instancingCount: instance?.meshInstance?.instancingCount ?? 0,
        pendingSortedCount: instance?.sorter?.pendingSorted?.count ?? 0,
        hasStreams: !!resource?.streams,
        streamsTexture: dims ? `${dims.x}x${dims.y}` : null,
        orderBufferMB: device?.isWebGPU ? mb(numSplats * 4) : null,
        maxStorageBufferBindingSizeMB: limits?.maxStorageBufferBindingSize ? mb(limits.maxStorageBufferBindingSize) : null,
        maxBufferSizeMB: limits?.maxBufferSize ? mb(limits.maxBufferSize) : null,
        maxTextureDimension2D: limits?.maxTextureDimension2D ?? null
    };

    // the WebGPU backend has no order texture by design (it sorts into a storage
    // buffer), so that check only applies to WebGL2
    const orderOk = facts.backend === 'webgpu' || facts.hasOrderTexture;

    const limitsExceeded = facts.backend === 'webgpu' && (
        (limits?.maxStorageBufferBindingSize && numSplats * 4 > limits.maxStorageBufferBindingSize) ||
        (limits?.maxBufferSize && numSplats * 4 > limits.maxBufferSize) ||
        (dims && limits?.maxTextureDimension2D && (dims.x > limits.maxTextureDimension2D || dims.y > limits.maxTextureDimension2D))
    );

    const ok = numSplats > 0 &&
        facts.gsplatComponent &&
        facts.hasInstance &&
        facts.hasSorter &&
        orderOk &&
        facts.entityInScene &&
        facts.entityEnabled &&
        // instancingCount is the number of draw instances (each one packs
        // instanceSize splats): 0 means the sorter handed the renderer nothing,
        // which is exactly "loaded but the viewport stays empty"
        facts.instancingCount > 0 &&
        !limitsExceeded;

    const missing = (Object.keys(facts) as (keyof RenderFacts)[])
    .filter(key => typeof facts[key] === 'boolean' && !facts[key])
    .filter(key => !(key === 'hasOrderTexture' && facts.backend === 'webgpu'));

    const blockers: string[] = [];
    if (facts.gsplatComponent && facts.hasInstance && facts.instancingCount === 0) {
        blockers.push('no drawable instances (the sorter produced no result for the camera)');
    }
    if (facts.backend === 'webgpu') {
        const orderBytes = numSplats * 4;
        if (limits?.maxStorageBufferBindingSize && orderBytes > limits.maxStorageBufferBindingSize) {
            blockers.push(`the sort order needs ${facts.orderBufferMB} MB but this WebGPU adapter limits a storage buffer binding to ${facts.maxStorageBufferBindingSizeMB} MB`);
        }
        if (limits?.maxBufferSize && orderBytes > limits.maxBufferSize) {
            blockers.push(`the sort order needs ${facts.orderBufferMB} MB but this WebGPU adapter limits one buffer to ${facts.maxBufferSizeMB} MB`);
        }
        if (dims && limits?.maxTextureDimension2D && (dims.x > limits.maxTextureDimension2D || dims.y > limits.maxTextureDimension2D)) {
            blockers.push(`the splat data needs a ${facts.streamsTexture} texture but this adapter limits textures to ${limits.maxTextureDimension2D} px`);
        }
    }

    // advisory, never a failure on its own (small models render fine here)
    const warnings = facts.backend === 'webgpu' ? [
        'WebGPU is an experimental backend in this build: large models, 8K export, the centers overlay and some readback paths may not work. Switch Graphics backend to WebGL2 in Settings and restart if this model does not display.'
    ] : [];

    const summary = ok ?
        `renderable (${numSplats} splats, ${facts.instancingCount} draw instances)` :
        `${missing.length || blockers.length ? `NOT renderable: ${[...missing, ...blockers].join('; ')}` : 'renderable'}`;

    return { ok, facts, summary, warnings };
};

export { renderDiagnostics };
export type { RenderFacts };
