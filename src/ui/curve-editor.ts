/**
 * 曲线调色的编辑器控件（SVG）。
 *
 * 交互（与 Lightroom / 相机厂商软件一致）：
 *   - 空白处按下 ⇒ 新增一个控制点并立刻进入拖动；
 *   - 已有控制点上按下 ⇒ 拖动它（x 夹在左右邻点之间，y 夹在 0..1）；
 *   - 双击控制点 ⇒ 删除（两个端点不能删，只能上下拖 —— 抬黑/压白就是拖端点）；
 *   - 拖动过程持续发 `change`，按下/松开分别发 `gestureStart` / `gestureEnd`
 *     （面板用它们把整段拖动**合并成一次撤销**）。
 *
 * 为什么不用 canvas：SVG 的命中测试、缩放、描边都由浏览器处理，而且控制点可直接用
 * 真实鼠标事件驱动（本仓库的探针/套件就是靠 `page.mouse` 拖真控件的）。
 *
 * 坐标系：viewBox 固定 `0 0 100 100` + `preserveAspectRatio="none"`，
 * 于是"数据坐标 = 归一化坐标 × 100"，命中测试与控件实际宽高无关（不需要方框是正方形）。
 */
import { Container } from '@playcanvas/pcui';

import { type CurvePoint, normalizeCurvePoints, sampleCurve } from '../core/color-curves';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 命中控制点的半径（归一化单位；0.06 ≈ 控件宽度/高度的 6%） */
const HIT_RADIUS = 0.06;
/** 端点横坐标锁定 */
const isEndpoint = (points: CurvePoint[], index: number) => index === 0 || index === points.length - 1;

