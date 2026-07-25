import { Button, Container, Element, NumericInput, SelectInput, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { ShortcutManager } from '../shortcut-manager';
import { i18n } from './localization';
import { Tooltips } from './tooltips';

/** Track metadata for lane display */
interface TrackLaneDef {
    id: string;
    label: string;
    color: string;
}

const TRACK_LANES: TrackLaneDef[] = [
    { id: 'camera', label: '相机', color: '#3498db' }
];

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
        let scrubTarget: HTMLElement | null = null;
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
                header.addEventListener('mouseenter', () => { header.style.background = '#2a2a35'; });
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
                if (hasPrev) leftArrow.addEventListener('click', (e) => { e.stopPropagation(); events.fire('timeline.setFrame', prevKeyFrame); });
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
                if (hasNext) rightArrow.addEventListener('click', (e) => { e.stopPropagation(); events.fire('timeline.setFrame', nextKeyFrame); });
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
                keyEntries.forEach(kf => {
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
        };

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
                    item.addEventListener('mouseenter', () => { item.style.background = '#3a3a45'; });
                    item.addEventListener('mouseleave', () => { item.style.background = ''; });
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
            const closeHandler = () => { hideContextMenu(); document.removeEventListener('click', closeHandler, true); };
            setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
        });

        // ---- Event subscriptions ----
        events.on('timeline.frames', () => requestRebuild());
        events.on('timeline.frame', (frame: number) => {
            const tw = getTotalWidth();
            if (tw > 0) updateCursor(frame, tw);
        });
        events.on('track.keyAdded', () => { rebuildLanes(); requestRebuild(); });
        events.on('track.keyRemoved', () => { rebuildLanes(); requestRebuild(); });
        events.on('track.keyMoved', () => { rebuildLanes(); requestRebuild(); });
        events.on('track.keyUpdated', () => { rebuildLanes(); requestRebuild(); });
        events.on('track.keysLoaded', () => { rebuildLanes(); requestRebuild(); });
        events.on('track.keysCleared', () => { rebuildLanes(); requestRebuild(); });
        events.on('track.activeChanged', () => rebuildLanes());

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
        events.on('track.activeId', (id: string) => { currentActiveTrackId = id; });
        events.on('track.activeChanged', (id: string) => { currentActiveTrackId = id; });

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
