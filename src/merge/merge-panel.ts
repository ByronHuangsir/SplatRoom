import { MergeScene } from './merge-scene';
import { saveWithPicker, writeToDir } from './merge-export';

/**
 * 合并工具（模块 3）— 左侧操作面板。
 *
 * 按 image#2 布局：
 *   标题 / 副标题
 *   ①加载模型（按钮 + 拖拽）
 *   ②模型管理器（列表 / 链接）
 *   ③对齐模式（手动/自动/标记 单选 + 条件渲染子区）
 *   ④合并导出（文件名 + 输出文件夹 + 导出）
 *
 * 三种对齐模式：
 *   manual（默认）：显示移动/旋转/缩放工具按钮 + 数值面板
 *   auto：显示"自动对齐"按钮
 *   marker：Tab 切换模型1/2 + 3 组对应点圆点 + 应用/清空
 */

const downloadBlob = (name: string, data: Uint8Array) => {
    const blob = new Blob([data as any], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url;
    el.download = name;
    el.click();
    URL.revokeObjectURL(url);
};

export class MergePanel {
    private scene: MergeScene;
    private listEl!: HTMLElement;
    private statusEl!: HTMLElement;
    private fileInput!: HTMLInputElement;
    private alignModeLabel!: HTMLElement;
    private alignSub!: HTMLElement;
    private manualSub!: HTMLElement;
    private autoSub!: HTMLElement;
    private markerSub!: HTMLElement;
    private markerPickBtn!: HTMLButtonElement;
    private outBtn!: HTMLButtonElement;
    private outNameLabel!: HTMLSpanElement;
    private expBtn!: HTMLButtonElement;

    // 当前工具模式（manual 对齐模式下的 view/move/rotate/scale）
    private toolBtns: HTMLButtonElement[] = [];

    constructor(scene: MergeScene) {
        this.scene = scene;
        scene.onModelsChange = () => this.renderList();
        scene.onSelectionChange = () => this.renderList();
        scene.onStatus = (msg) => { this.statusEl.textContent = msg; };
        scene.onAlignModeChange = () => this.refreshAlignSub();
        scene.onMarkerChange = () => this.renderMarkerPanel();
        scene.onHistoryChange = () => this.renderMarkerPanel();
        this.build();
        this.renderList();
        this.refreshAlignSub();
    }

    private el(tag: string, cls?: string, text?: string): HTMLElement {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    private build(): void { this.__buildBody(); }
    private __buildBody(): void {
        const panel = this.el('div', 'merge-panel');
        panel.innerHTML = `
            <style>
                .merge-panel { position: fixed; top: 0; left: 0; bottom: 0; width: 300px;
                    background: #1e2228; color: #e8e8e8; font: 13px/1.5 system-ui, sans-serif;
                    border-right: 1px solid #333a42; overflow-y: auto; z-index: 10;
                    padding: 14px 14px 24px; box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; }
                .merge-panel h2 { margin: 0; font-size: 15px; font-weight: 700; color: #ffb454; }
                .merge-panel h3 { margin: 0 0 6px 0; font-size: 12px; text-transform: uppercase;
                    letter-spacing: .5px; color: #9aa4af; }
                .merge-sec { border-top: 1px solid #333a42; padding-top: 10px; }
                .merge-btn { background: #ffb454; color: #1a1d21; border: none; border-radius: 6px;
                    padding: 6px 12px; font-size: 12px; font-weight: 700; cursor: pointer; }
                .merge-btn:disabled { opacity: .45; cursor: not-allowed; }
                .merge-btn.ghost { background: #262b32; color: #c9d1d9; border: 1px solid #3d4650; }
                .merge-radio { display: flex; gap: 8px; }
                .merge-radio label { flex: 1; padding: 6px 8px; background: #262b32; color: #c9d1d9;
                    border: 1px solid #3d4650; border-radius: 6px; cursor: pointer; text-align: center;
                    font-size: 12px; font-weight: 500; }
                .merge-radio label.on { border-color: #ffb454; background: #2e2a24; color: #ffb454; font-weight: 700; }
                .merge-list { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
                .merge-item { display: flex; align-items: center; gap: 6px; background: #262b32;
                    border: 1px solid #3d4650; border-radius: 6px; padding: 4px 8px; font-size: 12px; }
                .merge-item.sel { border-color: #ffb454; background: #2e2a24; }
                .merge-item .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #c9d1d9; }
                .merge-item .ct { color: #6b7580; font-size: 11px; }
                .merge-item .vis { cursor: pointer; color: #9aa4af; }
                .merge-item .del { cursor: pointer; color: #9aa4af; }
                .merge-item .del:hover { color: #ff8a8a; }
                .merge-item .chain { color: #5dcaa5; font-size: 11px; }
                .merge-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
                .merge-tool-row { display: flex; gap: 6px; margin-bottom: 6px; }
                .merge-tool-row .merge-btn { flex: 1; }
                .merge-tool-row .merge-btn.on { background: #ffb454; color: #1a1d21; }
                .merge-tool-row .merge-btn.on.ghost { background: #ffb454; color: #1a1d21; border-color: #ffb454; }
                .merge-input { width: 60px; background: #262b32; color: #e8e8e8; border: 1px solid #3d4650;
                    border-radius: 4px; padding: 3px 6px; font-size: 12px; }
                .merge-input.lg { width: 140px; }
                .merge-status { font-size: 12px; color: #9aa4af; min-height: 32px; white-space: pre-wrap; }
                .merge-hint { font-size: 11px; color: #6b7580; }
                .merge-marker-tabs { display: flex; gap: 6px; margin-bottom: 8px; }
                .merge-marker-tab { flex: 1; padding: 5px 6px; border-radius: 6px; background: #262b32;
                    border: 1px solid #3d4650; color: #c9d1d9; font-size: 12px; font-weight: 600; cursor: pointer;
                    text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .merge-marker-tab.on { background: #2e2a24; border-color: #ffb454; color: #ffb454; }
                .merge-marker-group { display: flex; align-items: center; gap: 8px; padding: 3px 2px; }
                .merge-marker-glabel { flex: 1; font-size: 12px; color: #9aa4af; }
                .merge-marker-dot { width: 16px; height: 16px; border-radius: 50%; border: 2px solid #3d4650;
                    background: transparent; box-sizing: border-box; }
                .merge-marker-dot.m1 { border-color: #3fd0e0; }
                .merge-marker-dot.m2 { border-color: #ef5da8; }
                .merge-marker-dot.m1.filled { background: #3fd0e0; }
                .merge-marker-dot.m2.filled { background: #ef5da8; }
                .merge-marker-eq { color: #6b7580; font-size: 12px; }
            </style>
        `;
        const style = panel.querySelector('style')!;
        panel.removeChild(style);
        document.head.appendChild(style);

        // 标题
        panel.appendChild(this.el('h2', '', '高斯合并工具-飞羽实验室'));
        panel.appendChild(this.el('div', 'merge-hint', '实验性质，目前还不完善。'));

        // ①加载模型
        const loadSec = this.el('div', 'merge-sec');
        loadSec.appendChild(this.el('h3', '', '①加载模型'));
        const loadRow = this.el('div', 'merge-row');
        const pickBtn = this.el('button', 'merge-btn ghost', '选择文件…') as HTMLButtonElement;
        loadRow.appendChild(pickBtn);
        loadSec.appendChild(loadRow);
        loadSec.appendChild(this.el('div', 'merge-hint', '也可直接拖拽文件到视口'));
        panel.appendChild(loadSec);

        // ②模型管理器
        const mgrSec = this.el('div', 'merge-sec');
        mgrSec.appendChild(this.el('h3', '', '②模型管理器'));
        this.listEl = this.el('div', 'merge-list'); console.log('listEl-assigned', !!this.listEl);
        mgrSec.appendChild(this.listEl);
        const linkRow = this.el('div', 'merge-row');
        const linkBtn = this.el('button', 'merge-btn ghost', '🔗 链接选中') as HTMLButtonElement;
        const unlinkBtn = this.el('button', 'merge-btn ghost', '取消链接') as HTMLButtonElement;
        linkRow.appendChild(linkBtn);
        linkRow.appendChild(unlinkBtn);
        mgrSec.appendChild(linkRow);
        panel.appendChild(mgrSec);

        // ③对齐模式（单选 manual/auto/marker）
        const alignSec = this.el('div', 'merge-sec');
        alignSec.appendChild(this.el('h3', '', '③对齐模式'));
        this.alignModeLabel = this.el('div', 'merge-hint', '');
        alignSec.appendChild(this.alignModeLabel);
        const radioRow = this.el('div', 'merge-radio');
        const radios: HTMLLabelElement[] = [];
        const makeRadio = (id: string, value: 'manual' | 'auto' | 'marker') => {
            const lab = document.createElement('label');
            lab.appendChild(document.createTextNode(id));
            const r = document.createElement('input');
            r.type = 'radio';
            r.name = 'alignMode';
            r.value = value;
            r.style.marginRight = '4px';
            lab.prepend(r);
            r.addEventListener('change', () => {
                if (r.checked) {
                    this.scene.setAlignMode(value);
                    radios.forEach((l, i) => l.classList.toggle('on', radios.indexOf(l) === this.findRadioIndex(value)));
                    this.refreshAlignSub();
                }
            });
            lab.onclick = () => { r.checked = true; r.dispatchEvent(new Event('change')); };
            radios.push(lab);
            return lab;
        };
        radioRow.appendChild(makeRadio('手动', 'manual'));
        radioRow.appendChild(makeRadio('自动', 'auto'));
        radioRow.appendChild(makeRadio('标记', 'marker'));
        alignSec.appendChild(radioRow);
        radios[0].classList.add('on'); radios[0].querySelector('input')!.checked = true;
        this.alignSub = this.el('div', '');
        alignSec.appendChild(this.alignSub);
        panel.appendChild(alignSec);

        // manual 子区：移动/旋转/缩放工具按钮 + 数值面板
        this.manualSub = this.el('div');
        const toolRow = this.el('div', 'merge-tool-row');
        const makeToolBtn = (label: string, mode: 'move' | 'rotate' | 'scale'): HTMLButtonElement => {
            const b = this.el('button', 'merge-btn ghost', label) as HTMLButtonElement;
            b.dataset.tool = mode;
            b.onclick = () => {
                this.scene.setToolMode(mode);
                this.toolBtns.forEach(tb => tb.classList.toggle('on', tb.dataset.tool === mode));
                this.statusEl.textContent = `${label}：点击模型选中，按住拖动调整（链锁组内联动）`;
            };
            toolRow.appendChild(b);
            this.toolBtns.push(b);
            return b;
        };
        makeToolBtn('移动', 'move');
        makeToolBtn('旋转', 'rotate');
        makeToolBtn('缩放', 'scale');
        this.manualSub.appendChild(toolRow);
        // 详细 X/Y/Z 数值调整请使用视窗左上角「变换面板」（选中模型后自动出现）
        this.manualSub.appendChild(this.el('div', 'merge-hint', '选中模型后，点击底部视角，按WSAD移动模型（按住shift可加速）到合适的位置。'));

        // auto 子区：自动对齐按钮（两阶段：对齐中 / 完成 + 撤销·应用）
        this.autoSub = this.el('div');
        const autoBtn = this.el('button', 'merge-btn', '自动对齐') as HTMLButtonElement;
        autoBtn.style.width = '100%';
        const autoStateRow = this.el('div', 'merge-row');
        const undoBtn = this.el('button', 'merge-btn ghost', '撤销') as HTMLButtonElement;
        const applyBtn = this.el('button', 'merge-btn', '应用') as HTMLButtonElement;
        autoStateRow.style.display = 'none';
        autoStateRow.appendChild(undoBtn);
        autoStateRow.appendChild(applyBtn);
        autoBtn.onclick = async () => {
            autoBtn.disabled = true;
            await this.scene.autoAlignSelection();
            autoBtn.disabled = false;
        };
        undoBtn.onclick = () => this.scene.undoAlign();
        applyBtn.onclick = () => this.scene.applyAlign();
        this.autoSub.appendChild(autoBtn);
        this.autoSub.appendChild(autoStateRow);
        this.autoSub.appendChild(this.el('div', 'merge-hint', '选中 ≥2 个模型，第一个为基准，其余自动对齐'));
        this.scene.onAutoAlignState = (state) => {
            if (state === 'running') {
                autoBtn.disabled = true;
                autoBtn.textContent = '对齐中，请等待…';
                autoStateRow.style.display = 'none';
            } else if (state === 'done') {
                autoBtn.disabled = false;
                autoBtn.textContent = '自动对齐';
                autoStateRow.style.display = 'flex';
                this.statusEl.textContent = '对齐完成';
            } else {
                autoBtn.disabled = false;
                autoBtn.textContent = '自动对齐';
                autoStateRow.style.display = 'none';
            }
        };

        // marker 子区：标记对齐（tab + 组网格 + 应用/清空），由 renderMarkerPanel 填充
        this.markerSub = this.el('div');

        // ④合并导出
        const expSec = this.el('div', 'merge-sec');
        expSec.appendChild(this.el('h3', '', '④合并导出'));
        const nameRow = this.el('div', 'merge-row');
        nameRow.appendChild(this.el('span', '', '文件名'));
        const nameInput = document.createElement('input');
        nameInput.type = 'text'; nameInput.value = 'merged.ply'; nameInput.className = 'merge-input lg';
        nameRow.appendChild(nameInput);
        expSec.appendChild(nameRow);
        const outRow = this.el('div', 'merge-row');
        outRow.appendChild(this.el('span', '', '保存到'));
        this.outBtn = this.el('button', 'merge-btn ghost', '选择文件夹…') as HTMLButtonElement;
        this.outNameLabel = this.el('span', 'merge-hint', '未选择（将下载到本地）');
        outRow.appendChild(this.outBtn);
        outRow.appendChild(this.outNameLabel);
        expSec.appendChild(outRow);
        this.expBtn = this.el('button', 'merge-btn', '合并导出 PLY') as HTMLButtonElement;
        this.expBtn.style.width = '100%';
        this.expBtn.style.marginTop = '6px';
        expSec.appendChild(this.expBtn);
        expSec.appendChild(this.el('div', 'merge-hint', '点击后弹出「存储为」对话框，可设置文件名与导出位置；不支持的浏览器自动回退为下载。'));
        panel.appendChild(expSec);

        this.statusEl = this.el('div', 'merge-status', '就绪') ;
        panel.appendChild(this.statusEl);

        document.body.appendChild(panel);

        // ---- 文件加载 ----
        pickBtn.onclick = () => this.fileInput.click();
        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.ply,.splat,.spz,.sog,.ksplat,.lcc,.lcc2';
        this.fileInput.multiple = true;
        this.fileInput.style.display = 'none';
        document.body.appendChild(this.fileInput);
        this.fileInput.onchange = async () => {
            if (this.fileInput.files?.length) {
                const files = Array.from(this.fileInput.files).map(f => ({ name: f.name, blob: f }));
                await this.scene.loadFiles(files);
                this.fileInput.value = '';
            }
        };
        window.addEventListener('dragover', (e) => e.preventDefault());
        window.addEventListener('drop', async (e) => {
            e.preventDefault();
            const files = e.dataTransfer?.files;
            if (files?.length) {
                await this.scene.loadFiles(Array.from(files).map(f => ({ name: f.name, blob: f })));
            }
        });

        // ---- 链接 ----
        linkBtn.onclick = () => this.scene.linkSelected();
        unlinkBtn.onclick = () => this.scene.unlinkSelected();

        // ---- 输出文件夹 ----
        this.outBtn.onclick = async () => {
            if (typeof (window as any).showDirectoryPicker !== 'function') {
                this.statusEl.textContent = '当前环境不支持「选择文件夹」（需要 Chromium 桌面浏览器 / SplatRoom 桌面版）';
                return;
            }
            try {
                const dir = await (window as any).showDirectoryPicker({ mode: 'readwrite' }) as FileSystemDirectoryHandle;
                this.scene.setOutputFolder(dir);
                this.outNameLabel.textContent = `📁 ${dir.name}`;
                this.outBtn.textContent = '更换文件夹…';
                this.statusEl.textContent = `输出文件夹：${dir.name}`;
            } catch (e) {
                if ((e as any)?.name !== 'AbortError') {
                    this.statusEl.textContent = '✗ 选择文件夹失败：' + (e instanceof Error ? e.message : String(e));
                }
            }
        };

        // ---- 导出 ----
        this.expBtn.onclick = async () => {
            const name = (nameInput.value || 'merged.ply').replace(/\.ply$/i, '') + '.ply';
            try {
                // 优先：浏览器原生「存储为」对话框。必须先调 saveWithPicker（同步拿 handle），
                // 再在回调里做耗时的 exportMerged，否则 await 之后丢失用户手势 → SecurityError。
                let lastCount = 0;
                try {
                    const saved = await saveWithPicker(name, async () => {
                        const r = await this.scene.exportMerged(name);
                        lastCount = r.count;
                        return r.data;
                    });
                    this.statusEl.textContent = `✓ 已存储为 ${saved.name}（${lastCount.toLocaleString()} 高斯）`;
                    return;
                } catch (e: any) {
                    if (e?.name === 'AbortError') {
                        this.statusEl.textContent = '已取消保存';
                        return;
                    }
                    if (e?.message === 'NOT_SUPPORTED') {
                        // 回退：若已选输出文件夹则写入文件夹，否则直接下载
                        const folder = this.scene.outputDir;
                        if (folder) {
                            const r = await this.scene.exportMerged(name);
                            await writeToDir(folder, r.name, r.data);
                            this.statusEl.textContent = `✓ 已保存到 ${folder.name}/${r.name}（${r.count.toLocaleString()} 高斯）`;
                        } else {
                            const r2 = await this.scene.exportMerged(name);
                            downloadBlob(r2.name, r2.data);
                            this.statusEl.textContent = `✓ 已合并导出 ${r2.name}（${r2.count.toLocaleString()} 高斯），已下载`;
                        }
                        return;
                    }
                    throw e;
                }
            } catch (e) {
                this.statusEl.textContent = '✗ ' + (e instanceof Error ? e.message : String(e));
            }
        };
    }

    private findRadioIndex(value: 'manual' | 'auto' | 'marker'): number {
        return value === 'manual' ? 0 : value === 'auto' ? 1 : 2;
    }

    private refreshAlignSub(): void {
        const m = this.scene.currentAlignMode;
        // 先清空 alignSub 重建条件内容
        this.alignSub.innerHTML = '';
        if (m === 'manual') {
            this.alignSub.appendChild(this.manualSub);
            this.alignModeLabel.textContent = '手动对齐：使用工具按钮 / 数值面板调整模型';
        } else if (m === 'auto') {
            this.alignSub.appendChild(this.autoSub);
            this.alignModeLabel.textContent = '自动对齐：选中 ≥2 个后点按钮一键对齐';
        } else {
            this.alignSub.appendChild(this.markerSub);
            this.alignModeLabel.textContent = '标记对齐：在两个模型上各点 3 处标记';
            this.renderMarkerPanel();
        }
    }

    private truncName(n: string): string {
        return n.length > 12 ? n.slice(0, 12) + '…' : n;
    }

    private renderMarkerPanel(): void {
        const s = this.scene;
        this.markerSub.innerHTML = '';

        // Tab：模型1 / 模型2（高亮当前 active）
        const tabRow = this.el('div', 'merge-marker-tabs');
        const mkTab = (key: 'm1' | 'm2', label: string) => {
            const t = this.el('div', 'merge-marker-tab', label) as HTMLDivElement;
            if (s.markerActive === key) t.classList.add('on');
            t.onclick = () => this.scene.setMarkerActive(key);
            return t;
        };
        tabRow.appendChild(mkTab('m1', '模型1' + (s.markerModel1 ? ' · ' + this.truncName(s.markerModel1.name) : '')));
        tabRow.appendChild(mkTab('m2', '模型2' + (s.markerModel2 ? ' · ' + this.truncName(s.markerModel2.name) : '')));
        this.markerSub.appendChild(tabRow);

        // 3 组标记：每组 模型1 圆点 ↔ 模型2 圆点
        for (let g = 0; g < 3; g++) {
            const row = this.el('div', 'merge-marker-group');
            row.appendChild(this.el('span', 'merge-marker-glabel', `标记组${g + 1}`));
            const c1 = this.el('span', 'merge-marker-dot m1');
            if (s.markerGroups[g]?.m1) c1.classList.add('filled');
            row.appendChild(c1);
            row.appendChild(this.el('span', 'merge-marker-eq', '↔'));
            const c2 = this.el('span', 'merge-marker-dot m2');
            if (s.markerGroups[g]?.m2) c2.classList.add('filled');
            row.appendChild(c2);
            this.markerSub.appendChild(row);
        }

        // 按钮行：开始/结束标记 · 应用对齐 · 清空
        const btnRow = this.el('div', 'merge-row');
        this.markerPickBtn = this.el('button', 'merge-btn' + (s.markerPicking ? '' : ' ghost'), s.markerPicking ? '结束标记' : '开始标记') as HTMLButtonElement;
        this.markerPickBtn.style.flex = '1';
        this.markerPickBtn.onclick = () => { s.toggleMarkerPicking(); this.renderMarkerPanel(); };
        const applyBtn = this.el('button', 'merge-btn', '应用对齐') as HTMLButtonElement;
        applyBtn.style.flex = '1';
        applyBtn.disabled = !s.canApplyMarker();
        applyBtn.onclick = () => { s.applyMarkerAlign(); };
        const clearBtn = this.el('button', 'merge-btn ghost', '清空') as HTMLButtonElement;
        clearBtn.style.flex = '1';
        clearBtn.onclick = () => { s.clearMarkerAlign(); this.renderMarkerPanel(); };
        btnRow.appendChild(this.markerPickBtn);
        btnRow.appendChild(applyBtn);
        btnRow.appendChild(clearBtn);
        this.markerSub.appendChild(btnRow);

        // 撤销/重做
        const historyRow = this.el('div', 'merge-row');
        const undoBtn = this.el('button', 'merge-btn ghost', '↩ 撤销') as HTMLButtonElement;
        undoBtn.style.flex = '1';
        undoBtn.disabled = !s.canUndo();
        undoBtn.onclick = () => { s.undo(); };
        const redoBtn = this.el('button', 'merge-btn ghost', '↪ 重做') as HTMLButtonElement;
        redoBtn.style.flex = '1';
        redoBtn.disabled = !s.canRedo();
        redoBtn.onclick = () => { s.redo(); };
        historyRow.appendChild(undoBtn);
        historyRow.appendChild(redoBtn);
        this.markerSub.appendChild(historyRow);

        this.markerSub.appendChild(this.el('div', 'merge-hint', '先在列表/点选指定「模型1」，在特征处点 3 处标记；再指定「模型2」点对应 3 处，完成后自动对齐。快捷键：Ctrl+Z 撤销，Ctrl+Y / Ctrl+Shift+Z 重做。'));
    }

    private renderList(): void {
        const models = this.scene.models;
        this.listEl.innerHTML = '';
        if (models.length === 0) {
            this.listEl.appendChild(this.el('div', 'merge-hint', '尚未加载模型'));
            return;
        }
        for (const m of models) {
            const item = this.el('div', 'merge-item' + (m.selected ? ' sel' : ''));
            const nm = this.el('span', 'nm', m.name);
            nm.title = m.name;
            item.appendChild(nm);
            const ct = this.el('span', 'ct', m.numSplats.toLocaleString());
            item.appendChild(ct);
            if (m.chain) item.appendChild(this.el('span', 'chain', '🔗'));
            const vis = this.el('span', 'vis', m.visible ? '👁' : '🚫');
            vis.title = '显隐';
            vis.onclick = () => {
                m.visible = !m.visible;
                m.entity.gsplat.layers = m.visible ? [(this.scene as any).layer.id] : [];
                this.renderList();
            };
            item.appendChild(vis);
            const del = this.el('span', 'del', '✕');
            del.title = '移除';
            del.onclick = () => this.scene.removeModel(m);
            item.appendChild(del);
            item.onclick = (e) => {
                if (e.ctrlKey) m.selected = !m.selected;
                else this.scene.setSelection([m]);
                this.renderList();
            };
            this.listEl.appendChild(item);
        }
    }
}