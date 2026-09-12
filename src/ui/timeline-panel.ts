import { Button, Container, Element, NumericInput, SelectInput, Label } from '@playcanvas/pcui';

import { enableReliableInputDrag, hidePcuiSliderStrip } from './input-drag';
import { i18n } from './localization';
import { Tooltips } from './tooltips';
import { Events } from '../core/events';
import { ShortcutManager } from '../core/shortcut-manager';

/** Track metadata for lane display */
interface TrackLaneDef {
    id: string;
    label: string;
    color: string;
}

const TRACK_LANES: TrackLaneDef[] = [
    { id: 'camera', label: '相机', color: '#3498db' }
];

/** 特效轨道行高 */
const EFFECT_LANE_HEIGHT = 48;

/**
 * Multi-track timeline playback panel with track lanes.
 */
class TimelinePanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'timeline-panel'
        };

        super(args);

        // ---- top-edge resize handle (same pattern as data-panel) ----
        const resizeHandle = document.createElement('div');
        resizeHandle.id = 'timeline-panel-resize-handle';
        this.dom.appendChild(resizeHandle);

        let resizing = false;
        let startY = 0;
        let startHeight = 0;

        resizeHandle.addEventListener('pointerdown', (event: PointerEvent) => {
            if (event.isPrimary) {
                resizing = true;
                startY = event.clientY;
                startHeight = this.dom.offsetHeight;
                resizeHandle.setPointerCapture(event.pointerId);
                event.preventDefault();
            }
        });

        resizeHandle.addEventListener('pointermove', (event: PointerEvent) => {
            if (resizing) {
                const delta = startY - event.clientY;
                const newHeight = Math.max(120, Math.min(1000, startHeight + delta));
                this.dom.style.height = `${newHeight}px`;
            }
        });

        resizeHandle.addEventListener('pointerup', (event: PointerEvent) => {
            if (resizing && event.isPrimary) {
                resizeHandle.releasePointerCapture(event.pointerId);
            }
        });

        resizeHandle.addEventListener('lostpointercapture', () => {
            resizing = false;
        });

        // ---- Play controls ----
        const prev = new Button({ class: 'button', text: '\uE162' });
        const play = new Button({ class: 'button', text: '\uE131' });
        const next = new Button({ class: 'button', text: '\uE164' });

        const buttonControls = new Container({ id: 'button-controls' });
        buttonControls.append(prev);
        buttonControls.append(play);
        buttonControls.append(next);

        // ---- Settings ----
        const speed = new SelectInput({
            id: 'speed',
            defaultValue: 30,
            options: [
                { v: 1, t: '1 fps' },
                { v: 6, t: '6 fps' },
                { v: 12, t: '12 fps' },
                { v: 24, t: '24 fps' },
                { v: 30, t: '30 fps' },
                { v: 60, t: '60 fps' }
            ]
        });

        speed.on('change', (value: string) => {
            events.fire('timeline.setFrameRate', parseInt(value, 10));
        });

        events.on('timeline.frameRate', (frameRate: number) => {
            speed.value = frameRate.toString();
        });

        const frames = new NumericInput({
            id: 'totalFrames',
            value: 180,
            min: 1,
            max: 10000,
            precision: 0
        });

        frames.on('change', (value: number) => {
            events.fire('timeline.setFrames', value);
        });

        events.on('timeline.frames', (framesIn: number) => {
            frames.value = framesIn;
        });

        const smoothness = new NumericInput({
            id: 'smoothness',
            min: 0,
            max: 1,
            step: 0.05,
            value: 1
        });

        smoothness.on('change', (value: number) => {
            events.fire('timeline.setSmoothness', value);
        });

        // PCUI's pointer-lock slider strips are unreliable in Electron; drive
        // value dragging with the reliable pointer-capture drag instead.
        [frames, smoothness].forEach((inp) => {
            enableReliableInputDrag(inp, () => { });
            hidePcuiSliderStrip(inp);
        });

        events.on('timeline.smoothness', (smoothnessIn: number) => {
            smoothness.value = smoothnessIn;
        });

        const loop = new Button({ id: 'loop', text: '\uE128' });
        loop.on('click', () => {
            events.fire('timeline.setLoop', !events.invoke('timeline.loop'));
        });
        events.on('timeline.loop', (loopIn: boolean) => {
            loop.class[loopIn ? 'add' : 'remove']('active');
        });
        if (events.invoke('timeline.loop')) {
            loop.class.add('active');
        }

        const settingsControls = new Container({ id: 'settings-controls' });
        settingsControls.append(speed);
        settingsControls.append(frames);
        settingsControls.append(smoothness);
        settingsControls.append(loop);

        const controlsWrap = new Container({ id: 'controls-wrap' });
        const spacerL = new Container({ class: 'spacer' });
        const spacerR = new Container({ class: 'spacer' });
        spacerR.append(settingsControls);
        controlsWrap.append(spacerL);
        controlsWrap.append(buttonControls);
        controlsWrap.append(spacerR);

        // ---- Assemble ----
        // ---- Track lanes container ----
        const lanesContainer = new Container({ id: 'timeline-lanes' });
        const lanesDom = lanesContainer.dom;
        lanesDom.style.cssText = 'display:flex;flex-direction:column;height:auto;min-height:100px;overflow:hidden;';

        // Width of the left header column (track names + buttons)
        const HEADER_WIDTH = 150;

        // Extra left margin for the ruler to push tick marks rightward
        const RULER_LEFT_MARGIN = 8;

        // Padding inside the timeline column so keyframe dots at frame 0/N-1 don't clip
        const TL_PADDING = 6;

        // ---- Ticks ruler (starts after header column) ----
        const ticksArea = document.createElement('div');
        ticksArea.id = 'ticks-ruler';
        ticksArea.style.cssText = 'position:relative;height:22px;flex-shrink:0;border-bottom:1px solid #333;';

        const cursorLabel = document.createElement('div');
        cursorLabel.style.cssText = 'position:absolute;width:auto;height:14px;background:#ff6600;color:#fff;font-size:10px;padding:0 4px;line-height:14px;border-radius:2px;pointer-events:none;z-index:11;transform:translateX(-50%);';
        cursorLabel.textContent = '0';
        ticksArea.appendChild(cursorLabel);

        // ---- Lanes body: flex row (headers column + timelines column) ----
        const lanesBody = document.createElement('div');
        lanesBody.id = 'lanes-body';
        lanesBody.style.cssText = 'display:flex;flex-direction:row;flex:1;overflow-y:auto;overflow-x:hidden;';

        // Left column: track headers (fixed width)
        const headersCol = document.createElement('div');
        headersCol.id = 'lane-headers';
        headersCol.style.cssText = `width:${HEADER_WIDTH}px;flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid #333;`;

        // Right column: timelines (flex-grow, position relative for keyframe dots and cursor)
        const timelinesCol = document.createElement('div');
        timelinesCol.id = 'lane-timelines';
        timelinesCol.style.cssText = `flex:1;display:flex;flex-direction:column;position:relative;overflow:hidden;padding:0 ${TL_PADDING}px;`;

        // Cursor line — lives inside the timeline column
        const cursorLine = document.createElement('div');
        cursorLine.id = 'timeline-cursor-line';
        cursorLine.style.cssText = 'position:absolute;top:0;bottom:0;width:1px;background:#ff6600;pointer-events:none;z-index:10;';

        timelinesCol.appendChild(cursorLine);
        lanesBody.appendChild(headersCol);
        lanesBody.appendChild(timelinesCol);
        lanesDom.appendChild(ticksArea);
        lanesDom.appendChild(lanesBody);

        // ---- Build helpers ----
        const scrubTarget: HTMLElement | null = null;
        let lastRebuildWidth = 0;

        // Timeline column content width (subtract side padding so frame 0 → start of usable area)
        const getTimelineWidth = () => timelinesCol.getBoundingClientRect().width - 2 * TL_PADDING;
        const getTotalWidth = () => ticksArea.getBoundingClientRect().width - HEADER_WIDTH - RULER_LEFT_MARGIN;

        const offsetFromFrame = (frame: number, width: number) => {
            const totalFrames = events.invoke('timeline.frames') as number;
            if (totalFrames <= 1) return 0;
            return (frame / (totalFrames - 1)) * width;
        };

        const frameFromOffset = (offsetX: number, width: number) => {
            const totalFrames = events.invoke('timeline.frames') as number;
            if (totalFrames <= 1) return 0;
            return Math.max(0, Math.min(totalFrames - 1, Math.round((offsetX / width) * (totalFrames - 1))));
        };

        // ---- Rebuild entire timeline (debounced) ----
        let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
        const requestRebuild = () => {
            if (rebuildTimer) clearTimeout(rebuildTimer);
            rebuildTimer = setTimeout(() => {
                rebuildTimer = null;
                doRebuild();
            }, 16); // one frame debounce
        };

        const doRebuild = () => {
            const tw = getTotalWidth();
            if (tw > 0 && tw === lastRebuildWidth) return;
            lastRebuildWidth = tw;

            const numFrames = events.invoke('timeline.frames') as number;
            const currentFrame = events.invoke('timeline.frame') as number;

            // Clear ticks (but keep the cursorLabel)
            ticksArea.querySelectorAll('.time-label,.time-tick').forEach(el => el.remove());

            if (tw <= 0) return;

            // Frame labels (positioned relative to ticksArea, offset by HEADER_WIDTH to align with timeline column)
            const minStep = Math.max(1, numFrames / Math.max(1, Math.floor(tw / 50)));
            const magnitude = 10 ** Math.floor(Math.log10(minStep));
            const labelStep = [1, 2, 5, 10].map(m => m * magnitude).find(s => s >= minStep) ?? 10 * magnitude;
            const tickStep = labelStep === 1 ? 0 : labelStep / (labelStep % 5 === 0 ? 5 : 2);

            for (let f = 0; f < numFrames; f += labelStep) {
                const lbl = document.createElement('div');
                lbl.className = 'time-label';
                lbl.style.position = 'absolute';
                lbl.style.left = `${HEADER_WIDTH + RULER_LEFT_MARGIN + offsetFromFrame(f, tw)}px`;
                lbl.style.top = '3px';
                lbl.style.fontSize = '9px';
                lbl.style.color = '#888';
                lbl.textContent = f.toString();
                ticksArea.appendChild(lbl);
            }

            if (tickStep > 0) {
                for (let f = tickStep; f < numFrames; f += tickStep) {
                    if (f % labelStep !== 0) {
                        const tick = document.createElement('div');
                        tick.className = 'time-tick';
                        tick.style.position = 'absolute';
                        tick.style.left = `${HEADER_WIDTH + RULER_LEFT_MARGIN + offsetFromFrame(f, tw)}px`;
                        tick.style.bottom = '0';
                        tick.style.width = '1px';
                        tick.style.height = '6px';
                        tick.style.background = '#555';
                        ticksArea.appendChild(tick);
                    }
                }
            }

            // Update cursor position
            updateCursor(currentFrame, tw);

            // Rebuild lanes
            rebuildLanes();
        };

        const updateCursor = (frame: number, width: number) => {
            const x = offsetFromFrame(frame, width);
            cursorLine.style.left = `${x}px`;
            // cursorLabel lives in ticksArea, so offset by HEADER_WIDTH + RULER_LEFT_MARGIN to align with timeline column
            cursorLabel.style.left = `${HEADER_WIDTH + RULER_LEFT_MARGIN + x}px`;
            cursorLabel.style.top = '2px';
            cursorLabel.textContent = frame.toString();
        };

        // ---- Lanes rebuild (dual-column: headers + timelines) ----
        const rebuildLanes = () => {
            // Clear both columns
            headersCol.querySelectorAll('.track-header').forEach(el => el.remove());
            timelinesCol.querySelectorAll('.track-timeline').forEach(el => el.remove());

            const allKeys = events.invoke('track.allUserKeys') as Record<string, readonly number[]> ?? {};
            const numFrames = events.invoke('timeline.frames') as number;
            const tlw = getTimelineWidth();
            if (tlw <= 0) return;

            const activeTrackId = events.invoke('track.activeId') ?? 'camera';
            const currentFrame = events.invoke('timeline.frame') as number;

            TRACK_LANES.forEach((laneDef) => {
                // Compute key entries for this lane
                const keys = allKeys[laneDef.id] || [];
                const keyEntries = keys.map(kf => ({ frame: kf, subTrackId: laneDef.id, color: laneDef.color }));
                const allLaneKeys = [...keys].sort((a, b) => a - b);

                const hasKeyAtFrame = allLaneKeys.includes(currentFrame);
                let prevKeyFrame = -1;
                let nextKeyFrame = -1;
                for (const kf of allLaneKeys) {
                    if (kf < currentFrame) prevKeyFrame = kf;
                    if (kf > currentFrame && nextKeyFrame === -1) nextKeyFrame = kf;
                }
                const hasPrev = prevKeyFrame >= 0;
                const hasNext = nextKeyFrame >= 0;

                const isActive = laneDef.id === activeTrackId;

                // ==================== HEADER COLUMN ====================
                const header = document.createElement('div');
                header.className = 'track-header';
                header.dataset.trackId = laneDef.id;
                header.style.cssText = `
                    height: 28px; flex-shrink: 0;
                    display: flex; align-items: center; gap: 2px; padding: 0 4px;
                    cursor: pointer; user-select: none;
                    background: ${isActive ? '#2a2a35' : 'transparent'};
                    border-bottom: 1px solid #222;
                `;
                header.addEventListener('mouseenter', () => {
                    header.style.background = '#2a2a35';
                });
                header.addEventListener('mouseleave', () => {
                    const cur = events.invoke('track.activeId') ?? 'camera';
                    header.style.background = laneDef.id === cur ? '#2a2a35' : 'transparent';
                });
                header.addEventListener('click', () => {
                    events.fire('track.setActive', laneDef.id);
                    events.fire('track.activeId', laneDef.id);
                    rebuildLanes();
                });

                // Track name
                const nameSpan = document.createElement('span');
                nameSpan.style.cssText = `font-size:10px;color:${laneDef.color};line-height:1;flex-shrink:0;margin-left:6px;`;
                nameSpan.textContent = laneDef.label;
                header.appendChild(nameSpan);

                // Left arrow
                const leftArrow = document.createElement('button');
                leftArrow.style.cssText = `
                    width:18px;height:18px;padding:0;border:none;background:none;
                    color:${hasPrev ? '#f39c12' : '#444'};font-size:11px;line-height:18px;
                    cursor:${hasPrev ? 'pointer' : 'default'};flex-shrink:0;margin-left:16px;
                    margin-right:6px;display:flex;align-items:center;justify-content:center;
                `;
                leftArrow.textContent = '\u25C0';
                leftArrow.title = hasPrev ? `跳转到第 ${prevKeyFrame} 帧` : '左侧无关键帧';
                if (hasPrev) {
                    leftArrow.addEventListener('click', (e) => {
                        e.stopPropagation(); events.fire('timeline.setFrame', prevKeyFrame);
                    });
                }
                header.appendChild(leftArrow);

                // Keyframe add/delete button
                const kfBtn = document.createElement('button');
                kfBtn.style.cssText = `
                    width:20px;height:20px;padding:0;flex-shrink:0;
                    border:1.5px solid ${hasKeyAtFrame ? '#27ae60' : '#555'};border-radius:3px;cursor:pointer;
                    background:${hasKeyAtFrame ? '#27ae60' : 'transparent'};
                    color:${hasKeyAtFrame ? '#fff' : '#888'};
                    font-size:13px;font-weight:bold;line-height:18px;
                    display:flex;align-items:center;justify-content:center;
                    margin:0 6px;
                `;
                kfBtn.textContent = hasKeyAtFrame ? '\u2212' : '\u25C6';
                kfBtn.title = hasKeyAtFrame ? '删除当前帧关键帧' : '添加关键帧';
                kfBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (hasKeyAtFrame) {
                        events.fire('track.setActive', laneDef.id);
                        events.fire('track.removeKey', currentFrame);
                    } else {
                        events.fire('track.addKeyTo', laneDef.id, currentFrame);
                    }
                });
                header.appendChild(kfBtn);

                // Right arrow
                const rightArrow = document.createElement('button');
                rightArrow.style.cssText = `
                    width:18px;height:18px;padding:0;border:none;background:none;
                    color:${hasNext ? '#f39c12' : '#444'};font-size:11px;line-height:18px;
                    cursor:${hasNext ? 'pointer' : 'default'};flex-shrink:0;
                    margin-left:0;margin-right:8px;display:flex;align-items:center;justify-content:center;
                `;
                rightArrow.textContent = '\u25B6';
                rightArrow.title = hasNext ? `跳转到第 ${nextKeyFrame} 帧` : '右侧无关键帧';
                if (hasNext) {
                    rightArrow.addEventListener('click', (e) => {
                        e.stopPropagation(); events.fire('timeline.setFrame', nextKeyFrame);
                    });
                }
                header.appendChild(rightArrow);

                headersCol.appendChild(header);

                // ==================== TIMELINE COLUMN ====================
                const timeline = document.createElement('div');
                timeline.className = 'track-timeline';
                timeline.dataset.trackId = laneDef.id;
                timeline.style.cssText = `
                    position:relative; height:28px; flex-shrink:0;
                    background:${isActive ? '#1e1e28' : 'transparent'};
                    border-bottom:1px solid #222; cursor:pointer;
                `;
                timeline.addEventListener('click', () => {
                    events.fire('track.setActive', laneDef.id);
                    events.fire('track.activeId', laneDef.id);
                    rebuildLanes();
                });

                // Keyframe dots
                keyEntries.forEach((kf) => {
                    const x = offsetFromFrame(kf.frame, tlw);
                    const dot = document.createElement('div');
                    dot.style.cssText = `
                        position:absolute; left:${x}px; top:50%;
                        transform:translate(-50%,-50%);
                        width:10px;height:10px;
                        background:${kf.color};
                        clip-path:polygon(50% 0%,100% 50%,50% 100%,0% 50%);
                        cursor:pointer; z-index:5;
                    `;
                    dot.title = `Frame ${kf.frame}`;
                    dot.dataset.subTrack = kf.subTrackId;

                    let dragging = false;
                    let startX = 0;
                    let startFrame = 0;

                    dot.addEventListener('pointerdown', (e) => {
                        e.stopPropagation();
                        dragging = true;
                        startX = e.clientX;
                        startFrame = kf.frame;
                        dot.style.opacity = '0.6';
                        dot.setPointerCapture(e.pointerId);
                    });
                    dot.addEventListener('pointermove', (e) => {
                        if (!dragging) return;
                        const dx = e.clientX - startX;
                        const frameDelta = Math.round((dx / tlw) * numFrames);
                        const newFrame = Math.max(0, Math.min(numFrames - 1, startFrame + frameDelta));
                        dot.style.left = `${offsetFromFrame(newFrame, tlw)}px`;
                    });
                    dot.addEventListener('pointerup', (e) => {
                        if (!dragging) return;
                        dragging = false;
                        dot.style.opacity = '1';
                        dot.releasePointerCapture(e.pointerId);
                        const dx = e.clientX - startX;
                        const frameDelta = Math.round((dx / tlw) * numFrames);
                        const newFrame = Math.max(0, Math.min(numFrames - 1, startFrame + frameDelta));
                        if (newFrame !== startFrame) {
                            events.fire('track.setActive', laneDef.id);
                            events.fire('track.activeId', laneDef.id);
                            setTimeout(() => events.fire('track.moveKey', startFrame, newFrame), 10);
                        }
                    });

                    timeline.appendChild(dot);
                });

                timelinesCol.appendChild(timeline);
            });

            // ---- 特效轨道（时间线下方）：三态开关 + 可拖动/调长的图层 ----
            renderEffectsLane();

            // ---- 音频轨道（人声/音乐）：导入/录制 + 波形 + 可拖动/trim ----
            renderAudioLanes();
        };

        // ==================== 特效轨道 ====================
        // 头部：轨道名 + 开场/散场 两个独立开关 + 预设下拉（选中时）
        // 时间线区：intro/outro 两个特效图层条（各自可整体拖动、左右边缘调长）
        let selectedEffect: 'intro' | 'outro' | null = null;
        let fxClipDrag: {
            which: 'intro' | 'outro';
            type: 'resizeL' | 'resizeR';
            startX: number;
            origStart: number;
            origEnd: number;
            /** 拖动过程中的最新区间（pointermove 持续更新，pointerup 时提交） */
            curStart: number;
            curEnd: number;
        } | null = null;

        const fxState = () => events.invoke('effects.getState') as {
            intro: { enabled: boolean; start: number; end: number; easingIn: boolean; easingOut: boolean; presetId: string };
            outro: { enabled: boolean; start: number; end: number; easingIn: boolean; easingOut: boolean; presetId: string };
        };

        const renderEffectsLane = () => {
            const st = fxState();
            const tlw = getTimelineWidth();
            const totalFrames = events.invoke('timeline.frames') as number;

            // ---- header ----
            const header = document.createElement('div');
            header.className = 'track-header';
            header.dataset.trackId = 'effects';
            header.style.cssText = `
                height: ${EFFECT_LANE_HEIGHT}px; flex-shrink: 0;
                display: flex; align-items: center; gap: 2px; padding: 0 4px;
                user-select: none;
                background: ${selectedEffect ? '#2a2433' : '#1d1d24'};
                border-bottom: 1px solid #222;
            `;

            const nameSpan = document.createElement('span');
            nameSpan.style.cssText = 'font-size:10px;color:#e67e22;line-height:1;flex-shrink:0;margin-left:6px;';
            nameSpan.textContent = '特效';
            header.appendChild(nameSpan);

            // 两个独立开关：开场 / 散场（可同时开启）
            const mkEnableBtn = (which: 'intro' | 'outro', label: string, on: boolean) => {
                const b = document.createElement('button');
                b.textContent = label;
                b.style.cssText = `
                    flex:1; min-width:0; height:20px; padding:0 2px; margin:0 1px;
                    border:1px solid ${on ? (which === 'intro' ? '#e67e22' : '#9b59b6') : '#444'};
                    border-radius:3px; cursor:pointer; font-size:9px; line-height:18px;
                    background:${on ? (which === 'intro' ? 'rgba(230,126,34,0.35)' : 'rgba(155,89,182,0.35)') : 'transparent'};
                    color:${on ? '#fff' : '#888'}; white-space:nowrap;
                `;
                b.title = which === 'intro' ? '开场：粒子聚拢成为模型（从无到有）' : '散场：模型散开消失（从有到无）';
                b.addEventListener('click', (e) => {
                    e.stopPropagation();
                    events.fire('effects.setEnabled', which, !on);
                    rebuildLanes();
                });
                return b;
            };

            const modeWrap = document.createElement('div');
            modeWrap.style.cssText = 'display:flex;flex:1;margin-left:8px;';
            modeWrap.appendChild(mkEnableBtn('intro', '开场', st.intro.enabled));
            modeWrap.appendChild(mkEnableBtn('outro', '散场', st.outro.enabled));
            header.appendChild(modeWrap);

            headersCol.appendChild(header);

            // ---- timeline 区 ----
            const tl = document.createElement('div');
            tl.className = 'track-timeline';
            tl.dataset.trackId = 'effects';
            tl.style.cssText = `
                position:relative; height:${EFFECT_LANE_HEIGHT}px; flex-shrink:0;
                background:${selectedEffect ? '#211d2a' : '#1a1a20'};
                border-bottom:1px solid #222; cursor:default; overflow:hidden;
            `;

            // 点击轨道空白处 → 取消选中
            tl.addEventListener('click', () => {
                selectedEffect = null;
                rebuildLanes();
            });

            // 渲染单个特效图层
            const renderClip = (which: 'intro' | 'outro') => {
                const clipState = st[which];
                if (!clipState.enabled || clipState.end <= clipState.start) return;
                // 开场图层左端锚定帧 0（时间线起点），散场图层右端锚定最后一帧
                const lastFrame = totalFrames - 1;
                const visStart = which === 'intro' ? 0 : clipState.start;
                const visEnd = which === 'outro' ? lastFrame : clipState.end;
                const x0 = offsetFromFrame(visStart, tlw);
                const x1 = offsetFromFrame(visEnd, tlw);
                const clip = document.createElement('div');
                const introBg = 'linear-gradient(90deg, rgba(230,126,34,0.55), rgba(230,126,34,0.25))';
                const outroBg = 'linear-gradient(90deg, rgba(155,89,182,0.25), rgba(155,89,182,0.55))';
                const clipBg = which === 'intro' ? introBg : outroBg;
                const clipBorder = which === 'intro' ? '#e67e22' : '#9b59b6';
                const isSel = selectedEffect === which;
                // 开场与散场图层放在同一水平层（都居中占满轨道高度），
                // 重叠时选中者 z-index 更高显示在上
                clip.style.cssText = `
                    position:absolute; left:${x0}px; width:${Math.max(8, x1 - x0)}px; top:6px; bottom:6px;
                    background:${clipBg};
                    border:1px solid ${isSel ? '#fff' : clipBorder};
                    border-radius:3px; cursor:grab; z-index:${isSel ? 8 : 6};
                    display:flex; align-items:center; gap:3px; padding:0 4px;
                `;
                clip.title = `${which === 'intro' ? '开场' : '散场'} ${clipState.start} → ${clipState.end}`;

                // 预设下拉（放在图层开头，替代特效名字；初始粒子化）
                const sel = document.createElement('select');
                sel.style.cssText = `
                    flex-shrink:0; min-width:0; max-width:90px; height:16px; font-size:8px; line-height:14px;
                    background:rgba(0,0,0,0.45); color:#fff; border:1px solid rgba(255,255,255,0.3);
                    border-radius:2px; cursor:pointer; pointer-events:auto; z-index:9;
                `;
                sel.title = '特效预设';
                // 只显示该图层可用的预设（开场只显示开场预设，散场只显示散场预设）
                const presets = events.invoke('effects.presets', which) as { id: string; title: string }[] ?? [];
                for (const p of presets) {
                    const opt = document.createElement('option');
                    opt.value = p.id; opt.textContent = p.title;
                    sel.appendChild(opt);
                }
                if (!presets.some(p => p.id === clipState.presetId)) {
                    // 预设与图层不匹配（如曾选散场预设又被切到开场）：回退默认
                    sel.value = presets[0]?.id ?? '';
                } else {
                    sel.value = clipState.presetId;
                }
                // 阻止事件冒泡：pointerdown 防拖动、click 防冒泡到 tl 触发
                // rebuild（否则下拉被销毁重建，导致闪烁无法选中）
                sel.addEventListener('pointerdown', (e) => {
                    e.stopPropagation();
                });
                sel.addEventListener('click', (e) => {
                    e.stopPropagation();
                });
                sel.addEventListener('change', () => {
                    events.fire('effects.setPreset', which, sel.value);
                    // 延迟到事件循环之后重建，避免下拉 popup 被立即销毁
                    requestAnimationFrame(() => rebuildLanes());
                });
                clip.appendChild(sel);

                // 缓入 / 缓出开关（图层右侧，控制粒子动画节奏）
                const easeWrap = document.createElement('div');
                easeWrap.style.cssText = `
                    margin-left:auto; display:flex; gap:2px; pointer-events:none; z-index:8; flex-shrink:0;
                `;
                const mkEaseToggle = (label: string, on: boolean, fire: (v: boolean) => void) => {
                    const b = document.createElement('button');
                    b.textContent = label;
                    b.style.cssText = `
                        height:16px; padding:0 4px; font-size:8px; line-height:14px; border-radius:2px;
                        border:1px solid ${on ? '#27ae60' : 'rgba(255,255,255,0.25)'};
                        background:${on ? 'rgba(39,174,96,0.4)' : 'rgba(0,0,0,0.35)'};
                        color:${on ? '#fff' : 'rgba(255,255,255,0.75)'}; cursor:pointer; pointer-events:auto;
                    `;
                    b.title = `${label}：${on ? '开' : '关'}`;
                    b.addEventListener('pointerdown', (e) => {
                        e.stopPropagation();
                    });
                    b.addEventListener('click', (e) => {
                        e.stopPropagation();
                        fire(!on);
                        rebuildLanes();
                    });
                    return b;
                };
                easeWrap.appendChild(mkEaseToggle('缓入', clipState.easingIn, v => events.fire('effects.setEasingIn', which, v)));
                easeWrap.appendChild(mkEaseToggle('缓出', clipState.easingOut, v => events.fire('effects.setEasingOut', which, v)));
                clip.appendChild(easeWrap);

                // 左右调长手柄
                const mkHandle = (side: 'L' | 'R') => {
                    const h = document.createElement('div');
                    h.style.cssText = `
                        position:absolute; ${side === 'L' ? 'left:0' : 'right:0'}; top:0; bottom:0;
                        width:6px; cursor:ew-resize;
                    `;
                    h.addEventListener('pointerdown', (e) => {
                        e.stopPropagation();
                        selectedEffect = which;
                        fxClipDrag = {
                            which,
                            type: side === 'L' ? 'resizeL' : 'resizeR',
                            startX: e.clientX,
                            origStart: clipState.start,
                            origEnd: clipState.end,
                            curStart: clipState.start,
                            curEnd: clipState.end
                        };
                        h.setPointerCapture(e.pointerId);
                    });
                    return h;
                };

                // 点击图层 → 选中
                clip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    selectedEffect = which;
                    rebuildLanes();
                });

                // 开场/散场固定在最前/最尾：不提供整体移动。
                // 开场只能拖右边缘调长，散场只能拖左边缘调长。
                clip.addEventListener('pointermove', (e) => {
                    if (!fxClipDrag || fxClipDrag.which !== which) return;
                    const dx = e.clientX - fxClipDrag.startX;
                    const deltaFrames = Math.round((dx / tlw) * totalFrames);
                    let s: number;
                    let e2: number;
                    if (fxClipDrag.type === 'resizeL') {
                        // 散场：左端可调，右端锚定最后一帧
                        s = Math.max(0, Math.min(fxClipDrag.origEnd - 1, fxClipDrag.origStart + deltaFrames));
                        e2 = totalFrames - 1;
                    } else {
                        // 开场：右端可调，左端锚定帧 0
                        s = 0;
                        e2 = Math.max(1, Math.min(totalFrames - 1, fxClipDrag.origEnd + deltaFrames));
                    }
                    // 保存最新区间（pointerup 时提交），并直接更新元素位置
                    // （避免 rebuild 销毁被拖元素导致拖动中断）
                    fxClipDrag.curStart = s;
                    fxClipDrag.curEnd = e2;
                    const nx0 = offsetFromFrame(s, tlw);
                    const nx1 = offsetFromFrame(e2, tlw);
                    clip.style.left = `${nx0}px`;
                    clip.style.width = `${Math.max(8, nx1 - nx0)}px`;
                });
                const endDrag = () => {
                    if (fxClipDrag && fxClipDrag.which === which) {
                        // 提交拖动过程中的最新区间
                        events.fire('effects.setClip', which, fxClipDrag.curStart, fxClipDrag.curEnd);
                        fxClipDrag = null;
                        requestRebuild();
                    }
                };
                clip.addEventListener('pointerup', endDrag);
                clip.addEventListener('lostpointercapture', endDrag);

                // 开场固定在最前端：只显示右手柄（右端可调长）；
                // 散场固定在最后端：只显示左手柄（左端可调长）
                if (which === 'intro') {
                    clip.appendChild(mkHandle('R'));
                } else {
                    clip.appendChild(mkHandle('L'));
                }

                tl.appendChild(clip);
            };

            renderClip('intro');
            renderClip('outro');

            // 无任何图层时的提示
            if (!st.intro.enabled && !st.outro.enabled) {
                const hint = document.createElement('span');
                hint.textContent = '点击 开场 / 散场 创建特效图层（可同时开启）';
                hint.style.cssText = 'position:absolute;left:6px;top:50%;transform:translateY(-50%);font-size:9px;color:#555;pointer-events:none;';
                tl.appendChild(hint);
            }

            timelinesCol.appendChild(tl);
        };

        // ==================== 音频轨道（人声 / 音乐） ====================
        // 头部：轨道名 + 添加/录制（人声）、添加/淡入/淡出（音乐）
        // 时间线区：音频 clip 条（波形）+ 可整体移动 + 左右边缘 trim
        const AUDIO_LANE_HEIGHT = 46;
        // 用对象引用包裹拖动状态，避免循环内闭包 no-loop-func
        const audioDragRef: {
            current: {
                id: string;
                type: 'move' | 'trimL' | 'trimR' | 'fadeIn' | 'fadeOut';
                startX: number;
                startFrame: number;
                origTrimStart: number;
                origTrimEnd: number;
                curStartFrame: number;
                curTrimStart: number;
                curTrimEnd: number;
                origFade?: number;
                curFade?: number;
                /** 拖动中的目标元素（bar 或伸缩区），避免 rebuild 后引用失效 */
                el: HTMLElement | null;
                /** trimR 上限：音频总时长（秒） */
                _bufDur?: number;
                /** fade 区域条宽（px） */
                _barW?: number;
                /** 波形 canvas 引用（trim 拖动时实时重绘） */
                _cv?: HTMLCanvasElement | null;
                /** 波形峰值数据 */
                _peaks?: Float32Array | null;
                /** 所属轨道 */
                _track?: 'voice' | 'music';
            } | null;
        } = { current: null };

        const renderAudioLanes = () => {
            const clips = events.invoke('audio.clips') as {
                id: string; track: 'voice' | 'music'; name: string;
                startFrame: number; trimStart: number; trimEnd: number;
                fadeIn: number; fadeOut: number; peaks: Float32Array; buffer: AudioBuffer;
            }[] ?? [];
            const tlw = getTimelineWidth();
            const totalFrames = events.invoke('timeline.frames') as number;
            const frameRate = (events.invoke('timeline.frameRate') as number) ?? 30;
            const recording = events.invoke('audio.recording') as boolean ?? false;

            const mkLane = (track: 'voice' | 'music', label: string, color: string, enabledClips: typeof clips) => {
                // ---- header ----
                const header = document.createElement('div');
                header.className = 'track-header';
                header.dataset.trackId = `audio-${track}`;
                header.style.cssText = `
                    height: ${AUDIO_LANE_HEIGHT}px; flex-shrink: 0;
                    display: flex; align-items: center; gap: 2px; padding: 0 4px;
                    user-select: none; background: #191922; border-bottom: 1px solid #222;
                `;

                const nameSpan = document.createElement('span');
                nameSpan.style.cssText = `font-size:10px;color:${color};line-height:1;flex-shrink:0;margin-left:6px;width:26px;`;
                nameSpan.textContent = label;
                header.appendChild(nameSpan);

                // 添加（导入音频）
                const addBtn = document.createElement('button');
                addBtn.textContent = '添加';
                addBtn.style.cssText = `
                    height:18px; padding:0 5px; border:1px solid #555; border-radius:3px;
                    cursor:pointer; font-size:9px; line-height:16px; background:#222; color:#bbb;
                `;
                addBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = 'audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac';
                    input.style.display = 'none';
                    document.body.appendChild(input);
                    input.onchange = () => {
                        const file = input.files?.[0];
                        if (file) events.fire('audio.import', track, file);
                        input.remove();
                    };
                    input.click();
                });
                header.appendChild(addBtn);

                if (track === 'voice') {
                    // 录制 / 停止
                    const recBtn = document.createElement('button');
                    recBtn.textContent = recording ? '停止' : '录制';
                    recBtn.style.cssText = `
                        height:18px; padding:0 5px; border:1px solid ${recording ? '#e74c3c' : '#555'};
                        border-radius:3px; cursor:pointer; font-size:9px; line-height:16px;
                        background:${recording ? 'rgba(231,76,60,0.35)' : '#222'};
                        color:${recording ? '#fff' : '#bbb'};
                    `;
                    recBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        events.fire('audio.toggleRecord');
                        // 录制状态变化后重建（停止后显示波形）
                        setTimeout(() => rebuildLanes(), 100);
                        setTimeout(() => rebuildLanes(), 1500);
                    });
                    header.appendChild(recBtn);
                } else {
                    // 音乐：淡入/淡出在音频条两端伸缩区控制（见 clip 渲染）
                    const fadeHint = document.createElement('span');
                    fadeHint.textContent = '拖两端';
                    fadeHint.style.cssText = 'font-size:8px;color:#666;margin-left:4px;white-space:nowrap;overflow:hidden;';
                    fadeHint.title = '淡入/淡出：拖音频条两端绿色区域调整时长';
                    header.appendChild(fadeHint);
                }

                headersCol.appendChild(header);

                // ---- timeline 区 ----
                const tl = document.createElement('div');
                tl.className = 'track-timeline';
                tl.dataset.trackId = `audio-${track}`;
                tl.style.cssText = `
                    position:relative; height:${AUDIO_LANE_HEIGHT}px; flex-shrink:0;
                    background:#16161d; border-bottom:1px solid #222; overflow:hidden;
                `;

                // 空轨提示
                if (enabledClips.length === 0) {
                    const hint = document.createElement('span');
                    const hintText = track === 'voice' ? '点击 添加 导入或 录制 采集人声' : '点击 添加 导入音乐';
                    hint.textContent = hintText;
                    hint.style.cssText = 'position:absolute;left:6px;top:50%;transform:translateY(-50%);font-size:9px;color:#555;pointer-events:none;';
                    tl.appendChild(hint);
                }

                // 渲染每个 clip
                for (const clip of enabledClips) {
                    const durSec = clip.trimEnd - clip.trimStart;
                    const clipFrames = Math.max(1, Math.round(durSec * frameRate));
                    const x0 = offsetFromFrame(clip.startFrame, tlw);
                    const x1 = offsetFromFrame(clip.startFrame + clipFrames, tlw);
                    const barW = Math.max(24, x1 - x0);
                    const bar = document.createElement('div');
                    bar.style.cssText = `
                        position:absolute; left:${x0}px; width:${barW}px;
                        top:4px; bottom:4px; background:rgba(20,20,28,0.9);
                        border:1px solid ${track === 'voice' ? '#2ecc71' : '#3498db'};
                        border-radius:3px; cursor:grab; z-index:6; overflow:hidden;
                        display:flex; align-items:center; gap:0;
                    `;
                    bar.title = `${clip.name}（${clip.trimStart.toFixed(1)}s→${clip.trimEnd.toFixed(1)}s）`;

                    // 左侧：音频名称（固定宽度，波形占满剩余条身）
                    const nameTag = document.createElement('span');
                    nameTag.textContent = clip.name;
                    nameTag.style.cssText = `
                        flex-shrink:0; width:58px; padding:0 4px; font-size:9px; color:#ddd;
                        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; pointer-events:none;
                    `;
                    bar.appendChild(nameTag);

                    // 右侧：波形 canvas（固定像素宽度，波形铺满整条，与播放时间统一）
                    const NAME_W = 58;
                    const cvW = Math.max(4, barW - NAME_W);
                    const cv = document.createElement('canvas');
                    cv.width = cvW;
                    cv.height = 26;
                    cv.style.cssText = `width:${cvW}px;height:100%;pointer-events:none;flex-shrink:0;`;
                    const g = cv.getContext('2d');
                    if (g) {
                        g.clearRect(0, 0, cv.width, cv.height);
                        g.fillStyle = track === 'voice' ? 'rgba(46,204,113,0.65)' : 'rgba(52,152,219,0.65)';
                        const peaks = clip.peaks;
                        const mid = cv.height / 2;
                        const pl = peaks.length;
                        // 波形只画"可见范围"对应的部分：把 peaks 桶按
                        // trimStart/trimEnd 裁剪（与拖动时 redrawWaveform 一致）。
                        // 否则音频被拉长后重建的波形会把整个文件的 peaks 拉伸
                        // 铺满，看起来波形"跟着拉长"而不是显示新内容。
                        const bufDur = clip.buffer.duration || 1;
                        const startFrac = clip.trimStart / bufDur;
                        const endFrac = clip.trimEnd / bufDur;
                        for (let i = 0; i < cv.width; i++) {
                            const frac = i / Math.max(1, cv.width - 1);
                            const audioFrac = startFrac + frac * (endFrac - startFrac);
                            const idx = Math.min(pl - 1, Math.max(0, Math.floor(audioFrac * pl)));
                            const h = Math.max(1, peaks[idx] * (cv.height - 4));
                            g.fillRect(i, mid - h / 2, 1, h);
                        }
                        // 淡入/淡出渐变覆盖（音乐轨道）：两端斜切遮罩
                        if (track === 'music' && (clip.fadeIn > 0 || clip.fadeOut > 0)) {
                            const fadeInPx = Math.min(cv.width, Math.round(clip.fadeIn / durSec * cv.width));
                            const fadeOutPx = Math.min(cv.width, Math.round(clip.fadeOut / durSec * cv.width));
                            if (fadeInPx > 0) {
                                const grd = g.createLinearGradient(0, 0, fadeInPx, 0);
                                grd.addColorStop(0, 'rgba(20,20,28,1)');
                                grd.addColorStop(1, 'rgba(20,20,28,0)');
                                g.fillStyle = grd;
                                g.fillRect(0, 0, fadeInPx, cv.height);
                            }
                            if (fadeOutPx > 0) {
                                const grd = g.createLinearGradient(cv.width - fadeOutPx, 0, cv.width, 0);
                                grd.addColorStop(0, 'rgba(20,20,28,0)');
                                grd.addColorStop(1, 'rgba(20,20,28,1)');
                                g.fillStyle = grd;
                                g.fillRect(cv.width - fadeOutPx, 0, fadeOutPx, cv.height);
                            }
                        }
                    }
                    bar.appendChild(cv);

                    // 淡入/淡出伸缩区域（音乐轨道）：两端可拖动调整时长
                    if (track === 'music') {
                        const durSec2 = clip.trimEnd - clip.trimStart;
                        const mkFadeZone = (which: 'in' | 'out') => {
                            const sec = which === 'in' ? clip.fadeIn : clip.fadeOut;
                            const px = Math.max(14, Math.round(sec / durSec2 * barW));
                            const zone = document.createElement('div');
                            const zoneBg = which === 'in' ?
                                'linear-gradient(90deg, rgba(46,204,113,0.55), rgba(46,204,113,0.05))' :
                                'linear-gradient(270deg, rgba(46,204,113,0.55), rgba(46,204,113,0.05))';
                            zone.style.cssText = `
                                position:absolute; ${which === 'in' ? 'left:0' : 'right:0'}; top:0; bottom:0;
                                width:${px}px; cursor:ew-resize; z-index:9;
                                background:${zoneBg};
                                border-${which === 'in' ? 'right' : 'left'}:1px dashed #2ecc71;
                            `;
                            zone.title = `淡${which === 'in' ? '入' : '出'} ${sec.toFixed(1)}s（拖动调整）`;
                            // 时长小标签
                            const lbl = document.createElement('span');
                            lbl.textContent = `${sec.toFixed(1)}s`;
                            lbl.style.cssText = `
                                position:absolute; ${which === 'in' ? 'right:2px' : 'left:2px'}; top:1px;
                                font-size:7px; color:#aef5c9; pointer-events:none; z-index:10;
                            `;
                            zone.appendChild(lbl);
                            zone.addEventListener('pointerdown', (e) => {
                                e.stopPropagation();
                                audioDragRef.current = {
                                    id: clip.id,
                                    type: which === 'in' ? 'fadeIn' : 'fadeOut',
                                    startX: e.clientX,
                                    startFrame: clip.startFrame,
                                    origTrimStart: clip.trimStart,
                                    origTrimEnd: clip.trimEnd,
                                    curStartFrame: clip.startFrame,
                                    curTrimStart: clip.trimStart,
                                    curTrimEnd: clip.trimEnd,
                                    origFade: sec,
                                    el: zone,
                                    _barW: barW
                                };
                            });
                            return zone;
                        };
                        if (clip.fadeIn > 0) bar.appendChild(mkFadeZone('in'));
                        if (clip.fadeOut > 0) bar.appendChild(mkFadeZone('out'));
                    }

                    // 删除按钮（悬停显示）
                    const del = document.createElement('button');
                    del.textContent = '×';
                    del.style.cssText = `
                        position:absolute; right:1px; top:1px; width:14px; height:14px; padding:0;
                        border:none; background:rgba(231,76,60,0.8); color:#fff; font-size:10px;
                        line-height:12px; border-radius:2px; cursor:pointer; z-index:8; display:none;
                    `;
                    del.title = '移除音频';
                    del.addEventListener('click', (e) => {
                        e.stopPropagation();
                        events.fire('audio.removeClip', clip.id);
                        rebuildLanes();
                    });
                    del.addEventListener('pointerdown', (e) => {
                        e.stopPropagation();
                    });
                    bar.appendChild(del);
                    bar.addEventListener('mouseenter', () => {
                        del.style.display = 'block';
                    });
                    bar.addEventListener('mouseleave', () => {
                        del.style.display = 'none';
                    });

                    // trim 手柄（加宽 + 视觉标记便于操作）
                    const mkTrimHandle = (side: 'L' | 'R') => {
                        const h = document.createElement('div');
                        const hBg = side === 'L' ?
                            'repeating-linear-gradient(90deg, rgba(255,255,255,0.25) 0 2px, transparent 2px 4px)' :
                            'repeating-linear-gradient(90deg, transparent 0 2px, rgba(255,255,255,0.25) 2px 4px)';
                        h.style.cssText = `
                            position:absolute; ${side === 'L' ? 'left:0' : 'right:0'}; top:0; bottom:0;
                            width:10px; cursor:ew-resize; z-index:10;
                            background:${hBg};
                        `;
                        h.title = '拖动调整音频起点/终点（trim）';
                        h.addEventListener('pointerdown', (e) => {
                            e.stopPropagation();
                            audioDragRef.current = {
                                id: clip.id,
                                type: side === 'L' ? 'trimL' : 'trimR',
                                startX: e.clientX,
                                startFrame: clip.startFrame,
                                origTrimStart: clip.trimStart,
                                origTrimEnd: clip.trimEnd,
                                curStartFrame: clip.startFrame,
                                curTrimStart: clip.trimStart,
                                curTrimEnd: clip.trimEnd,
                                // el 指向 bar：拖动时改整条宽度（而非手柄自身）
                                el: bar,
                                _bufDur: clip.buffer.duration,
                                _barW: barW,
                                _cv: cv,
                                _peaks: clip.peaks,
                                _track: track
                            };
                        });
                        return h;
                    };

                    // 整体移动
                    bar.addEventListener('pointerdown', (e) => {
                        if ((e.target as HTMLElement).style.cursor === 'ew-resize') return;
                        e.stopPropagation();
                        audioDragRef.current = {
                            id: clip.id,
                            type: 'move',
                            startX: e.clientX,
                            startFrame: clip.startFrame,
                            origTrimStart: clip.trimStart,
                            origTrimEnd: clip.trimEnd,
                            curStartFrame: clip.startFrame,
                            curTrimStart: clip.trimStart,
                            curTrimEnd: clip.trimEnd,
                            el: bar,
                            _cv: cv,
                            _peaks: clip.peaks,
                            _track: track
                        };
                    });
                    bar.appendChild(mkTrimHandle('L'));
                    bar.appendChild(mkTrimHandle('R'));

                    tl.appendChild(bar);
                }

                timelinesCol.appendChild(tl);
            };

            mkLane('voice', '人声', '#2ecc71', clips.filter(c => c.track === 'voice'));
            mkLane('music', '音乐', '#3498db', clips.filter(c => c.track === 'music'));
        };

        // 音频拖动：document 级 pointermove/pointerup（不依赖 bar 的 pointer
        // capture，rebuild 重建 DOM 不会中断拖动）
        // trim 拖动时按新可见范围实时重绘波形
        const redrawWaveform = (drag: NonNullable<typeof audioDragRef.current>) => {
            const cv = drag._cv;
            const peaks = drag._peaks;
            if (!cv || !peaks) return;
            const dur = drag.curTrimEnd - drag.curTrimStart;
            // 波形只画"可见范围"对应的部分：把 peaks 桶按 trimStart/trimEnd 裁剪
            const total = drag._bufDur ?? 1;
            const startFrac = total > 0 ? drag.curTrimStart / total : 0;
            const endFrac = total > 0 ? drag.curTrimEnd / total : 1;
            const g = cv.getContext('2d');
            if (!g) return;
            g.clearRect(0, 0, cv.width, cv.height);
            g.fillStyle = drag._track === 'voice' ? 'rgba(46,204,113,0.65)' : 'rgba(52,152,219,0.65)';
            const mid = cv.height / 2;
            const pl = peaks.length;
            for (let i = 0; i < cv.width; i++) {
                const frac = i / Math.max(1, cv.width - 1);
                // 当前像素对应的音频内位置（trimStart→trimEnd）
                const audioFrac = startFrac + frac * (endFrac - startFrac);
                const idx = Math.min(pl - 1, Math.max(0, Math.floor(audioFrac * pl)));
                const h = Math.max(1, peaks[idx] * (cv.height - 4));
                g.fillRect(i, mid - h / 2, 1, h);
            }
        };

        document.addEventListener('pointermove', (e) => {
            const drag = audioDragRef.current;
            if (!drag || !drag.el) return;
            const dx = e.clientX - drag.startX;
            const deltaFrames = Math.round((dx / getTimelineWidth()) * ((events.invoke('timeline.frames') as number) ?? 180));
            const frameRate = (events.invoke('timeline.frameRate') as number) ?? 30;
            const tlw2 = getTimelineWidth();
            const totalF2 = (events.invoke('timeline.frames') as number) ?? 180;
            const type = drag.type;
            const el = drag.el;
            if (type === 'move') {
                drag.curStartFrame = Math.max(0, drag.startFrame + deltaFrames);
                const nx0 = offsetFromFrame(drag.curStartFrame, tlw2);
                el.style.left = `${nx0}px`;
            } else if (type === 'trimL') {
                const deltaSec = dx / tlw2 * totalF2 / frameRate;
                drag.curTrimStart = Math.max(0, Math.min(drag.origTrimEnd - 0.1, drag.origTrimStart + deltaSec));
                const dur = drag.curTrimEnd - drag.curTrimStart;
                const w = Math.max(12, Math.round(dur * frameRate / totalF2 * tlw2));
                el.style.width = `${w}px`;
                redrawWaveform(drag);
            } else if (type === 'trimR') {
                const deltaSec = dx / tlw2 * totalF2 / frameRate;
                drag.curTrimEnd = Math.max(drag.origTrimStart + 0.1, Math.min(drag._bufDur ?? 300, drag.origTrimEnd + deltaSec));
                const dur = drag.curTrimEnd - drag.curTrimStart;
                const w = Math.max(12, Math.round(dur * frameRate / totalF2 * tlw2));
                el.style.width = `${w}px`;
                redrawWaveform(drag);
            } else if (type === 'fadeIn' || type === 'fadeOut') {
                const deltaSec = dx / tlw2 * totalF2 / frameRate;
                const origFade = drag.origFade ?? 1;
                const newFade = Math.max(0, Math.min(drag.curTrimEnd - drag.curTrimStart, origFade + deltaSec));
                const dur = drag.curTrimEnd - drag.curTrimStart;
                const px = Math.max(4, Math.round(newFade / dur * drag._barW));
                el.style.width = `${px}px`;
                drag.curFade = newFade;
            }
        });

        document.addEventListener('pointerup', () => {
            const drag = audioDragRef.current;
            if (!drag) return;
            const type = drag.type;
            if (type === 'move') {
                events.fire('audio.setPositionClipped', drag.id, drag.curStartFrame);
            } else if (type === 'trimL' || type === 'trimR') {
                events.fire('audio.setTrim', drag.id, drag.curTrimStart, drag.curTrimEnd);
            } else if (type === 'fadeIn') {
                events.fire('audio.setFade', drag.id, 'in', drag.curFade ?? 1);
            } else if (type === 'fadeOut') {
                events.fire('audio.setFade', drag.id, 'out', drag.curFade ?? 1);
            }
            audioDragRef.current = null;
            requestRebuild();
        });

        // ---- Scrubbing (on timeline column) ----
        let scrubbing = false;

        timelinesCol.addEventListener('pointerdown', (e) => {
            if ((e.target as HTMLElement).closest('.track-timeline')) {
                scrubbing = true;
                const tlw = getTimelineWidth();
                const rect = timelinesCol.getBoundingClientRect();
                events.fire('timeline.setFrame', frameFromOffset(e.clientX - rect.left - TL_PADDING, tlw));
            }
        });

        timelinesCol.addEventListener('pointermove', (e) => {
            if (scrubbing) {
                const tlw = getTimelineWidth();
                const rect = timelinesCol.getBoundingClientRect();
                events.fire('timeline.setFrame', frameFromOffset(e.clientX - rect.left - TL_PADDING, tlw));
            }
        });

        document.addEventListener('pointerup', () => {
            scrubbing = false;
        });

        // ---- Click on ticks ruler to seek ----
        ticksArea.addEventListener('pointerdown', (e) => {
            // Ignore clicks on cursorLabel (already has pointer-events:none but belt-and-suspenders)
            if ((e.target as HTMLElement).closest('#timeline-cursor-line')) return;
            const tw = getTotalWidth();
            const rect = ticksArea.getBoundingClientRect();
            const x = e.clientX - rect.left - HEADER_WIDTH - RULER_LEFT_MARGIN;
            if (x >= 0) {
                events.fire('timeline.setFrame', frameFromOffset(x, tw));
            }
        });

        // ---- Right-click context menu on track timelines ----
        let contextMenu: HTMLDivElement | null = null;

        const hideContextMenu = () => {
            contextMenu?.remove();
            contextMenu = null;
        };

        timelinesCol.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            hideContextMenu();

            const tlw = getTimelineWidth();
            const rect = timelinesCol.getBoundingClientRect();
            const frame = frameFromOffset(e.clientX - rect.left - TL_PADDING, tlw);

            // Determine which track was right-clicked
            const trackTimeline = (e.target as HTMLElement).closest('.track-timeline') as HTMLElement | null;
            const trackId = trackTimeline?.dataset.trackId ?? (events.invoke('track.activeId') as string) ?? 'camera';

            // Check if there's a keyframe at this frame
            const allKeys = events.invoke('track.allUserKeys') as Record<string, readonly number[]> ?? {};
            const keys = allKeys[trackId] || [];
            const hasKeyAtFrame = keys.includes(frame);

            // Build context menu
            const menu = document.createElement('div');
            menu.style.cssText = `
                position: fixed; left: ${e.clientX}px; top: ${e.clientY}px;
                background: #2a2a30; border: 1px solid #444;
                border-radius: 4px; padding: 4px 0; z-index: 10000;
                min-width: 130px; box-shadow: 0 4px 16px rgba(0,0,0,0.6);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 12px; color: #ccc;
            `;

            const addItem = (text: string, enabled: boolean, action: () => void) => {
                const item = document.createElement('div');
                item.textContent = text;
                item.style.cssText = `
                    padding: 6px 12px; cursor: ${enabled ? 'pointer' : 'default'};
                    color: ${enabled ? '#ccc' : '#555'};
                `;
                if (enabled) {
                    item.addEventListener('mouseenter', () => {
                        item.style.background = '#3a3a45';
                    });
                    item.addEventListener('mouseleave', () => {
                        item.style.background = '';
                    });
                    item.addEventListener('click', () => {
                        hideContextMenu();
                        action();
                    });
                }
                menu.appendChild(item);
                return item;
            };

            // "添加关键帧" — always enabled
            addItem('添加关键帧', true, () => {
                events.fire('track.setActive', trackId);
                events.fire('track.activeId', trackId);
                events.fire('track.addKeyTo', trackId, frame);
            });

            // "删除关键帧" — only enabled if a key exists at this frame
            addItem('删除关键帧', hasKeyAtFrame, () => {
                events.fire('track.setActive', trackId);
                events.fire('track.removeKey', frame);
            });

            document.body.appendChild(menu);
            contextMenu = menu;

            // Close menu on click elsewhere
            const closeHandler = () => {
                hideContextMenu(); document.removeEventListener('click', closeHandler, true);
            };
            setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
        });

        // ---- Event subscriptions ----
        events.on('timeline.frames', () => requestRebuild());
        events.on('timeline.frame', (frame: number) => {
            const tw = getTotalWidth();
            if (tw > 0) updateCursor(frame, tw);
        });
        events.on('track.keyAdded', () => {
            rebuildLanes(); requestRebuild();
        });
        events.on('track.keyRemoved', () => {
            rebuildLanes(); requestRebuild();
        });
        events.on('track.keyMoved', () => {
            rebuildLanes(); requestRebuild();
        });
        events.on('track.keyUpdated', () => {
            rebuildLanes(); requestRebuild();
        });
        events.on('track.keysLoaded', () => {
            rebuildLanes(); requestRebuild();
        });
        events.on('track.keysCleared', () => {
            rebuildLanes(); requestRebuild();
        });
        events.on('track.activeChanged', () => rebuildLanes());
        events.on('effects.changed', () => {
            rebuildLanes(); requestRebuild();
        });
        events.on('audio.changed', () => {
            rebuildLanes(); requestRebuild();
        });
        events.on('audio.recordingChanged', () => rebuildLanes());

        // Resize observer — detect real width changes on both areas
        let lastObservedWidth = 0;
        new ResizeObserver(() => {
            const w = getTotalWidth();
            if (w > 0 && w !== lastObservedWidth) {
                lastObservedWidth = w;
                requestRebuild();
            }
        }).observe(ticksArea);
        new ResizeObserver(() => {
            const tlw = getTimelineWidth();
            if (tlw > 0 && tlw !== lastObservedWidth) {
                lastObservedWidth = tlw;
                requestRebuild();
            }
        }).observe(timelinesCol);

        // ---- Button handlers ----
        prev.on('click', (evt: MouseEvent) => {
            if (evt.shiftKey) {
                events.fire('timeline.prevKey');
            } else {
                events.fire('timeline.prevFrame');
            }
        });

        next.on('click', (evt: MouseEvent) => {
            if (evt.shiftKey) {
                events.fire('timeline.nextKey');
            } else {
                events.fire('timeline.nextFrame');
            }
        });

        play.on('click', () => {
            if (events.invoke('timeline.playing')) {
                events.fire('timeline.setPlaying', false);
            } else {
                events.fire('timeline.setPlaying', true);
            }
        });

        events.on('timeline.playing', (isPlaying: boolean) => {
            play.text = isPlaying ? '\uE135' : '\uE131';
        });

        // ---- Track active ID tracking ----
        let currentActiveTrackId = 'camera';
        events.function('track.activeId', () => currentActiveTrackId);
        events.on('track.activeId', (id: string) => {
            currentActiveTrackId = id;
        });
        events.on('track.activeChanged', (id: string) => {
            currentActiveTrackId = id;
        });

        // ---- Assemble ----
        this.append(controlsWrap);
        this.append(lanesContainer);

        // Initial build (requestAnimationFrame is more reliable than setTimeout)
        requestAnimationFrame(() => requestRebuild());

        // ---- Tooltips ----
        const shortcutManager: ShortcutManager = events.invoke('shortcutManager');
        const tooltip = (localeKey: string, shortcutId?: string) => () => {
            const text = i18n.t(localeKey);
            if (shortcutId) {
                const shortcut = shortcutManager.formatShortcut(shortcutId);
                if (shortcut) return i18n.formatTooltipWithShortcut(text, shortcut);
            }
            return text;
        };

        tooltips.register(prev, tooltip('tooltip.timeline.prev-frame', 'timeline.prevFrame'), 'top');
        tooltips.register(play, tooltip('tooltip.timeline.play', 'timeline.togglePlay'), 'top');
        tooltips.register(next, tooltip('tooltip.timeline.next-frame', 'timeline.nextFrame'), 'top');
        tooltips.register(speed, () => i18n.t('tooltip.timeline.frame-rate'), 'top');
        tooltips.register(frames, () => i18n.t('tooltip.timeline.total-frames'), 'top');
        tooltips.register(smoothness, () => i18n.t('tooltip.timeline.smoothness'), 'top');
        tooltips.register(loop, () => i18n.t('tooltip.timeline.loop'), 'top');
    }
}

export { TimelinePanel };