class CurveEditor extends Container {
    /** 控制点（含两个端点；x 递增） */
    private points: CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];

    private svg: SVGSVGElement;
    private curvePath: SVGPolylineElement;
    private guides: SVGGElement;
    private dots: SVGCircleElement[] = [];

    /** 当前被拖动的控制点下标（-1 = 没在拖） */
    private dragIndex = -1;
    private dragging = false;

    constructor() {
        super({ class: 'curve-editor' });

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.classList.add('curve-editor-svg');

        // 网格 + 对角线（恒等参考）
        const guides = document.createElementNS(SVG_NS, 'g');
        guides.setAttribute('class', 'curve-guides');
        for (const v of [25, 50, 75]) {
            const h = document.createElementNS(SVG_NS, 'line');
            h.setAttribute('x1', '0');
            h.setAttribute('y1', `${100 - v}`);
            h.setAttribute('x2', '100');
            h.setAttribute('y2', `${100 - v}`);
            guides.append(h);
            const vl = document.createElementNS(SVG_NS, 'line');
            vl.setAttribute('x1', `${v}`);
            vl.setAttribute('y1', '0');
            vl.setAttribute('x2', `${v}`);
            vl.setAttribute('y2', '100');
            guides.append(vl);
        }
        const diag = document.createElementNS(SVG_NS, 'line');
        diag.setAttribute('class', 'curve-diagonal');
        diag.setAttribute('x1', '0');
        diag.setAttribute('y1', '100');
        diag.setAttribute('x2', '100');
        diag.setAttribute('y2', '0');
        guides.append(diag);
        svg.append(guides);

        // 曲线本身（33 个采样点折线，与着色器用的是同一张表）
        const path = document.createElementNS(SVG_NS, 'polyline');
        path.setAttribute('class', 'curve-line');
        svg.append(path);

        // 控制点
        const dotsGroup = document.createElementNS(SVG_NS, 'g');
        dotsGroup.setAttribute('class', 'curve-dots');
        svg.append(dotsGroup);

        this.dom.append(svg);
        this.svg = svg;
        this.curvePath = path;
        this.guides = guides;

        svg.addEventListener('pointerdown', this.onPointerDown);
        svg.addEventListener('pointermove', this.onPointerMove);
        svg.addEventListener('pointerup', this.onPointerUp);
        svg.addEventListener('pointercancel', this.onPointerUp);
        svg.addEventListener('dblclick', this.onDoubleClick);
        // 拖出控件也要能被捕获
        svg.addEventListener('pointerleave', (e: PointerEvent) => {
            if (this.dragging && e.buttons === 0) {
                this.onPointerUp(e);
            }
        });

        this.render();
    }

    /** 当前控制点（拷贝，外部改了不影响控件） */
    getPoints(): CurvePoint[] {
        return this.points.map(p => ({ ...p }));
    }

    /**
     * 设置控制点（会归一化）。
     *
     * @param points - 控制点；传 `null` 或不足 2 个 ⇒ 回到恒等（不触发 `change`）
     * @param silent - true 时只重画、不发 `change`（UI 回填用）
     */
    setPoints(points: CurvePoint[] | null, silent = true) {
        this.points = points && points.length >= 2 ?
            normalizeCurvePoints(points) :
            [{ x: 0, y: 0 }, { x: 1, y: 1 }];
        this.render();
        if (!silent) {
            this.emitChange();
        }
    }

    /** 回到恒等曲线 */
    reset() {
        this.setPoints([{ x: 0, y: 0 }, { x: 1, y: 1 }], false);
    }

    private emitChange() {
        this.emit('change', this.getPoints());
    }

    /** 客户端坐标 → 归一化数据坐标（左上角为 (0,1)） */
    private toData(e: PointerEvent): CurvePoint {
        const rect = this.svg.getBoundingClientRect();
        const x = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
        const y = rect.height > 0 ? 1 - (e.clientY - rect.top) / rect.height : 0;
        return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
    }

    /** 找到命中半径内最近的控制点；没有则返回 -1 */
    private hitTest(p: CurvePoint): number {
        let best = -1;
        let bestDist = HIT_RADIUS;
        for (let i = 0; i < this.points.length; i++) {
            const d = Math.hypot(this.points[i].x - p.x, this.points[i].y - p.y);
            if (d <= bestDist) {
                bestDist = d;
                best = i;
            }
        }
        return best;
    }

    private onPointerDown = (e: PointerEvent) => {
        if (e.button !== 0) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();

        const p = this.toData(e);
        let index = this.hitTest(p);
        if (index < 0) {
            // 空白处按下 ⇒ 新增一个点
            const next = normalizeCurvePoints([...this.points, p]);
            this.points = next;
            index = next.findIndex(q => Math.abs(q.x - p.x) < 1e-6 && Math.abs(q.y - p.y) < 1e-6);
            if (index < 0) {
                index = next.length - 1;
            }
        }
        this.dragIndex = index;
        this.dragging = true;
        try {
            this.svg.setPointerCapture(e.pointerId);
        } catch { /* 合成事件没有 pointerId 时忽略 */ }
        this.render();
        this.emit('gestureStart');
        this.emitChange();
    };

    private onPointerMove = (e: PointerEvent) => {
        if (!this.dragging || this.dragIndex < 0) {
            return;
        }
        e.preventDefault();
        const p = this.toData(e);
        const pts = this.points;
        const i = this.dragIndex;
        if (isEndpoint(pts, i)) {
            // 端点：x 锁定，只改 y（抬黑 / 压白）
            pts[i] = { x: i === 0 ? 0 : 1, y: p.y };
        } else {
            // 中间点：x 夹在左右邻点之间（留一点余量，避免与邻点重合后被归一化吃掉）
            const minX = pts[i - 1].x + 1e-3;
            const maxX = pts[i + 1].x - 1e-3;
            pts[i] = { x: Math.max(minX, Math.min(maxX, p.x)), y: p.y };
        }
        this.render();
        this.emitChange();
    };

    private onPointerUp = (e: PointerEvent) => {
        if (!this.dragging) {
            return;
        }
        this.dragging = false;
        this.dragIndex = -1;
        try {
            this.svg.releasePointerCapture(e.pointerId);
        } catch { /* 同上 */ }
        this.emit('gestureEnd');
    };

    private onDoubleClick = (e: MouseEvent) => {
        const rect = this.svg.getBoundingClientRect();
        const p = {
            x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
            y: Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height))
        };
        const index = this.hitTest(p);
        if (index > 0 && index < this.points.length - 1) {
            e.preventDefault();
            e.stopPropagation();
            this.points = this.points.filter((_, i) => i !== index);
            this.render();
            this.emit('gestureStart');
            this.emitChange();
            this.emit('gestureEnd');
        }
    };

    /** 重画曲线折线与控制点 */
    private render() {
        // 用与着色器完全相同的采样函数画，所见即所得
        const samples = sampleCurve(this.points);
        const coords: string[] = [];
        for (let i = 0; i < samples.length; i++) {
            const x = (i / (samples.length - 1)) * 100;
            coords.push(`${x.toFixed(2)},${(100 - samples[i] * 100).toFixed(2)}`);
        }
        this.curvePath.setAttribute('points', coords.join(' '));

        // 控制点：数量变化时重建，否则只挪位置
        const group = this.svg.querySelector('.curve-dots') as SVGGElement;
        while (this.dots.length < this.points.length) {
            const c = document.createElementNS(SVG_NS, 'circle');
            c.setAttribute('r', '3');
            c.setAttribute('class', 'curve-dot');
            group.append(c);
            this.dots.push(c);
        }
        while (this.dots.length > this.points.length) {
            group.removeChild(this.dots.pop()!);
        }
        for (let i = 0; i < this.points.length; i++) {
            const p = this.points[i];
            this.dots[i].setAttribute('cx', (p.x * 100).toFixed(2));
            this.dots[i].setAttribute('cy', (100 - p.y * 100).toFixed(2));
            this.dots[i].classList.toggle('active', i === this.dragIndex);
        }

        this.guides.classList.toggle('curve-guides-hidden', this.points.length > 2);
    }
}

export { CurveEditor };
