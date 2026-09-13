import { Events } from '../core/events';
import { opFromModifiers } from '../core/select-op';

// Depth-aligned 3D sphere brush (V3, SuperSplat-style "Sphere Brush", Shift+B).
//
// The stroke is recorded as a dense path of samples, each with the brush radius
// in css pixels at the time it was taken (so a stroke can taper), and drawn into
// the shared stroke mask. On pointer-up the editor depth-picks every sample in
// one batched pass and runs the whole path through a single GPU intersect, so
// the brush hugs the visible surface without paying per-sample readbacks.
class SphereBrushSelection {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, parent: HTMLElement, mask: { canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, busy?: boolean }) {
        // create svg
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('tool-svg', 'hidden');
        svg.id = 'sphere-brush-select-svg';
        parent.appendChild(svg);

        // shaded-sphere cursor: a radial gradient fill reads as a ball rolling
        // over the surface
        const defs = document.createElementNS(svg.namespaceURI, 'defs');
        const gradient = document.createElementNS(svg.namespaceURI, 'radialGradient');
        gradient.id = 'sphere-brush-gradient';
        gradient.setAttribute('cx', '37%');
        gradient.setAttribute('cy', '33%');
        gradient.setAttribute('r', '72%');
        [['0%', '0.5'], ['55%', '0.25'], ['100%', '0.08']].forEach(([offset, opacity]) => {
            const stop = document.createElementNS(svg.namespaceURI, 'stop');
            stop.setAttribute('offset', offset);
            stop.setAttribute('stop-color', '#f60');
            stop.setAttribute('stop-opacity', opacity);
            gradient.appendChild(stop);
        });
        defs.appendChild(gradient);
        svg.appendChild(defs);

        const circle = document.createElementNS(svg.namespaceURI, 'circle') as SVGCircleElement;
        svg.appendChild(circle);

        const { canvas, context } = mask;

        let radius = 40;
        // 厚度 (thickness): the depth slab along the view direction, in the same unit
        // as the brush radius (css pixels at the stroke's depth). 0 = the plain
        // sphere brush. Exposed through the settings panel's sliders and carried into
        // the stroke so the editor can turn it into world units.
        let thickness = 0;

        circle.setAttribute('r', radius.toString());

        const prev = { x: 0, y: 0 };
        let dragId: number | undefined;
        const points: { x: number, y: number, radius: number }[] = [];

        // track the pointer while the tool is inactive too (the tools overlay is
        // hidden then), so activation places the cursor at the mouse rather than
        // where the previous stroke ended
        const pointer = { x: 0, y: 0 };
        window.addEventListener('pointermove', (e: PointerEvent) => {
            pointer.x = e.clientX;
            pointer.y = e.clientY;
        }, { capture: true, passive: true });

        // append a stroke sample, interpolating extra samples so consecutive
        // path points sit at most a fraction of the brush radius apart (the GPU
        // stitches them into capsules - a coarse path would scallop)
        const appendPoint = (x: number, y: number, force = false) => {
            const last = points[points.length - 1];
            if (!last) {
                points.push({ x, y, radius });
                return;
            }

            const dx = x - last.x;
            const dy = y - last.y;
            const distance = Math.hypot(dx, dy);
            const spacing = Math.max(2, Math.min(last.radius, radius) * 0.25);
            const steps = Math.floor(distance / spacing);
            for (let i = 1; i <= steps; ++i) {
                const t = i * spacing / distance;
                points.push({
                    x: last.x + dx * t,
                    y: last.y + dy * t,
                    radius: last.radius + (radius - last.radius) * t
                });
            }

            if (force) {
                const tail = points[points.length - 1];
                if (tail.x !== x || tail.y !== y || tail.radius !== radius) {
                    points.push({ x, y, radius });
                }
            }
        };

        const update = (e: PointerEvent) => {
            const x = e.offsetX;
            const y = e.offsetY;

            circle.setAttribute('cx', x.toString());
            circle.setAttribute('cy', y.toString());

            if (dragId !== undefined) {
                appendPoint(x, y);

                context.beginPath();
                context.strokeStyle = '#f60';
                context.lineCap = 'round';
                context.lineWidth = radius * 2;
                context.moveTo(prev.x, prev.y);
                context.lineTo(x, y);
                context.stroke();

                prev.x = x;
                prev.y = y;
            }
        };

