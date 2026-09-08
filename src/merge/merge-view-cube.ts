import { Mat4, Vec3 } from 'playcanvas';

const vecx = new Vec3();
const vecy = new Vec3();
const vecz = new Vec3();
const mat4 = new Mat4();

/**
 * 移植自主程序 ViewCube 的右上角坐标轴（SVG 三轴线 + 方向圆点 + painter 排序）。
 * 点击正方向圆点 → onAlign(axis, neg)。merge 中映射到 snapToAxis。
 */
class MergeViewCube {
    private root: HTMLDivElement;
    private group: SVGGElement;
    private svg: SVGSVGElement;
    private shapes: Record<string, SVGElement>;
    private cw = 0;
    private ch = 0;

    constructor(onAlign: (axis: 'x' | 'y' | 'z', neg: boolean) => void) {
        this.root = document.createElement('div');
        this.root.style.cssText =
            'position:fixed;right:0;top:0;width:140px;height:140px;z-index:9;pointer-events:none;user-select:none;';
        this.root.id = 'merge-view-cube';

        this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.svg.id = 'merge-view-cube-svg';
        this.group = document.createElementNS(this.svg.namespaceURI, 'g') as SVGGElement;
        this.svg.appendChild(this.group);

        const circle = (color: string, fill: boolean, text?: string) => {
            const result = document.createElementNS(this.svg.namespaceURI, 'g') as SVGElement;

            const c = document.createElementNS(this.svg.namespaceURI, 'circle') as SVGCircleElement;
            c.setAttribute('fill', fill ? color : '#222');
            c.setAttribute('stroke', color);
            c.setAttribute('stroke-width', '2');
            c.setAttribute('r', '10');
            c.setAttribute('cx', '0');
            c.setAttribute('cy', '0');
            c.setAttribute('pointer-events', 'all');
            result.appendChild(c);

            if (text) {
                const t = document.createElementNS(this.svg.namespaceURI, 'text') as SVGTextElement;
                t.setAttribute('font-size', '10');
                t.setAttribute('font-family', 'Arial');
                t.setAttribute('font-weight', 'bold');
                t.setAttribute('text-anchor', 'middle');
                t.setAttribute('alignment-baseline', 'central');
                t.textContent = text;
                result.appendChild(t);
            }

            result.setAttribute('cursor', 'pointer');
            result.setAttribute('pointer-events', 'all');
            this.group.appendChild(result);
            return result;
        };

        const line = (color: string) => {
            const result = document.createElementNS(this.svg.namespaceURI, 'line') as SVGLineElement;
            result.setAttribute('stroke', color);
            result.setAttribute('stroke-width', '2');
            this.group.appendChild(result);
            return result;
        };

        const r = '#f44';
        const g = '#4f4';
        const b = '#77f';

        this.shapes = {
            nx: circle(r, false),
            ny: circle(g, false),
            nz: circle(b, false),
            xaxis: line(r),
            yaxis: line(g),
            zaxis: line(b),
            px: circle(r, true, 'X'),
            py: circle(g, true, 'Y'),
            pz: circle(b, true, 'Z')
        };

        // 六个方向：正方向映射 (axis, neg=false)，负方向 (axis, neg=true)
        const dirs: Record<string, [string, boolean]> = {
            px: ['x', false],
            nx: ['x', true],
            py: ['y', false],
            ny: ['y', true],
            pz: ['z', false],
            nz: ['z', true]
        };
        for (const key of ['px', 'nx', 'py', 'ny', 'pz', 'nz']) {
            const el = this.shapes[key] as SVGElement;
            el.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                const [axis, neg] = dirs[key];
                onAlign(axis as 'x' | 'y' | 'z', neg);
            });
        }

        this.root.appendChild(this.svg);
        document.body.appendChild(this.root);
    }

    remove(): void {
        this.root.remove();
    }

    update(cameraMatrix: Mat4): void {
        const w = this.root.clientWidth;
        const h = this.root.clientHeight;

        if (w && h) {
            if (w !== this.cw || h !== this.ch) {
                this.svg.setAttribute('width', w.toString());
                this.svg.setAttribute('height', h.toString());
                this.group.setAttribute('transform', `translate(${w * 0.5}, ${h * 0.5})`);
                this.cw = w;
                this.ch = h;
            }

            mat4.invert(cameraMatrix);
            mat4.getX(vecx);
            mat4.getY(vecy);
            mat4.getZ(vecz);

            const transform = (el: SVGElement, x: number, y: number) => {
                el.setAttribute('transform', `translate(${x * 40}, ${y * 40})`);
            };
            const x2y2 = (el: SVGLineElement, x: number, y: number) => {
                el.setAttribute('x2', (x * 40).toString());
                el.setAttribute('y2', (y * 40).toString());
            };

            transform(this.shapes.px as SVGElement, vecx.x, -vecx.y);
            transform(this.shapes.nx as SVGElement, -vecx.x, vecx.y);
            transform(this.shapes.py as SVGElement, vecy.x, -vecy.y);
            transform(this.shapes.ny as SVGElement, -vecy.x, vecy.y);
            transform(this.shapes.pz as SVGElement, vecz.x, -vecz.y);
            transform(this.shapes.nz as SVGElement, -vecz.x, vecz.y);

            x2y2(this.shapes.xaxis as SVGLineElement, vecx.x, -vecx.y);
            x2y2(this.shapes.yaxis as SVGLineElement, vecy.x, -vecy.y);
            x2y2(this.shapes.zaxis as SVGLineElement, vecz.x, -vecz.y);

            // painter's algorithm：按深度重排 DOM
            const order = [
                { n: ['xaxis', 'px'], value: vecx.z },
                { n: ['yaxis', 'py'], value: vecy.z },
                { n: ['zaxis', 'pz'], value: vecz.z },
                { n: ['nx'], value: -vecx.z },
                { n: ['ny'], value: -vecy.z },
                { n: ['nz'], value: -vecz.z }
            ].sort((a, b) => a.value - b.value);

            const fragment = document.createDocumentFragment();
            order.forEach((o) => {
                o.n.forEach((n) => {
                    fragment.appendChild(this.shapes[n]);
                });
            });
            this.group.appendChild(fragment);
        }
    }
}

export { MergeViewCube };
