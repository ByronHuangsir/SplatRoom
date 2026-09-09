import { Events } from '../events';
import { opFromModifiers } from '../select-op';

// Depth-aligned 3D sphere brush (V3, SuperSplat-style "Sphere Brush").
// Dragging paints small spheres whose centers hug the visible surface: pointer
// samples are recorded while dragging and on pointer-up the editor's
// select.bySphereBrush handler depth-picks the front-most surface point under
// each sample and applies a sphere selection there. A stroke therefore stays a
// single gesture with bounded, throttled GPU work per sample.
class SphereBrushSelection {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, parent: HTMLElement) {
        // create svg
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('tool-svg', 'hidden');
        svg.id = 'sphere-brush-select-svg';
        parent.appendChild(svg);

        // cursor circle showing the brush radius
        const circle = document.createElementNS(svg.namespaceURI, 'circle') as SVGCircleElement;
        circle.setAttribute('fill', 'none');
        circle.setAttribute('stroke', '#f60');
        circle.setAttribute('stroke-width', '2');
        svg.appendChild(circle);

        let radius = 40;
        circle.setAttribute('r', radius.toString());

        const samples: Array<{ x: number, y: number }> = [];
        let last: { x: number, y: number } | null = null;
        let dragId: number | undefined;

        const update = (e: PointerEvent) => {
            circle.setAttribute('cx', e.offsetX.toString());
            circle.setAttribute('cy', e.offsetY.toString());
        };

        // record a sample (spaced so overlapping spheres stay bounded)
        const record = (e: PointerEvent) => {
            const width = Math.max(1, parent.clientWidth);
            const height = Math.max(1, parent.clientHeight);
            const x = e.offsetX;
            const y = e.offsetY;
            const spacing = Math.max(6, radius * 0.35);
            if (!last || Math.hypot(x - last.x, y - last.y) >= spacing) {
                if (samples.length < 512) {
                    samples.push({ x: x / width, y: y / height });
                }
                last = { x, y };
            }
        };

        const pointerdown = (e: PointerEvent) => {
            if (dragId === undefined && (e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary)) {
                e.preventDefault();
                e.stopPropagation();

                dragId = e.pointerId;
                parent.setPointerCapture(dragId);

                samples.length = 0;
                last = null;
                update(e);
                record(e);
            }
        };

        const pointermove = (e: PointerEvent) => {
            if (dragId !== undefined) {
                e.preventDefault();
                e.stopPropagation();
                update(e);
                record(e);
            } else {
                update(e);
            }
        };

        const dragEnd = () => {
            parent.releasePointerCapture(dragId);
            dragId = undefined;
        };

        const pointerup = async (e: PointerEvent) => {
            if (e.pointerId === dragId) {
                e.preventDefault();
                e.stopPropagation();

                dragEnd();

                if (samples.length) {
                    await events.invoke(
                        'select.bySphereBrush',
                        opFromModifiers(e),
                        samples.slice(),
                        radius
                    );
                }
            }
        };

        const wheel = (e: WheelEvent) => {
            if (e.altKey || e.metaKey) {
                const { deltaX, deltaY } = e;
                events.fire((Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY) > 0 ? 'tool.brushSelection.smaller' : 'tool.brushSelection.bigger');
                e.preventDefault();
                e.stopPropagation();
            }
        };

        const syncCircle = () => {
            circle.setAttribute('r', radius.toString());
        };

        this.activate = () => {
            svg.classList.remove('hidden');
            parent.style.display = 'block';
            parent.addEventListener('pointerdown', pointerdown);
            parent.addEventListener('pointermove', pointermove);
            parent.addEventListener('pointerup', pointerup);
            parent.addEventListener('wheel', wheel);
        };

        this.deactivate = () => {
            // cancel active operation
            if (dragId !== undefined) {
                dragEnd();
            }
            svg.classList.add('hidden');
            parent.style.display = 'none';
            parent.removeEventListener('pointerdown', pointerdown);
            parent.removeEventListener('pointermove', pointermove);
            parent.removeEventListener('pointerup', pointerup);
            parent.removeEventListener('wheel', wheel);
        };

        // share the brush size hotkeys / wheel behaviour with the 2D brush
        events.on('tool.brushSelection.smaller', () => {
            radius = Math.max(1, radius / 1.05);
            syncCircle();
        });

        events.on('tool.brushSelection.bigger', () => {
            radius = Math.min(500, radius * 1.05);
            syncCircle();
        });
    }
}

export { SphereBrushSelection };
