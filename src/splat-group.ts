import { BoundingBox, Vec3 } from 'playcanvas';
import { Events } from './events';
import { Splat } from './splat';

let _nextId = 0;

class SplatGroup {
    id: number;
    name: string;
    splats: Set<Splat> = new Set();

    private _events: Events;
    private _bound = new BoundingBox();
    private _dirty = true;

    constructor(events: Events, splats: Splat[], name?: string) {
        this._events = events;
        this.id = _nextId++;
        this.name = name ?? `Group ${this.id}`;
        for (const s of splats) {
            this.splats.add(s);
        }
        events.fire('group.created', this);
    }

    get size(): number {
        return this.splats.size;
    }

    get isEmpty(): boolean {
        return this.splats.size === 0;
    }

    markDirty() {
        this._dirty = true;
    }

    get bound(): BoundingBox {
        if (this._dirty) {
            this._recalcBound();
        }
        return this._bound;
    }

    get focalPoint(): Vec3 {
        // Density-weighted center across all splats, each weighted by its
        // Gaussian count so larger models contribute proportionally more.
        const result = new Vec3();
        let totalWeight = 0;
        for (const s of this.splats) {
            const fp = s.focalPoint();
            const n = s.numSplats;
            result.x += fp.x * n;
            result.y += fp.y * n;
            result.z += fp.z * n;
            totalWeight += n;
        }
        if (totalWeight > 0) {
            result.mulScalar(1 / totalWeight);
        }
        return result;
    }

    get radius(): number {
        const b = this.bound;
        return b.halfExtents.length();
    }

    get denseRadius(): number {
        // Weighted average of member splats' dense radii, weighted by
        // Gaussian count so larger models contribute proportionally more.
        let totalWeight = 0;
        let weightedSum = 0;
        for (const s of this.splats) {
            const dr = s.denseRadius();
            const n = s.numSplats;
            weightedSum += dr * n;
            totalWeight += n;
        }
        return totalWeight > 0 ? weightedSum / totalWeight : this.radius;
    }

    add(splat: Splat): boolean {
        if (this.splats.has(splat)) return false;
        this.splats.add(splat);
        this._dirty = true;
        return true;
    }

    remove(splat: Splat): boolean {
        const result = this.splats.delete(splat);
        if (result) this._dirty = true;
        return result;
    }

    has(splat: Splat): boolean {
        return this.splats.has(splat);
    }

    private _recalcBound() {
        this._bound.center.set(0, 0, 0);
        this._bound.halfExtents.set(0, 0, 0);

        let first = true;
        for (const splat of this.splats) {
            const wb = splat.worldBound;
            if (!wb) continue;
            if (first) {
                this._bound.copy(wb);
                first = false;
            } else {
                this._bound.add(wb);
            }
        }
        this._dirty = false;
    }
}

class GroupManager {
    groups: SplatGroup[] = [];
    private events: Events;

    constructor(events: Events) {
        this.events = events;

        // update group bounds when splats move
        events.on('splat.moved', (splat: Splat) => {
            for (const g of this.groups) {
                if (g.has(splat)) {
                    g.markDirty();
                }
            }
        });

        // remove splat from groups when it's destroyed
        events.on('scene.elementRemoved', (element: any) => {
            if (element && element.type === 'splat') {
                this.removeSplatFromAll(element as Splat);
            }
        });
    }

    create(splats: Splat[], name?: string): SplatGroup {
        const group = new SplatGroup(this.events, splats, name);
        this.groups.push(group);
        return group;
    }

    remove(group: SplatGroup) {
        const idx = this.groups.indexOf(group);
        if (idx !== -1) {
            this.groups.splice(idx, 1);
            this.events.fire('group.removed', group);
        }
    }

    removeSplatFromAll(splat: Splat) {
        for (const g of this.groups) {
            g.remove(splat);
            if (g.isEmpty) {
                this.remove(g);
            }
        }
    }

    getForSplat(splat: Splat): SplatGroup | null {
        for (const g of this.groups) {
            if (g.has(splat)) return g;
        }
        return null;
    }

    getForSplats(splats: Splat[]): SplatGroup | null {
        for (const g of this.groups) {
            if (g.size === splats.length && splats.every(s => g.has(s))) {
                return g;
            }
        }
        return null;
    }

    getGroupsContaining(splat: Splat): SplatGroup[] {
        return this.groups.filter(g => g.has(splat));
    }
}

export { SplatGroup, GroupManager };