        const pointerdown = (e: PointerEvent) => {
            if (dragId === undefined && (e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary)) {
                e.preventDefault();
                e.stopPropagation();

                // a stroke attempted while the previous selection is still
                // pending is swallowed rather than left to orbit the camera
                if (mask.busy) {
                    return;
                }

                dragId = e.pointerId;
                parent.setPointerCapture(dragId);

                // initialize canvas
                if (canvas.width !== parent.clientWidth || canvas.height !== parent.clientHeight) {
                    canvas.width = parent.clientWidth;
                    canvas.height = parent.clientHeight;
                }

                // clear canvas
                context.clearRect(0, 0, canvas.width, canvas.height);

                // display it
                canvas.style.display = 'inline';

                prev.x = e.offsetX;
                prev.y = e.offsetY;
                points.length = 0;
                appendPoint(prev.x, prev.y);

                update(e);
            }
        };

        const pointermove = (e: PointerEvent) => {
            if (dragId !== undefined) {
                e.preventDefault();
                e.stopPropagation();
            }

            update(e);
        };

        const dragEnd = () => {
            // a touch that has lifted, or was cancelled, no longer holds the
            // capture and releasing it throws
            if (parent.hasPointerCapture(dragId)) {
                parent.releasePointerCapture(dragId);
            }
            dragId = undefined;
            canvas.style.display = 'none';
        };

        const pointerup = async (e: PointerEvent) => {
            if (e.pointerId === dragId) {
                e.preventDefault();
                e.stopPropagation();

                appendPoint(e.offsetX, e.offsetY, true);

                dragEnd();

                // block new strokes until the async selection has consumed the
                // shared mask canvas and finished its depth picking
                mask.busy = true;
                try {
                    await events.invoke(
                        'select.bySphereBrush',
                        opFromModifiers(e),
                        points.map(point => ({
                            x: point.x / canvas.width,
                            y: point.y / canvas.height,
                            radius: point.radius
                        })),
                        canvas,
                        thickness
                    );
                } finally {
                    mask.busy = false;
                }
            }
        };

        // a cancelled touch gets no pointerup, and a drag left open blocks every
        // later one
        const pointercancel = (e: PointerEvent) => {
            if (e.pointerId === dragId) {
                dragEnd();
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

        this.activate = () => {
            svg.classList.remove('hidden');
            parent.style.display = 'block';

            const rect = parent.getBoundingClientRect();
            circle.setAttribute('cx', (pointer.x - rect.left).toString());
            circle.setAttribute('cy', (pointer.y - rect.top).toString());

            parent.addEventListener('pointerdown', pointerdown);
            parent.addEventListener('pointermove', pointermove);
            parent.addEventListener('pointerup', pointerup);
            parent.addEventListener('pointercancel', pointercancel);
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
            parent.removeEventListener('pointercancel', pointercancel);
            parent.removeEventListener('wheel', wheel);
        };

        // share the 2d brush's size events so the [ and ] shortcuts (and
        // alt+wheel) adjust whichever brush is active
        events.on('tool.brushSelection.smaller', () => {
            radius = Math.max(1, radius / 1.05);
            circle.setAttribute('r', radius.toString());
            events.fire('tool.brushSelection.changed', { radius, thickness });
        });

        events.on('tool.brushSelection.bigger', () => {
            radius = Math.min(500, radius * 1.05);
            circle.setAttribute('r', radius.toString());
            events.fire('tool.brushSelection.changed', { radius, thickness });
        });

        // the settings panel's two sliders: size (the brush radius) and thickness
        // (how deep along the view the stroke reaches)
        events.function('tool.brushSelection.settings', () => ({ radius, thickness }));

        events.on('tool.brushSelection.setSettings', (settings: { radius?: number, thickness?: number }) => {
            if (typeof settings?.radius === 'number' && Number.isFinite(settings.radius)) {
                radius = Math.max(1, Math.min(500, settings.radius));
                circle.setAttribute('r', radius.toString());
            }
            if (typeof settings?.thickness === 'number' && Number.isFinite(settings.thickness)) {
                thickness = Math.max(0, Math.min(500, settings.thickness));
            }
            events.fire('tool.brushSelection.changed', { radius, thickness });
        });
    }
}

export { SphereBrushSelection };
