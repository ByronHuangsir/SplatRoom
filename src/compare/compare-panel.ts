/**
 * ComparePanel — collapsible control surface for the comparison tool.
 *
 * Defaults to OPEN (260 px wide, pinned to left edge).  A small ◀ button
 * at the top-right of the panel collapses it; when collapsed only a ▶ tab
 * remains, and the 3-D viewports reclaim the full canvas width.
 */

import { CompareScene } from './compare-scene';
import { CompareLayoutMode } from './compare-layout';

interface Preset {
    mode: CompareLayoutMode;
    label: string;
    minCount: number;   // button is hidden / disabled below this count
    autoCount: boolean; // if true, uses scene.models.length as the viewport count
}

const PRESETS: Preset[] = [
    { mode: 'horizontal', label: '左右分屏', minCount: 1, autoCount: true }
];

const ACCEPT = '.ply,.sog,.spz,.ssproj,.compressed.ply,.pcd,.spx';

const PANEL_WIDTH = 272;   // px (content 260 + 12 padding)
const TAB_WIDTH   = 28;

export class ComparePanel {
    private readonly scene: CompareScene;
    private readonly root: HTMLDivElement;     // outer wrapper
    private readonly inner: HTMLDivElement;    // scrollable content
    private readonly tab: HTMLDivElement;      // collapse toggle
    private readonly fileInput: HTMLInputElement;
    private readonly modelListEl: HTMLDivElement;
    private readonly totalEl: HTMLSpanElement;
    private readonly layoutBtns: { btn: HTMLButtonElement; preset: Preset }[] = [];

    private addBtn: HTMLButtonElement | null = null;   // "添加模型" button (loading state)
    private importing = false;                          // true while files load
    private collapsed = false;

    constructor(scene: CompareScene) {
        this.scene = scene;

        // outer
        this.root = document.createElement('div');
        this.root.id = 'compare-panel';
        Object.assign(this.root.style, {
            position: 'fixed',
            top: '12px',
            left: '0px',
            width: `${PANEL_WIDTH}px`,
            maxHeight: 'calc(100vh - 24px)',
            zIndex: '101',
            transition: 'transform 0.25s cubic-bezier(.4,0,.2,1)',
            transform: 'translateX(0)'
        } as CSSStyleDeclaration);
        document.body.appendChild(this.root);

        // solid opaque background covering the left "panel area" so the
        // 3-D canvas does not bleed through.  Slides together with the panel.
        const bg = document.createElement('div');
        Object.assign(bg.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: `${PANEL_WIDTH}px`,
            height: '100vh',
            background: '#0e1014',
            zIndex: '5',                       // between canvas (0) and panel (20)
            transition: 'transform 0.25s cubic-bezier(.4,0,.2,1)',
            transform: 'translateX(0)',
            pointerEvents: 'none'
        } as CSSStyleDeclaration);
        document.body.appendChild(bg);
        // store for later toggling
        (this as any)._bg = bg;

        // collapse tab (always visible, right edge of panel when open)
        this.tab = document.createElement('div');
        Object.assign(this.tab.style, {
            position: 'absolute',
            top: '0px',
            right: `${-TAB_WIDTH}px`,
            width: `${TAB_WIDTH}px`,
            height: '36px',
            background: 'rgba(24,28,34,0.94)',
            color: '#eaeaea',
            borderRadius: '0 8px 8px 0',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '14px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
            userSelect: 'none'
        } as CSSStyleDeclaration);
        this.tab.textContent = '◀';
        this.tab.title = '隐藏面板';
        this.tab.addEventListener('click', () => this.toggle());
        this.root.appendChild(this.tab);

        // scrollable content
        this.inner = document.createElement('div');
        Object.assign(this.inner.style, {
            padding: '14px',
            background: 'rgba(24,28,34,0.94)',
            color: '#eaeaea',
            font: '13px/1.5 system-ui, sans-serif',
            borderRadius: '10px',
            boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
            overflowY: 'auto',
            maxHeight: 'calc(100vh - 52px)',
            pointerEvents: 'auto'
        } as CSSStyleDeclaration);
        this.root.appendChild(this.inner);

        // file input
        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.multiple = true;
        this.fileInput.accept = ACCEPT;
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', (e) => this.onFilesPicked(e));
        document.body.appendChild(this.fileInput);

