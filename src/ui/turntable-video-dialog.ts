import { Button, Container, Element, Label, SelectInput } from '@playcanvas/pcui';

import { supportedCodecsAt } from './export-codec-support';
import { i18n } from './localization';
import { Events } from '../core/events';
import { bitrateFor, clampExportSize, presetById, presetOptionsFor } from '../core/export-resolution';
import sceneExport from './svg/export.svg';

const createSvg = (svgString: string, args = {}) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new Element({
        dom: new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement,
        ...args
    });
};

export type TurntableVideoSettings = {
    frameRate: number;
    width: number;
    height: number;
    bitrate: number;
    format: 'mp4' | 'webm' | 'mov' | 'mkv' | 'png';
    codec: 'h264' | 'h265' | 'vp9' | 'av1';
    mode: 'orbit' | 'look';   // 环绕（绕焦点） / 环视（原地转头）
};

class TurntableVideoDialog extends Container {
    show: (mode: 'orbit' | 'look') => Promise<TurntableVideoSettings | null>;
    hide: () => void;
    destroy: () => void;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'turntable-video-dialog',
            class: 'settings-dialog',
            hidden: true,
            tabIndex: -1
        };

        super(args);

        const dialog = new Container({
            id: 'dialog'
        });

        // header
        const headerIcon = createSvg(sceneExport, { id: 'icon' });
        const headerText = new Label({ id: 'text' });
        i18n.bindText(headerText, () => i18n.t('popup.render-turntable.header').toUpperCase());
        const header = new Container({ id: 'header' });
        header.append(headerIcon);
        header.append(headerText);

        // resolution
        //
        // 预设与上限来自 `src/core/export-resolution.ts`（与图像/视频导出共用一份）：
        // 这一档原来是 4K 封顶，第十八轮抬到 **8K（7680×4320）**，并按设备 `maxTextureSize` 过滤。
        const maxTextureSize = (() => {
            try {
                return (events.invoke('scene') as any)?.graphicsDevice?.maxTextureSize ?? 16384;
            } catch {
                return 16384;
            }
        })();

        const standardResolutions = presetOptionsFor('standard', maxTextureSize).map(p => ({ v: p.v, t: p.t }));

        const resolutionLabel = new Label({ class: 'label' });
        i18n.bindText(resolutionLabel, 'popup.render-video.resolution');
        const resolutionSelect = new SelectInput({
            class: 'select',
            defaultValue: '1080',
            options: standardResolutions
        });
        const resolutionRow = new Container({ class: 'row' });
        resolutionRow.append(resolutionLabel);
        resolutionRow.append(resolutionSelect);

        // format
        const formatLabel = new Label({ class: 'label' });
        i18n.bindText(formatLabel, 'popup.render-video.format');
        const formatSelect = new SelectInput({
            class: 'select',
            defaultValue: 'mp4',
            options: [
                { v: 'mp4', t: 'MP4' },
                { v: 'webm', t: 'WebM' },
                { v: 'mov', t: 'MOV' },
                { v: 'mkv', t: 'MKV' },
                // 帧序列：逐帧 PNG（RGBA，带 alpha=透明背景）写到目录，
                // 交给外部 ffmpeg 合成透明 MOV（本机 Chromium 编不了带 alpha 的视频，
                // 见 docs/旋转台透明背景视频-探索结论-2026-09-22.md）
                { v: 'png', t: i18n.t('popup.render-video.format-png') }
            ]
        });
        const formatRow = new Container({ class: 'row' });
        formatRow.append(formatLabel);
        formatRow.append(formatSelect);

        // codec
        const codecLabel = new Label({ class: 'label' });
        i18n.bindText(codecLabel, 'popup.render-video.codec');
        const codecSelect = new SelectInput({
            class: 'select',
            defaultValue: 'h264',
            options: [
                { v: 'h264', t: 'H.264' },
                { v: 'h265', t: 'H.265/HEVC' }
            ]
        });
        const codecRow = new Container({ class: 'row' });
        codecRow.append(codecLabel);
        codecRow.append(codecSelect);

        // 分辨率策略的状态与说明行（见 applyResolutionPolicy）
        let policyToken = 0;
        // 策略自己改 `formatSelect` 时不要再触发一轮（否则说明行会被下一轮清掉）
        let applyingPolicy = false;
        const codecHint = new Label({ class: 'label' });
        const codecHintRow = new Container({ class: 'row', hidden: true });
        codecHintRow.append(codecHint);

        const codecOptions: Record<string, Array<{ v: string, t: string }>> = {
            'mp4': [
                { v: 'h264', t: 'H.264' },
                { v: 'h265', t: 'H.265/HEVC' }
            ],
            'webm': [
                { v: 'vp9', t: 'VP9' },
                { v: 'av1', t: 'AV1' }
            ],
            'mov': [
                { v: 'h264', t: 'H.264' },
                { v: 'h265', t: 'H.265/HEVC' }
            ],
            'mkv': [
                { v: 'h264', t: 'H.264' },
                { v: 'h265', t: 'H.265/HEVC' },
                { v: 'vp9', t: 'VP9' },
                { v: 'av1', t: 'AV1' }
            ]
        };

        // 8K 只能 VP9/AV1（实测：H.264 在 7680×4320 被 WebCodecs 拒、H.265 本机没有编码器）。
        // 选了 8K 就自动把 mp4/h264 换成能用的容器+编码器，并给一行说明。
        const applyResolutionPolicy = async () => {
            const token = ++policyToken;
            const preset = presetById(resolutionSelect.value) ?? presetById('1080');
            if (!preset) {
                return;
            }
            const frameRate = Number(frameRateSelect.value) || 30;
            const bitrate = bitrateFor({
                width: preset.width,
                height: preset.height,
                frameRate,
                quality: bitrateSelect.value,
                preset: preset.v
            });
            const allowedFor = (format: string) => supportedCodecsAt(
                (codecOptions[format] ?? codecOptions.mp4).map(o => o.v),
                preset.width, preset.height, bitrate, frameRate
            );

            let format = formatSelect.value;
            if (format === 'png') {
                // 帧序列没有编码器概念，不需要策略（也就不用问 WebCodecs）
                codecHint.text = '';
                codecHintRow.hidden = true;
                return;
            }

            let allowed = await allowedFor(format);
            let switchedFormat = false;
            if (!allowed.length) {
                for (const candidate of ['webm', 'mkv', 'mp4', 'mov']) {
                    if (candidate === format) {
                        continue;
                    }

                    const list = await allowedFor(candidate);
                    if (list.length) {
                        format = candidate;
                        allowed = list;
                        switchedFormat = true;
                        break;
                    }
                }
            }
            if (token !== policyToken) {
                return;
            }
            if (switchedFormat) {
                // 举旗：这一轮 `formatSelect` 的 change 处理不要再重置编码器/藏说明行
                applyingPolicy = true;
                formatSelect.value = format;
                applyingPolicy = false;
                const isSequence = format === 'png';
                codecRow.hidden = isSequence;
                bitrateRow.hidden = isSequence;
            }
            codecSelect.options = (codecOptions[format] ?? codecOptions.mp4).filter(o => allowed.includes(o.v));
            if (!allowed.includes(codecSelect.value)) {
                codecSelect.value = allowed[0];
            }
            const note = switchedFormat ?
                i18n.t('popup.render-video.resolution-note', {
                    size: preset.t,
                    codec: String(codecSelect.value).toUpperCase(),
                    format: format.toUpperCase()
                }) :
                '';
            codecHint.text = note;
            codecHintRow.hidden = !note;
        };

        resolutionSelect.on('change', () => {
            applyResolutionPolicy();
        });

        formatSelect.on('change', () => {
            if (applyingPolicy) {
                return;   // 这一轮是策略自己改的：编码器与说明行由策略继续设置
            }
            const format = formatSelect.value;
            const options = codecOptions[format] || codecOptions.mp4;
            codecSelect.options = options;

            if (format === 'webm') {
                codecSelect.value = 'vp9';
            } else {
                codecSelect.value = 'h264';
            }

            // 帧序列没有编码器/码率概念：把这两行藏起来，避免误导
            const isSequence = format === 'png';
            codecRow.hidden = isSequence;
            bitrateRow.hidden = isSequence;
            codecHintRow.hidden = true;

            // 默认值之后按当前分辨率再筛一遍（8K 会把 h264/h265 拿掉）
            applyResolutionPolicy();
        });

        // framerate
        const frameRateLabel = new Label({ class: 'label' });
        i18n.bindText(frameRateLabel, 'popup.render-video.frame-rate');
        const frameRateSelect = new SelectInput({
            class: 'select',
            defaultValue: '30',
            options: [
                { v: '12', t: '12 fps' },
                { v: '15', t: '15 fps' },
                { v: '24', t: '24 fps' },
                { v: '25', t: '25 fps' },
                { v: '30', t: '30 fps' },
                { v: '48', t: '48 fps' },
                { v: '60', t: '60 fps' },
                { v: '120', t: '120 fps' }
            ]
        });
        const frameRateRow = new Container({ class: 'row' });
        frameRateRow.append(frameRateLabel);
        frameRateRow.append(frameRateSelect);

        // bitrate
        const bitrateLabel = new Label({ class: 'label' });
        i18n.bindText(bitrateLabel, 'popup.render-video.bitrate');
        const bitrateSelect = new SelectInput({
            class: 'select',
            defaultValue: 'high',
            options: [
                { v: 'low', t: 'Low' },
                { v: 'medium', t: 'Medium' },
                { v: 'high', t: 'High' },
                { v: 'ultra', t: 'Ultra' }
            ]
        });
        const bitrateRow = new Container({ class: 'row' });
        bitrateRow.append(bitrateLabel);
        bitrateRow.append(bitrateSelect);

        // 帧率 / 码率变了也要重算编码器可用性（`isConfigSupported` 的结果与 fps 有关）
        frameRateSelect.on('change', () => {
            applyResolutionPolicy();
        });
        bitrateSelect.on('change', () => {
            applyResolutionPolicy();
        });

        // rotate speed — read-only display
        const rotateSpeedLabel = new Label({ class: 'label' });
        i18n.bindText(rotateSpeedLabel, 'popup.render-turntable.rotate-speed');
        const rotateSpeedValue = new Label({ class: 'label-value' });
        rotateSpeedValue.text = '15°/s';
        const rotateSpeedRow = new Container({ class: 'row' });
        rotateSpeedRow.append(rotateSpeedLabel);
        rotateSpeedRow.append(rotateSpeedValue);

        // computed duration
        const durationLabel = new Label({ class: 'label' });
        i18n.bindText(durationLabel, 'popup.render-turntable.duration');
        const durationValue = new Label({ class: 'label-value' });
        durationValue.text = '24s';
        const durationRow = new Container({ class: 'row' });
        durationRow.append(durationLabel);
        durationRow.append(durationValue);

        // computed total frames
        const totalFramesLabel = new Label({ class: 'label' });
        i18n.bindText(totalFramesLabel, 'popup.render-turntable.frames');
        const totalFramesValue = new Label({ class: 'label-value' });
        totalFramesValue.text = '720';
        const totalFramesRow = new Container({ class: 'row' });
        totalFramesRow.append(totalFramesLabel);
        totalFramesRow.append(totalFramesValue);

        // 短板警示行（特效/音频结束时间 < 导出时长时显示）
        const warnLabel = new Label({ class: 'label-value' });
        warnLabel.hidden = true;
        warnLabel.style.cssText = 'color:#e67e22;font-size:10px;white-space:normal;line-height:1.4;margin-top:4px;';
        const warnRow = new Container({ class: 'row' });
        warnRow.append(warnLabel);

        // helper to update computed values
        const updateComputedValues = () => {
            const speed = events.invoke('camera.getAutoRotateSpeed') as number || 15;
            const fps = parseInt(frameRateSelect.value, 10);
            const durationSec = 360 / speed;
            const totalFrames = Math.round(durationSec * fps);

            rotateSpeedValue.text = `${speed.toFixed(0)}°/s`;
            durationValue.text = `${durationSec.toFixed(1)}s`;
            totalFramesValue.text = totalFrames.toString();

            // 短板检测：散场特效结束 / 音频最长结束 vs 导出时长。
            // 特效散场锚定在时间线最后一帧（end = frames-1），当用户把时间线
            // 帧数设为导出帧数时 end/fps = durationSec - 1/fps，仍差一帧；
            // 因此容差用一帧（1/fps）而不是固定 0.01s —— 结束时间覆盖到
            // 导出时长（含最后一帧）时视为满足，只有确实不足一帧以上才提示。
            const safeGetFx = () => {
                try {
                    return (events.invoke('effects.getState') as any)?.outro ?? null;
                } catch {
                    return null;
                }
            };
            const safeGetClips = () => {
                try {
                    return (events.invoke('audio.clips') as any[]) ?? [];
                } catch {
                    return [];
                }
            };

            const outro = safeGetFx();
            const clips = safeGetClips();
            const parts: string[] = [];
            const oneFrameSec = 1 / fps;

            const fxShort = !!(outro?.enabled && outro.end > 0 && outro.end / fps < durationSec - oneFrameSec);
            if (fxShort) {
                parts.push(`散场特效在 ${(outro.end / fps).toFixed(1)}s 结束`);
            }

            let audioEndSec = 0;
            for (const c of clips) {
                const end = (c.startFrame + (c.trimEnd - c.trimStart) * fps) / fps;
                if (end > audioEndSec) audioEndSec = end;
            }
            const audioShort = clips.length > 0 && audioEndSec < durationSec - oneFrameSec;
            if (audioShort) {
                parts.push(`音频在 ${audioEndSec.toFixed(1)}s 结束`);
            }

            // 任意一个短于导出时长就提示（特效或音频任一短于视频时长）
            if (fxShort || audioShort) {
                warnLabel.hidden = false;
                const why = parts.length > 0 ? `${parts.join('，')}，` : '';
                warnLabel.text = `⚠ ${why}短于导出时长 ${durationSec.toFixed(1)}s。` +
                    `建议将时间线帧数设为 ${totalFrames}（${durationSec.toFixed(1)}s × ${fps}fps）以便特效/音频覆盖整段视频。`;
            } else {
                warnLabel.hidden = true;
            }
        };

        // Update computed values when frame rate changes or on show
        frameRateSelect.on('change', updateComputedValues);

        // content
        const content = new Container({ id: 'content' });
        content.append(resolutionRow);
        content.append(formatRow);
        content.append(codecRow);
        content.append(codecHintRow);
        content.append(frameRateRow);
        content.append(bitrateRow);
        content.append(rotateSpeedRow);
        content.append(durationRow);
        content.append(totalFramesRow);
        content.append(warnRow);

        // footer
        const cancelButton = new Button({
            class: 'button'
        });
        i18n.bindText(cancelButton, 'popup.cancel');

        const okButton = new Button({
            class: 'button'
        });
        i18n.bindText(okButton, 'panel.render.ok');

        const footer = new Container({ id: 'footer' });
        footer.append(cancelButton);
        footer.append(okButton);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);

        this.append(dialog);

        let onCancel: () => void;
        let onOK: () => void;

        cancelButton.on('click', () => onCancel());
        okButton.on('click', () => onOK());

        const keydown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
            }
        };

        this.show = (mode: 'orbit' | 'look') => {
            updateComputedValues();
            // 打开时按当前分辨率筛一遍编码器（8K 会把 h264/h265 换掉）
            applyResolutionPolicy();

            this.hidden = false;
            document.addEventListener('keydown', keydown);
            this.dom.focus();

            return new Promise<TurntableVideoSettings | null>((resolve) => {
                onCancel = () => {
                    resolve(null);
                };

                onOK = async () => {
                    // 短板检查：散场特效与音频都短于导出时长时，
                    // 提示用户并询问是否自动把时间线帧数设为导出所需帧数
                    const speed = events.invoke('camera.getAutoRotateSpeed') as number || 15;
                    const fps = parseInt(frameRateSelect.value, 10);
                    const durationSec = 360 / speed;
                    const exportFrames = Math.round(durationSec * fps);

                    const fxOutro = (() => {
                        try {
                            return (events.invoke('effects.getState') as any)?.outro ?? null;
                        } catch {
                            return null;
                        }
                    })();
                    const audioClips = (() => {
                        try {
                            return (events.invoke('audio.clips') as any[]) ?? [];
                        } catch {
                            return [];
                        }
                    })();

                    const fxShort = !!(fxOutro?.enabled && fxOutro.end > 0 && fxOutro.end / fps < durationSec - 1 / fps);
                    let audioEndSec = 0;
                    for (const c of audioClips) {
                        const end = (c.startFrame + (c.trimEnd - c.trimStart) * fps) / fps;
                        if (end > audioEndSec) audioEndSec = end;
                    }
                    const audioShort = audioClips.length > 0 && audioEndSec < durationSec - 1 / fps;

                    // 任意一个短于导出时长即提示
                    if (fxShort || audioShort) {
                        const shortParts: string[] = [];
                        if (fxShort) shortParts.push(`散场特效在 ${(fxOutro.end / fps).toFixed(1)}s 结束`);
                        if (audioShort) shortParts.push(`音频在 ${audioEndSec.toFixed(1)}s 结束`);

                        const result = await events.invoke('showPopup', {
                            type: 'info',
                            header: '旋转台视频时长超出特效/音频',
                            message: `导出时长 ${durationSec.toFixed(1)}s（${exportFrames} 帧），但${shortParts.join('，')}，` +
                                '后面一段既无特效也无声音。\n\n请选择操作：',
                            buttons: [
                                { label: '设置帧数', action: 'set' },
                                { label: '继续导出', action: 'export' },
                                { label: '取消', action: 'cancel' }
                            ]
                        });
                        const action = (result as any)?.action;
                        if (action === 'cancel') return; // 中止导出
                        if (action === 'set') {
                            // 设置时间线帧数 = 导出所需帧数（特效/音频锚定首尾，
                            // 延长帧数后其结束时间随之拉长，覆盖整段导出视频）。
                            // 设置后【中止本次导出】，关闭对话框回到时间线面板，
                            // 让用户调整音乐长度和特效位置，完成后再自行重新导出。
                            events.fire('timeline.setFrames', exportFrames);
                            resolve(null);
                            return;
                        }
                        // action === 'export'：无视警告，继续导出
                    }

                    const frameRates: Record<string, number> = {
                        '12': 12,
                        '15': 15,
                        '24': 24,
                        '25': 25,
                        '30': 30,
                        '48': 48,
                        '60': 60,
                        '120': 120
                    };

                    // 尺寸取共用预设表（含 8K），码率用 `bitrateFor()`（老实现的 8K 档
                    // 因为 `bbpfFactors` 缺项会算出 NaN ⇒ 编码器直接失败），并夹到设备上限。
                    const preset = presetById(resolutionSelect.value) ?? presetById('1080')!;
                    const clamped = clampExportSize(preset.width, preset.height, maxTextureSize);
                    const width = clamped.width;
                    const height = clamped.height;
                    const frameRate = frameRates[frameRateSelect.value];
                    const bitrate = bitrateFor({
                        width, height, frameRate, quality: bitrateSelect.value, preset: preset.v
                    });

                    const settings: TurntableVideoSettings = {
                        frameRate,
                        width,
                        height,
                        bitrate,
                        format: formatSelect.value as 'mp4' | 'webm' | 'mov' | 'mkv' | 'png',
                        codec: codecSelect.value as 'h264' | 'h265' | 'vp9' | 'av1',
                        mode
                    };

                    resolve(settings);
                };
            }).finally(() => {
                document.removeEventListener('keydown', keydown);
                this.hide();
            });
        };

        this.hide = () => {
            this.hidden = true;
        };

        this.destroy = () => {
            this.hide();
            super.destroy();
        };
    }
}

export { TurntableVideoDialog };
