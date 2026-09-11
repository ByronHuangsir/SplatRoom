import { Splat } from './splat';

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
};

const renderDiagnostics = (splat: Splat) => {
    const element = splat as any;
    const entity = element?.entity;
    const instance = entity?.gsplat?.instance;
    const resource = instance?.resource;
    const device = splat?.scene?.graphicsDevice;

    const facts: RenderFacts = {
        name: splat?.name ?? null,
        numSplats: splat?.numSplats ?? 0,
        backend: device?.isWebGPU ? 'webgpu' : 'webgl2',
        gsplatComponent: !!entity?.gsplat,
        hasInstance: !!instance,
        hasSorter: !!instance?.sorter,
        hasOrderTexture: !!instance?.orderTexture,
        entityInScene: !!entity?.parent,
        entityEnabled: !!entity?.enabled,
        instancingCount: instance?.meshInstance?.instancingCount ?? 0,
        pendingSortedCount: instance?.sorter?.pendingSorted?.count ?? 0,
        hasStreams: !!resource?.streams
    };

    const ok = facts.numSplats > 0 &&
        facts.gsplatComponent &&
        facts.hasInstance &&
        facts.hasSorter &&
        facts.hasOrderTexture &&
        facts.entityInScene &&
        facts.entityEnabled &&
        // instancingCount is the number of draw instances (each one packs
        // instanceSize splats): 0 means the sorter handed the renderer nothing,
        // which is exactly "loaded but the viewport stays empty"
        facts.instancingCount > 0;

    const missing = (Object.keys(facts) as (keyof RenderFacts)[])
    .filter(key => typeof facts[key] === 'boolean' && !facts[key]);

    const notes: string[] = [];
    if (facts.gsplatComponent && facts.hasInstance && facts.instancingCount === 0) {
        notes.push('no drawable instances (the sorter produced no result for the camera)');
    }
    if (facts.backend === 'webgpu') {
        notes.push('WebGPU backend: this render path is experimental — switch Graphics backend to WebGL2 in Settings and restart');
    }

    const summary = ok ?
        `renderable (${facts.numSplats} splats, ${facts.instancingCount} draw instances)` :
        `NOT renderable: ${missing.length ? missing.join(', ') : 'unknown'}${notes.length ? ` — ${notes.join('; ')}` : ''}`;

    return { ok, facts, summary };
};

export { renderDiagnostics, RenderFacts };
