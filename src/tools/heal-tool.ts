import { Events } from '../events';
import { opFromModifiers } from '../select-op';

type Point = { x: number, y: number };

class HealTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, parent: HTMLElement, mask: { canvas: HTMLCanvasElement, context: CanvasRenderingContext2D }) {
        // create svg for lasso drawing
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('tool-svg', 'hidden');
        svg.id = 'heal-tool-svg';
        parent.appendChild(svg);

        // create polygon element for lasso
        const polygon = document.createElementNS(svg.namespaceURI, 'polygon') as SVGPolygonElement;
        svg.appendChild(polygon);

        // create a custom cursor indicator
        const cursor = document.createElement('div');
        cursor.id = 'heal-tool-cursor';
        cursor.style.cssText = 'position:absolute;width:12px;height:12px;border:1.5px solid #f60;border-radius:50%;pointer-events:none;transform:translate(-50%,-50%);display:none;z-index:1000;';
        parent.appendChild(cursor);

        const { canvas, context } = mask;
        let points: Point[] = [];
        let currentPoint: Point = null;
        let lastPointTime = 0;

        const dist = (a: Point, b: Point) => {
            return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
        };

        const isClosed = () => {
            return points.length > 1 && currentPoint && dist(currentPoint, points[0]) < 8;
        };

        const paint = () => {
            if (points.length === 0) {
                polygon.setAttribute('points', '');
                return;
            }
            polygon.setAttribute('points', [...points, currentPoint].filter(p => p).reduce((prev, current) => `${prev}${current.x}, ${current.y} `, ''));
            polygon.setAttribute('stroke', isClosed() ? '#fa6' : '#f60');
            polygon.setAttribute('stroke-width', '2');
            polygon.setAttribute('fill', 'none');
        };

        let dragId: number | undefined;

        const update = (e: PointerEvent) => {
            currentPoint = { x: e.offsetX, y: e.offsetY };

            const distance = points.length === 0 ? 0 : dist(currentPoint, points[points.length - 1]);
            const millis = Date.now() - lastPointTime;
            const preventCorners = distance > 20;
            const slowNarrowSpacing = millis > 500 && distance > 2;
            const fasterMediumSpacing = millis > 200 && distance > 10;
            const firstPoints = points.length === 0;

            if (dragId !== undefined && (preventCorners || slowNarrowSpacing || fasterMediumSpacing || firstPoints)) {
                points.push(currentPoint);
                lastPointTime = Date.now();
            }
            paint();
        };

        const commitSelection = async (e: PointerEvent) => {
            if (points.length < 3) return;

            // initialize canvas
            if (canvas.width !== parent.clientWidth || canvas.height !== parent.clientHeight) {
                canvas.width = parent.clientWidth;
                canvas.height = parent.clientHeight;
            }

            // clear canvas
            context.clearRect(0, 0, canvas.width, canvas.height);

            // draw filled lasso polygon
            context.beginPath();
            context.fillStyle = '#f60';
            context.beginPath();
            points.forEach((p, idx) => {
                if (idx === 0) {
                    context.moveTo(p.x, p.y);
                } else {
                    context.lineTo(p.x, p.y);
                }
            });
            context.closePath();
            context.fill();

            // Fire heal.select event - editor.ts handles depth-limited selection
            await events.invoke(
                'heal.select',
                opFromModifiers(e),
                canvas,
                context
            );
        };

        const pointerdown = (e: PointerEvent) => {
            if (dragId === undefined && (e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary)) {
                e.preventDefault();
                e.stopPropagation();

                dragId = e.pointerId;
                parent.setPointerCapture(dragId);

                points = [];
                update(e);
            }
        };

        const pointermove = (e: PointerEvent) => {
            if (dragId !== undefined) {
                e.preventDefault();
                e.stopPropagation();
            }
            // update cursor position
            cursor.style.left = `${e.offsetX}px`;
            cursor.style.top = `${e.offsetY}px`;

            update(e);
        };

        const dragEnd = () => {
            parent.releasePointerCapture(dragId);
            dragId = undefined;
        };

        const pointerup = async (e: PointerEvent) => {
            if (e.pointerId === dragId) {
                e.preventDefault();
                e.stopPropagation();

                await commitSelection(e);

                dragEnd();

                points = [];
                paint();
            }
        };

        this.activate = () => {
            svg.classList.remove('hidden');
            parent.style.display = 'block';
            cursor.style.display = 'block';
            parent.addEventListener('pointerdown', pointerdown);
            parent.addEventListener('pointermove', pointermove);
            parent.addEventListener('pointerup', pointerup);
            // show the heal panel
            events.fire('heal.activated');
        };

        this.deactivate = () => {
            if (dragId !== undefined) {
                dragEnd();
            }
            svg.classList.add('hidden');
            parent.style.display = 'none';
            cursor.style.display = 'none';
            parent.removeEventListener('pointerdown', pointerdown);
            parent.removeEventListener('pointermove', pointermove);
            parent.removeEventListener('pointerup', pointerup);
            points = [];
            paint();
            // hide the heal panel
            events.fire('heal.deactivated');
        };
    }
}

export { HealTool };