        this.modelListEl = document.createElement('div');
        this.totalEl = document.createElement('span');

        this.build();
        this.refresh();
        // Notify the scene of our initial width BEFORE any model is loaded so
        // the first import lays out viewports with the panel already reserved.
        // Without this the first model lands flush to the left edge and is
        // covered by the panel until the user manually toggles it.
        scene.setPanelOffset(PANEL_WIDTH);
        // start open – user can click ◀ to collapse
    }

    /** Called when models are added/removed — re-binds the sync listeners. */
    rebindStats() {
        for (const m of this.scene.models) {
            m.statsPanel.root.addEventListener('stats-attr', (e: Event) => {
                const ce = e as CustomEvent;
                const key = ce.detail.key as 'x' | 'y' | 'z' | 'distance' | 'camera-depth' | 'red' | 'green' | 'blue' | 'opacity' | 'scale_0' | 'scale_1' | 'scale_2' | 'rot_0' | 'rot_1' | 'rot_2' | 'rot_3' | 'volume' | 'surface-area' | 'hue' | 'saturation' | 'value' | 'f_dc_0' | 'f_dc_1' | 'f_dc_2';
                const next = (this as any)._currentAttr === key ? null : key;
                (this as any)._currentAttr = next;
                this.scene.setStatsAttribute(next);
            });
        }
    }

    // ------------------------------------------------------------------
    // collapse / expand
    // ------------------------------------------------------------------

    private toggle() {
        this.collapsed = !this.collapsed;
        const tx = this.collapsed ? `-${PANEL_WIDTH}px` : '0';
        this.root.style.transform = `translateX(${tx})`;
        const bg = (this as any)._bg as HTMLDivElement | undefined;
        if (bg) bg.style.transform = `translateX(${tx})`;
        if (this.collapsed) {
            this.tab.textContent = '▶';
            this.tab.title = '显示面板';
        } else {
            this.tab.textContent = '◀';
            this.tab.title = '隐藏面板';
        }
        this.scene.setPanelOffset(this.collapsed ? 0 : PANEL_WIDTH);
    }

    // ------------------------------------------------------------------
    // DOM construction
    // ------------------------------------------------------------------

    private build() {
        const root = this.inner;

        const header = document.createElement('div');
        header.textContent = '高斯训练对比-飞羽实验室';
        Object.assign(header.style, {
            fontSize: '16px', fontWeight: '600', marginBottom: '4px'
        } as CSSStyleDeclaration);
        root.appendChild(header);

        const hint = document.createElement('div');
        hint.textContent = '左键旋转 · 双击定焦 · 中键平移 · 右键飞行 · 滚轮缩放';
        Object.assign(hint.style, { opacity: '.6', fontSize: '11px', marginBottom: '12px' } as CSSStyleDeclaration);
        root.appendChild(hint);

        const addBtn = this.button('添加模型', () => this.fileInput.click());
        this.addBtn = addBtn;
        addBtn.style.width = '100%';
        addBtn.style.marginBottom = '12px';
        root.appendChild(addBtn);

        root.appendChild(this.divider());

        const listHeader = document.createElement('div');
        listHeader.innerHTML = '已加载模型 <span id="compare-total"></span>';
        Object.assign(listHeader.style, { fontWeight: '600', marginBottom: '6px' } as CSSStyleDeclaration);
        listHeader.appendChild(this.totalEl);
        root.appendChild(listHeader);
        root.appendChild(this.modelListEl);

        root.appendChild(this.divider());

        const layoutHeader = document.createElement('div');
        layoutHeader.textContent = '布局';
        Object.assign(layoutHeader.style, { fontWeight: '600', marginBottom: '6px' } as CSSStyleDeclaration);
        root.appendChild(layoutHeader);

        const grid = document.createElement('div');
        Object.assign(grid.style, { display: 'grid', gridTemplateColumns: '1fr', gap: '6px' } as CSSStyleDeclaration);
        for (const preset of PRESETS) {
            const btn = this.button(preset.label, () => {
                const count = preset.autoCount
                    ? Math.max(1, this.scene.models.length)
                    : 4;
                this.scene.applyLayout(count, preset.mode);
            });
            btn.disabled = true;
            this.layoutBtns.push({ btn, preset });
            grid.appendChild(btn);
        }
        root.appendChild(grid);

        root.appendChild(this.divider());

        // ── FOV slider ──
        const fovSection = document.createElement('div');
        fovSection.style.marginBottom = '12px';
        const fovLabel = document.createElement('div');
        fovLabel.textContent = '视野';
        Object.assign(fovLabel.style, { fontWeight: '600', marginBottom: '4px', fontSize: '12px' } as CSSStyleDeclaration);
        fovSection.appendChild(fovLabel);

        const fovRow = document.createElement('div');
        Object.assign(fovRow.style, { display: 'flex', alignItems: 'center', gap: '6px' } as CSSStyleDeclaration);

        const fovSlider = document.createElement('input');
        fovSlider.type = 'range';
        fovSlider.min = '10';
        fovSlider.max = '120';
        fovSlider.value = '50';
        fovSlider.step = '1';
        Object.assign(fovSlider.style, { flex: '1', accentColor: '#5a8be0' } as CSSStyleDeclaration);

        const fovValue = document.createElement('span');
        fovValue.textContent = '50°';
        Object.assign(fovValue.style, { fontSize: '12px', minWidth: '34px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' } as CSSStyleDeclaration);

        fovSlider.addEventListener('input', () => {
            const v = parseInt(fovSlider.value, 10);
            fovValue.textContent = `${v}°`;
            this.scene.setFov(v);
        });

        fovRow.appendChild(fovSlider);
        fovRow.appendChild(fovValue);
        fovSection.appendChild(fovRow);
        root.appendChild(fovSection);

        root.appendChild(this.divider());

        // ── Analysis mode ──
        const analysisSection = document.createElement('div');
        analysisSection.style.marginBottom = '12px';
        const analysisLabel = document.createElement('div');
        analysisLabel.textContent = '分析模式';
        Object.assign(analysisLabel.style, { fontWeight: '600', marginBottom: '4px', fontSize: '12px' } as CSSStyleDeclaration);
        analysisSection.appendChild(analysisLabel);

        const analysisGrid = document.createElement('div');
        Object.assign(analysisGrid.style, { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' } as CSSStyleDeclaration);

        const modes: { label: string; mode: 'density' | 'sharpness' | 'floaters' | 'penetration' }[] = [
            { label: '热力图', mode: 'density' },
            { label: '清晰度', mode: 'sharpness' },
            { label: '浮云', mode: 'floaters' },
            { label: '表面破洞', mode: 'penetration' }
        ];

        let currentAnalysisMode: 'density' | 'sharpness' | 'floaters' | 'penetration' | null = null;
        const analysisBtns: HTMLButtonElement[] = [];

        for (const am of modes) {
            const btn = this.button(am.label, () => {
                const next = currentAnalysisMode === am.mode ? null : am.mode;
                currentAnalysisMode = next;
                for (const b of analysisBtns) b.style.background = 'rgba(70,110,170,0.95)';
                if (next) {
                    btn.style.background = 'rgba(200,100,60,0.95)';
                    sensitivitySlider.disabled = false;
                } else {
                    sensitivitySlider.disabled = true;
                }
                this.scene.setAnalysisMode(next, parseInt(sensitivitySlider.value, 10));
            });
            btn.style.fontSize = '11px';
            btn.style.padding = '4px 6px';
            analysisBtns.push(btn);
            analysisGrid.appendChild(btn);
        }
        analysisSection.appendChild(analysisGrid);

        // sensitivity slider
        const sensRow = document.createElement('div');
        Object.assign(sensRow.style, { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' } as CSSStyleDeclaration);
        const sensLabel = document.createElement('span');
        sensLabel.textContent = '灵敏度';
        Object.assign(sensLabel.style, { fontSize: '11px', opacity: '.8' } as CSSStyleDeclaration);

        const sensitivitySlider = document.createElement('input');
        sensitivitySlider.type = 'range';
        sensitivitySlider.min = '5';
        sensitivitySlider.max = '100';
        sensitivitySlider.value = '65';
        sensitivitySlider.step = '1';
        sensitivitySlider.disabled = true;
        Object.assign(sensitivitySlider.style, { flex: '1', accentColor: '#5a8be0' } as CSSStyleDeclaration);

        sensitivitySlider.addEventListener('input', () => {
            if (currentAnalysisMode) {
                this.scene.setAnalysisMode(currentAnalysisMode, parseInt(sensitivitySlider.value, 10));
            }
        });

        sensRow.appendChild(sensLabel);
        sensRow.appendChild(sensitivitySlider);
        analysisSection.appendChild(sensRow);
        root.appendChild(analysisSection);

        root.appendChild(this.divider());

        // ── snapshot: capture the current 3-D view ──
        const snapBtn = this.button('📷 快照', () => this.snapshot());
        snapBtn.style.width = '100%';
        snapBtn.style.background = 'rgba(90,140,90,0.9)';
        root.appendChild(snapBtn);

        root.appendChild(this.divider());

        const clearAll = this.button('清空全部', () => { this.scene.clear(); this.refresh(); });
        clearAll.style.width = '100%';
        clearAll.style.background = 'rgba(120,40,40,0.9)';
        root.appendChild(clearAll);
    }

    /** Capture the whole UI (left panel + 3-D canvas + analysis overlays)
     *  as a PNG using the html-to-image library, then download it. */
    private async snapshot() {
        // wait a beat so the current frame has fully presented
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const hti = (window as any).htmlToImage;
        console.log('[ComparePanel] htmlToImage available:', !!hti);
        let dataUrl: string;
        try {
            if (hti && typeof hti.toPng === 'function') {
                // capture document.body → includes panel, canvas, overlays,
                // and any active analysis overlay (drawn on overlay canvases).
                dataUrl = await hti.toPng(document.body, {
                    pixelRatio: Math.min(2, window.devicePixelRatio || 1),
                    backgroundColor: '#0e1014',
                    cacheBust: true
                });
            } else {
                // fallback: manually compose 3-D canvas + analysis overlays
                dataUrl = this.composeCanvasImage();
            }
        } catch (e) {
            console.error('[ComparePanel] html-to-image failed, using manual compose', e);
            dataUrl = this.composeCanvasImage();
        }
        const a = document.createElement('a');
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        a.href = dataUrl;
        a.download = `compare-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    /**
     * Manual snapshot compose — draws the 3-D canvas plus every analysis
     * overlay canvas (heatmap / sharpness / floaters / holes) onto one
     * off-screen 2-D canvas.  DOM panels are NOT included (they need the
     * html-to-image library); this is only a fallback when the library is
     * unavailable so the analysis results still show up.
     */
    private composeCanvasImage(): string {
        const src = this.scene.canvas;
        const W = src.width || window.innerWidth;
        const H = src.height || window.innerHeight;
        const out = document.createElement('canvas');
        out.width = W;
        out.height = H;
        const ctx = out.getContext('2d');
        if (!ctx) return src.toDataURL('image/png');
        ctx.fillStyle = '#0e1014';
        ctx.fillRect(0, 0, W, H);
        // 3-D framebuffer (preserveDrawingBuffer is enabled)
        try { ctx.drawImage(src, 0, 0, W, H); } catch (_) { /* ignore */ }
        // analysis overlays — each is a DOM canvas positioned at its viewport
        const overlays = document.querySelectorAll('canvas.compare-analysis-overlay');
        for (const ov of overlays) {
            const c = ov as HTMLCanvasElement;
            if (!c.width || !c.height) continue;
            const rc = c.getBoundingClientRect();
            if (rc.width <= 0 || rc.height <= 0) continue;
            try {
                ctx.drawImage(c, rc.left, rc.top, rc.width, rc.height);
            } catch (_) { /* ignore */ }
        }
        return out.toDataURL('image/png');
    }

    private button(label: string, onClick: () => void): HTMLButtonElement {
        const b = document.createElement('button');
        b.textContent = label;
        b.addEventListener('click', onClick);
        Object.assign(b.style, {
            padding: '6px 10px', background: 'rgba(70,110,170,0.95)', color: '#fff',
            border: 'none', borderRadius: '6px', cursor: 'pointer', font: '12px/1.2 system-ui, sans-serif'
        } as CSSStyleDeclaration);
        b.addEventListener('mouseenter', () => { if (!b.disabled) b.style.filter = 'brightness(1.12)'; });
        b.addEventListener('mouseleave', () => { b.style.filter = 'none'; });
        return b;
    }

    private divider(): HTMLDivElement {
        const d = document.createElement('div');
        Object.assign(d.style, { height: '1px', background: 'rgba(255,255,255,0.12)', margin: '12px 0' } as CSSStyleDeclaration);
        return d;
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /** Files picked via the file dialog → load them straight into the scene
     *  (single-action import: no staged list / separate "import" step). */
    private async onFilesPicked(e: Event) {
        const input = e.target as HTMLInputElement;
        if (!input.files || input.files.length === 0) return;
        const files = Array.from(input.files).map(f => ({ name: f.name, blob: f as Blob }));
        input.value = '';
        this.importing = true;
        this.updateAddBtn();
        try {
            await this.scene.loadFiles(files);
        } catch (err) {
            console.error('[ComparePanel] import failed', err);
        }
        this.importing = false;
        this.updateAddBtn();
        this.refresh();
    }

    /** Reflect the loading state on the "添加模型" button. */
    private updateAddBtn() {
        if (!this.addBtn) return;
        this.addBtn.disabled = this.importing;
        this.addBtn.textContent = this.importing ? '加载中…' : '添加模型';
    }

    // ------------------------------------------------------------------
    // Refresh UI
    // ------------------------------------------------------------------

    refresh() {
        this.modelListEl.innerHTML = '';
        let total = 0;
        for (const m of this.scene.models) {
            total += m.splatCount;
            // bind stats-panel attribute sync (idempotent — addEventListener
            // won't add a duplicate if the same function is added twice)
            m.statsPanel.root.addEventListener('stats-attr', (e: Event) => {
                const ce = e as CustomEvent;
                const key = ce.detail.key as 'x' | 'y' | 'z' | 'distance' | 'camera-depth' | 'red' | 'green' | 'blue' | 'opacity' | 'scale_0' | 'scale_1' | 'scale_2' | 'rot_0' | 'rot_1' | 'rot_2' | 'rot_3' | 'volume' | 'surface-area' | 'hue' | 'saturation' | 'value' | 'f_dc_0' | 'f_dc_1' | 'f_dc_2';
                const cur = (this as any)._currentAttr ?? null;
                const next = cur === key ? null : key;
                (this as any)._currentAttr = next;
                this.scene.setStatsAttribute(next);
            });

            const row = document.createElement('div');
            Object.assign(row.style, {
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: '6px', padding: '5px 6px', background: 'rgba(255,255,255,0.05)',
                borderRadius: '5px', marginBottom: '5px'
            } as CSSStyleDeclaration);

            // checkbox — default checked = visible
            const chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.checked = m.visible;
            chk.title = '显示/隐藏模型';
            Object.assign(chk.style, { flex: '0 0 auto', accentColor: '#5a8be0', cursor: 'pointer' } as CSSStyleDeclaration);
            chk.addEventListener('change', () => {
                this.scene.setModelVisibility(m.index, chk.checked);
                this.refresh();
            });
            row.appendChild(chk);

            const info = document.createElement('div');
            Object.assign(info.style, { overflow: 'hidden', flex: '1', minWidth: '0' } as CSSStyleDeclaration);
            const name = document.createElement('div');
            name.textContent = m.name;
            Object.assign(name.style, { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: '12px' } as CSSStyleDeclaration);
            const sub = document.createElement('div');
            sub.textContent = `${(m.splatCount / 1000).toFixed(1)}k 点`;
            Object.assign(sub.style, { opacity: '.6', fontSize: '11px' } as CSSStyleDeclaration);
            info.appendChild(name);
            info.appendChild(sub);

            const rm = document.createElement('button');
            rm.textContent = '×';
            rm.title = '移除该模型';
            rm.addEventListener('click', () => { this.scene.removeModel(m.index); this.refresh(); });
            Object.assign(rm.style, {
                flex: '0 0 auto', width: '22px', height: '22px',
                background: 'rgba(120,40,40,0.9)', color: '#fff',
                border: 'none', borderRadius: '4px', cursor: 'pointer',
                fontSize: '14px', lineHeight: '1'
            } as CSSStyleDeclaration);
            row.appendChild(info);
            row.appendChild(rm);
            this.modelListEl.appendChild(row);
        }
        this.totalEl.textContent = `（共 ${(total / 1000).toFixed(1)}k 点）`;

        const n = this.scene.models.length;
        for (const { btn, preset } of this.layoutBtns) {
            btn.style.display = '';
            const disabled = n < preset.minCount;
            btn.disabled = disabled;
            btn.style.opacity = disabled ? '.4' : '1';
            btn.style.cursor = disabled ? 'not-allowed' : 'pointer';
        }
    }
}
