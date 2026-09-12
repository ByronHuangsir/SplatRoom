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
    { id: 'camera', label: '鐩告満', color: '#3498db' }
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

        // Cursor line 鈥?lives inside the timeline column
        const cursorLine = document.createElement('div');
        cursorLine.id = 'timeline-cursor-line';
        cursorLine.style.cssText = 'position:absolute;top:0;bottom:0;width:1px;background:#ff6600;pointer-events:none;z-index:10;';

        timelinesCol.appendChild(cursorLine);
        lanesBody.appendChild(headersCol);
        lanesBody.appendChild(timelinesCol);
        lanesDom.appendChild(ticksArea);
        lanesDom.appendChild(lanesBody);

        // ---- Audio tools bar (absolute right, inside timeline) 鈥?"+", "鈼?, "鈼⑩棧" ----
        const audioToolsBar = document.createElement('div');
        audioToolsBar.id = 'audio-tools-bar';
        lanesDom.appendChild(audioToolsBar);

        // ---- Audio data declarations (must come BEFORE rebuildLanes, which
        // reads them when drawing audio lanes inside the time-line column) ----
        type AudioTrackState = { name: string; url: string; fadeInOut: boolean; buffer: AudioBuffer | null } | null;
        const audioState: Record<string, AudioTrackState> = { vocal: null, music: null };
        const audioEl: Record<string, HTMLAudioElement | null> = { vocal: null, music: null };
        const audioGain: Record<string, GainNode | null> = { vocal: null, music: null };
        const audioConnected: Record<string, boolean> = { vocal: false, music: false };
        const AudioCtx: typeof AudioContext | undefined = (window.AudioContext || (window as any).webkitAudioContext);
        const audioCtx: AudioContext | null = AudioCtx ? new AudioCtx() : null;
        const AUDIO_TRACK_DEFS = [
            { id: 'vocal', label: '人声', color: '#e67e22' },
            { id: 'music', label: '背景音', color: '#9b59b6' }
        ];

        // ---- Waveform peaks (used by rebuildLanes) ----
        const drawWaveform = (canvas: HTMLCanvasElement, audioBuffer: AudioBuffer, color: string) => {
            const ctx2d = canvas.getContext('2d');
            if (!ctx2d) return;
            const w = canvas.width, h = canvas.height;
            ctx2d.clearRect(0, 0, w, h);
            const data = audioBuffer.getChannelData(0);
            const samplesPerPx = Math.max(1, Math.floor(data.length / w));
            const mid = h / 2;
            ctx2d.fillStyle = color;
            ctx2d.beginPath();
            ctx2d.moveTo(0, mid);
            for (let x = 0; x < w; x++) {
                let min = 1, max = -1;
                const start = x * samplesPerPx;
                const end = Math.min(data.length, start + samplesPerPx);
                for (let i = start; i < end; i++) {
                    const v = data[i];
                    if (v < min) min = v;
                    if (v > max) max = v;
                }
                ctx2d.lineTo(x, mid + max * mid);
                ctx2d.lineTo(x, mid + min * mid);
            }
            ctx2d.lineTo(w, mid);
            ctx2d.closePath();
            ctx2d.fill();
        };

        // ---- Load audio (file or recording blob) 鈥?async; rebuilds lanes after decode ----
        const loadAudioFile = async (trackId: string, blob: Blob, name: string) => {
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audio.crossOrigin = 'anonymous';
            audioState[trackId] = { name, url, fadeInOut: false, buffer: null };
            audioEl[trackId] = audio;
            if (audioCtx) {
                try {
                    const ab = await blob.arrayBuffer();
                    audioState[trackId]!.buffer = await audioCtx.decodeAudioData(ab.slice(0));
                } catch { /* decode failed 鈥?waveform stays empty */ }
            }
            rebuildLanes();
            redrawAudioTools();
        };

        // hidden file picker
        const audioFileInput = document.createElement('input');
        audioFileInput.type = 'file';
        audioFileInput.accept = 'audio/*';
        audioFileInput.style.display = 'none';
        let pendingTrackId: string | null = null;
        audioFileInput.addEventListener('change', () => {
            const file = audioFileInput.files?.[0];
            audioFileInput.value = '';
            if (!file || !pendingTrackId) return;
            loadAudioFile(pendingTrackId, file, file.name);
            pendingTrackId = null;
        });
        this.dom.appendChild(audioFileInput);

        // ---- Tool buttons (+  / 鈼?/ 鈼⑩棧) ----
        const redrawAudioTools = () => {
            audioToolsBar.innerHTML = '';
            for (const def of AUDIO_TRACK_DEFS) {
                const wrap = document.createElement('div');
                wrap.className = 'audio-tool-track';

                const lbl = document.createElement('span');
                lbl.textContent = def.label;
                lbl.style.color = def.color;
                wrap.appendChild(lbl);

                const addBtn = document.createElement('button');
                addBtn.className = 'audio-tool-btn';
                addBtn.textContent = '+';
                addBtn.title = `娣诲姞闊抽鍒?{def.label}`;
                addBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    pendingTrackId = def.id;
                    audioFileInput.click();
                });
                wrap.appendChild(addBtn);

                if (def.id === 'vocal') {
                    const recBtn = document.createElement('button');
                    recBtn.className = 'audio-tool-btn';
                    recBtn.textContent = '\u25CF';
                    recBtn.title = isRecording ? '鍋滄褰曢煶' : '褰曞埗闊抽';
                    if (isRecording) recBtn.style.background = '#e74c3c';
                    recBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleRecording(); });
                    wrap.appendChild(recBtn);
                }

                if (def.id === 'music') {
                    const fadeBtn = document.createElement('button');
                    fadeBtn.className = 'audio-tool-btn';
                    fadeBtn.textContent = '\u223C';
                    fadeBtn.title = '娣″叆娣″嚭';
                    if (audioState['music']?.fadeInOut) fadeBtn.style.background = '#27ae60';
                    fadeBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const st = audioState['music'];
                        if (!st) return;
                        st.fadeInOut = !st.fadeInOut;
                        applyFadeIfActive();
                        redrawAudioTools();
                    });
                    wrap.appendChild(fadeBtn);
                }

                audioToolsBar.appendChild(wrap);
            }
        };

        // ---- Fade in/out via WebAudio GainNode (linear ramp 2s in / 2s out) ----
        const ensureAudioGraph = (id: string) => {
            if (!audioCtx) return null;
            const el = audioEl[id];
            if (!el || audioConnected[id]) return audioGain[id] || null;
            try {
                const src = audioCtx.createMediaElementSource(el);
                const g = audioCtx.createGain();
                src.connect(g).connect(audioCtx.destination);
                audioGain[id] = g;
                audioConnected[id] = true;
                return g;
            } catch { return null; }
        };
        const applyFadeIfActive = () => {
            if (!audioCtx) return;
            const id = 'music';
            const st = audioState[id];
            if (!st) return;
            const g = ensureAudioGraph(id);
            if (!g) return;
            const now = audioCtx.currentTime;
            g.gain.cancelScheduledValues(now);
            if (st.fadeInOut && !audioEl[id]!.paused) {
                g.gain.setValueAtTime(0, now);
                g.gain.linearRampToValueAtTime(1, now + 2);
                const dur = audioEl[id]!.duration || 0;
                if (dur > 4) g.gain.linearRampToValueAtTime(0, now + dur - 2);
            } else if (!st.fadeInOut && !audioEl[id]!.paused) {
                g.gain.cancelScheduledValues(now);
                g.gain.setValueAtTime(1, now);
            } else if (st.fadeInOut && audioEl[id]!.paused) {
                g.gain.setValueAtTime(0, now);
            }
        };

        // ---- Recording (MediaRecorder) ----
        let mediaRecorder: MediaRecorder | null = null;
        let recChunks: Blob[] = [];
        let isRecording = false;
        const toggleRecording = async () => {
            if (isRecording) { mediaRecorder?.stop(); return; }
            if (!navigator.mediaDevices?.getUserMedia) { alert('褰撳墠娴忚鍣ㄤ笉鏀寔褰曢煶'); return; }
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream);
                recChunks = [];
                mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recChunks.push(e.data); };
                mediaRecorder.onstop = async () => {
                    const blob = new Blob(recChunks, { type: 'audio/webm' });
                    await loadAudioFile('vocal', blob, `褰曢煶 ${new Date().toLocaleTimeString()}`);
                    stream.getTracks().forEach((t) => t.stop());
                    isRecording = false;
                    redrawAudioTools();
                };
                mediaRecorder.start();
                isRecording = true;
                redrawAudioTools();
            } catch (e) {
                alert('鏃犳硶璁块棶楹﹀厠椋庯細' + (e instanceof Error ? e.message : String(e)));
            }
        };

        // ---- Playback sync (timeline 鈫?audio) ----
        events.on('timeline.setPlaying', (playing: boolean) => {
            for (const id of ['vocal', 'music']) {
                const a = audioEl[id];
                if (!a) continue;
                if (playing) {
                    const fps = (events.invoke('timeline.frameRate') as number) || 30;
                    a.currentTime = ((events.invoke('timeline.frame') as number) || 0) / fps;
                    a.play().catch(() => { /* autoplay blocked */ });
                    applyFadeIfActive();
                } else {
                    a.pause();
                    applyFadeIfActive();
                }
            }
        });
        events.on('timeline.frame', (frame: number) => {
            const fps = (events.invoke('timeline.frameRate') as number) || 30;
            const t = frame / fps;
            for (const id of ['vocal', 'music']) {
                const a = audioEl[id];
                if (!a) continue;
                if (Math.abs(a.currentTime - t) > 0.1) a.currentTime = t;
            }
        });

        // Expose for future audio mix into video exports
        events.function('timeline.audioTracks', () => audioState);
        redrawAudioTools();


        // ---- Build helpers ----
        let scrubTarget: HTMLElement | null = null;
        let lastRebuildWidth = 0;

        // Timeline column content width (subtract side padding so frame 0 鈫?start of usable area)
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
                leftArrow.title = hasPrev ? `璺宠浆鍒扮 ${prevKeyFrame} 甯 : '宸︿晶鏃犲叧閿抚';
                if (hasPrev) leftArrow.addEventListener('click', (e) => { e.stopPropagation(); events.fire('timeline.setFrame', prevKeyFrame); });
                header.appendChild(leftArrow);

                // Keyframe add/delete button
                const kfBtn = document.createElement('button');
                const kfBorderColor = hasKeyAtFrame ? '#27ae60' : '#555';
                const kfBg = hasKeyAtFrame ? '#27ae60' : 'transparent';
                const kfColor = hasKeyAtFrame ? '#fff' : '#888';
                kfBtn.style.cssText = 'width:20px;height:20px;padding:0;flex-shrink:0;border:1.5px solid ' + kfBorderColor + ';border-radius:3px;cursor:pointer;background:' + kfBg + ';color:' + kfColor + ';font-size:13px;font-weight:bold;line-height:18px;display:flex;align-items:center;justify-content:center;margin:0 6px;';
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
                rightArrow.title = hasNext ? `璺宠浆鍒扮 ${nextKeyFrame} 甯 : '鍙充晶鏃犲叧閿抚';
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

                // ---- Audio lanes (vocal / music) 鈥?name + waveform inside the time-line column ----
                for (const def of AUDIO_TRACK_DEFS) {
                    const ah = document.createElement('div');
                    ah.className = 'track-header audio-lane-header';
                    ah.style.cssText = `height:24px; flex-shrink:0; display:flex; align-items:center; padding: 0 4px; gap:4px; border-bottom: 1px solid #222; background: ${def.id === 'music' && audioState['music']?.fadeInOut ? '#1d3a23' : 'transparent'};`;
                    const aname = document.createElement('span');
                    aname.textContent = def.label;
                    aname.style.cssText = `font-size:10px; color:${def.color}; font-weight:600;`;
                    ah.appendChild(aname);
                    headersCol.appendChild(ah);

                    const at = document.createElement('div');
                    at.className = 'track-timeline audio-lane-timeline';
                    at.style.cssText = `position:relative; height:24px; flex-shrink:0; border-bottom:1px solid #1a1a1a; overflow:hidden;`;
                    const st = audioState[def.id];
                    if (st) {
                        const nameLbl = document.createElement('div');
                        nameLbl.style.cssText = `position:absolute; top:1px; left:4px; font-size:9px; color:#ffffff; z-index:2; pointer-events:none; text-shadow:0 0 3px #000;`;
                        nameLbl.textContent = st.name;
                        at.appendChild(nameLbl);
                        if (st.buffer) {
                            const canvas = document.createElement('canvas');
                            canvas.width = Math.max(1, Math.floor(tlw));
                            canvas.height = 24;
                            canvas.style.cssText = `position:absolute; top:0; left:0; width:100%; height:100%; opacity:0.85;`;
                            at.appendChild(canvas);
                            drawWaveform(canvas, st.buffer, def.color);
                        } else {
                            const ph = document.createElement('div');
                            ph.style.cssText = `position:absolute; top:50%; left:8px; transform:translateY(-50%); font-size:9px; color:#888;`;
                            ph.textContent = '瑙ｇ爜涓€?;
                            at.appendChild(ph);
                        }
                        if (def.id === 'music' && st.fadeInOut) {
                            const triL = document.createElement('div');
                            triL.style.cssText = `position:absolute; top:0; left:0; height:100%; width:28px; background:linear-gradient(to right, rgba(39,174,96,0.75), transparent); pointer-events:none;`;
                            const triR = document.createElement('div');
                            triR.style.cssText = `position:absolute; top:0; right:0; height:100%; width:28px; background:linear-gradient(to left, rgba(39,174,96,0.75), transparent); pointer-events:none;`;
                            at.appendChild(triL); at.appendChild(triR);
                        }
                    } else {
                        const ph = document.createElement('div');
                        ph.style.cssText = `position:absolute; top:50%; left:8px; transform:translateY(-50%); font-size:9px; color:#555;`;
                        ph.textContent = '鏈坊鍔犻煶棰?;
                        at.appendChild(ph);
                    }
                    timelinesCol.appendChild(at);
                }
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

            // "娣诲姞鍏抽敭甯? 鈥?always enabled
            addItem('娣诲姞鍏抽敭甯?, true, () => {
                events.fire('track.setActive', trackId);
                events.fire('track.activeId', trackId);
                events.fire('track.addKeyTo', trackId, frame);
            });

            // "鍒犻櫎鍏抽敭甯? 鈥?only enabled if a key exists at this frame
            addItem('鍒犻櫎鍏抽敭甯?, hasKeyAtFrame, () => {
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

        // Resize observer 鈥?detect real width changes on both areas
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

        // ---- Audio tracks (浜哄０ / 鑳屾櫙闊? ----
        // (audio block moved earlier 鈥?after audioToolsBar, before rebuildLanes)

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
