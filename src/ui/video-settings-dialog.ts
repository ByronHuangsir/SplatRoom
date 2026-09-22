import { BooleanInput, Button, Container, Element, Label, SelectInput, VectorInput } from '@playcanvas/pcui';

import { supportedCodecsAt } from './export-codec-support';
import { enableReliableInputDrag, hidePcuiSliderStrip } from './input-drag';
import { i18n } from './localization';
import { VideoSettings } from '../app/render';
import { Events } from '../core/events';
import {
    bitrateFor,
    clampExportSize,
    presetById,
    presetOptionsFor,
    type ExportProjection
} from '../core/export-resolution';
import sceneExport from './svg/export.svg';

const createSvg = (svgString: string, args = {}) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new Element({
        dom: new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement,
        ...args
    });
};

class VideoSettingsDialog extends Container {
    show: () => Promise<VideoSettings | null>;
    hide: () => void;
    destroy: () => void;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'video-settings-dialog',
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
        i18n.bindText(headerText, () => i18n.t('popup.render-video.header').toUpperCase());
        const header = new Container({ id: 'header' });
        header.append(headerIcon);
        header.append(headerText);

        // projection

        const projectionLabel = new Label({ class: 'label' });
        i18n.bindText(projectionLabel, 'popup.render-video.projection');
        const projectionSelect = new SelectInput({
            class: 'select',
            defaultValue: 'standard',
            options: [
                { v: 'standard', t: 'Standard' },
                { v: 'equirect', t: '360° Equirectangular' }
            ]
        });
        i18n.bindOptions(projectionSelect, () => [
            { v: 'standard', t: i18n.t('popup.render-video.projection.standard') },
            { v: 'equirect', t: i18n.t('popup.render-video.projection.equirectangular') }
        ]);
        const projectionRow = new Container({ class: 'row' });
        projectionRow.append(projectionLabel);
        projectionRow.append(projectionSelect);

        // resolution
        //
        // 预设与上限来自 `src/core/export-resolution.ts`（图像/视频/旋转台三条路径共用一份）：
        // 8K（7680×4320）与 360-8K（8192×4096）都在表里，且**设备放不下的档位直接不出现在下拉里**
        // （`maxTextureSize` 小于该尺寸时过滤掉，避免选完才在渲染目标/编码器上炸）。
        const maxTextureSize = (() => {
            try {
                return (events.invoke('scene') as any)?.graphicsDevice?.maxTextureSize ?? 16384;
            } catch {
                return 16384;
            }
        })();

        const optionsFor = (projection: ExportProjection) => {
            return presetOptionsFor(projection, maxTextureSize).map(p => ({ v: p.v, t: p.t }));
        };

        const standardResolutions = optionsFor('standard');

        // 360 output is 2:1 equirectangular; 8K 那档是 8192×4096
        const equirectResolutions = optionsFor('equirect');

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
                { v: 'mkv', t: 'MKV' }
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

        // 分辨率策略的状态与说明行（见下面 applyResolutionPolicy）
        let policyToken = 0;
        // 策略自己改 `formatSelect` 时不要再触发一轮（否则说明行会被下一轮清掉）
        let applyingPolicy = false;
        const is360 = () => projectionSelect.value === 'equirect';
        const codecHint = new Label({ class: 'label' });
        const codecHintRow = new Container({ class: 'row', hidden: true });
        codecHintRow.append(codecHint);

        // Codec compatibility mapping
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

        // Update codec options when format changes
        //
        // 分辨率策略（第十八轮）：**8K 只能 VP9/AV1** —— 实测（`docs/probes/export-8k.cjs`）用应用
        // 真实的 codec 字符串问 WebCodecs：H.264（avc1.640033）在 7680×4320 被拒、H.265 本机没有
        // 编码器，VP9/AV1 到 8192×4096 都能真编出帧。所以选了 8K 必须把 mp4/h264 换成能用的组合，
        // 否则用户拿到的是"点了导出就报错"。换的时候给一行说明（`...resolution-note`）。
        const applyResolutionPolicy = async () => {
            const token = ++policyToken;
            const preset = presetById(resolutionSelect.value) ?? presetById(is360() ? '360-4k' : '1080');
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
            let allowed = await allowedFor(format);
            let switchedFormat = false;
            if (!allowed.length) {
                // 这个容器在本尺寸下没有可用编码器（典型：8K 的 mp4/mov + H.264/H.265）
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
                return;   // 又有人改了设置：这次结果作废
            }
            if (switchedFormat) {
                // 举旗：这一轮 `formatSelect` 的 change 处理不要再重置编码器/藏说明行
                applyingPolicy = true;
                formatSelect.value = format;
                applyingPolicy = false;
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

        formatSelect.on('change', () => {
            if (applyingPolicy) {
                return;   // 这一轮是策略自己改的：编码器与说明行由策略继续设置
            }
            const format = formatSelect.value;
            codecSelect.options = codecOptions[format] || codecOptions.mp4;

            // Set default codec based on format
            if (format === 'webm') {
                codecSelect.value = 'vp9';
            } else {
                codecSelect.value = 'h264';
            }

            // 上面只是"默认值"，接着按当前分辨率再筛一遍（8K 会把 h264/h265 拿掉）
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

        // frame range

        const totalFrames = events.invoke('timeline.frames');
        const frameRangeLabel = new Label({ class: 'label' });
        i18n.bindText(frameRangeLabel, 'popup.render-video.frame-range');
        const frameRangeInput = new VectorInput({
            class: 'vector-input',
            dimensions: 2,
            min: 0,
            max: totalFrames - 1,
            precision: 0,
            value: [0, totalFrames - 1]
        });
        i18n.onChange(() => {
            frameRangeInput.placeholder = [i18n.t('popup.render-video.frame-range-first'), i18n.t('popup.render-video.frame-range-last')];
        }, frameRangeInput);
        const frameRangeRow = new Container({ class: 'row' });
        frameRangeRow.append(frameRangeLabel);
        frameRangeRow.append(frameRangeInput);

        // PCUI's pointer-lock slider strips are unreliable in Electron; drive
        // value dragging with the reliable pointer-capture drag instead.
        frameRangeInput.inputs.forEach((input) => {
            enableReliableInputDrag(input, () => { });
            hidePcuiSliderStrip(input);
        });

        // Validate frame range
        frameRangeInput.on('change', (value: number[]) => {
            if (value[0] > value[1]) {
                frameRangeInput.value = [value[1], value[0]];
            }
        });

        // portrait mode

        const portraitLabel = new Label({ class: 'label' });
        i18n.bindText(portraitLabel, 'popup.render-video.portrait');
        const portraitBoolean = new BooleanInput({ class: 'boolean', value: false });
        const portraitRow = new Container({ class: 'row' });
        portraitRow.append(portraitLabel);
        portraitRow.append(portraitBoolean);

        // level horizon (360 only)

        const levelHorizonLabel = new Label({ class: 'label' });
        i18n.bindText(levelHorizonLabel, 'popup.render-video.level-horizon');
        const levelHorizonBoolean = new BooleanInput({ class: 'boolean', value: true });
        const levelHorizonRow = new Container({ class: 'row' });
        levelHorizonRow.append(levelHorizonLabel);
        levelHorizonRow.append(levelHorizonBoolean);

        // transparent background

        const transparentBgLabel = new Label({ class: 'label' });
        i18n.bindText(transparentBgLabel, 'popup.render-video.transparent-background');
        const transparentBgBoolean = new BooleanInput({ class: 'boolean', value: false });
        const transparentBgRow = new Container({ class: 'row' });
        transparentBgRow.append(transparentBgLabel);
        transparentBgRow.append(transparentBgBoolean);

        // hide transparent background till we add support for webm
        // video container
        transparentBgRow.hidden = true;

        // show debug overlays

        const showDebugLabel = new Label({ class: 'label' });
        i18n.bindText(showDebugLabel, 'popup.render-video.show-debug-overlays');
        const showDebugBoolean = new BooleanInput({ class: 'boolean', value: false });
        const showDebugRow = new Container({ class: 'row' });
        showDebugRow.append(showDebugLabel);
        showDebugRow.append(showDebugBoolean);

        // sync the ui to the selected projection: 360 renders are 2:1
        // equirectangular without portrait mode or debug overlays
        const syncProjection = () => {
            const isEquirect = projectionSelect.value === 'equirect';
            resolutionSelect.options = isEquirect ? equirectResolutions : standardResolutions;
            resolutionSelect.value = isEquirect ? '360-4k' : '1080';
            portraitRow.hidden = isEquirect;
            showDebugRow.hidden = isEquirect;
            levelHorizonRow.hidden = !isEquirect;
            applyResolutionPolicy();
        };

        projectionSelect.on('change', syncProjection);
        resolutionSelect.on('change', () => {
            applyResolutionPolicy();
        });
        frameRateSelect.on('change', () => {
            applyResolutionPolicy();
        });
        bitrateSelect.on('change', () => {
            applyResolutionPolicy();
        });
        syncProjection();

        // content

        const content = new Container({ id: 'content' });
        content.append(projectionRow);
        content.append(resolutionRow);
        content.append(formatRow);
        content.append(codecRow);
        content.append(codecHintRow);
        content.append(frameRateRow);
        content.append(bitrateRow);
        content.append(frameRangeRow);
        content.append(portraitRow);
        content.append(levelHorizonRow);
        content.append(transparentBgRow);
        content.append(showDebugRow);

        // footer

        const footer = new Container({ id: 'footer' });

        const cancelButton = new Button({
            class: 'button'
        });
        i18n.bindText(cancelButton, 'panel.render.cancel');

        const okButton = new Button({
            class: 'button'
        });
        i18n.bindText(okButton, 'panel.render.ok');

        footer.append(cancelButton);
        footer.append(okButton);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);

        this.append(dialog);

        // handle key bindings for enter and escape

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

        // reset UI and configure for current state
        const reset = () => {
            const totalFrames = events.invoke('timeline.frames');
            frameRangeInput.max = totalFrames - 1;
            frameRangeInput.value = [0, totalFrames - 1];
        };

        // function implementations

        this.show = () => {
            reset();

            this.hidden = false;
            document.addEventListener('keydown', keydown);
            this.dom.focus();

            return new Promise<VideoSettings | null>((resolve) => {
                onCancel = () => {
                    resolve(null);
                };

                onOK = () => {

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

                    const is360 = projectionSelect.value === 'equirect';
                    const portrait = !is360 && portraitBoolean.value;
                    // 尺寸与码率都走共用模块：尺寸取预设表（含 8K），码率用 `bitrateFor()`
                    // —— 老实现里 `bbpfFactors` 没有 8K 这一档 ⇒ `bitrate = NaN` ⇒ 编码器直接失败。
                    const preset = presetById(resolutionSelect.value) ?? presetById(is360 ? '360-4k' : '1080')!;
                    const clamped = clampExportSize(
                        portrait ? preset.height : preset.width,
                        portrait ? preset.width : preset.height,
                        maxTextureSize
                    );
                    const width = clamped.width;
                    const height = clamped.height;
                    const frameRate = frameRates[frameRateSelect.value];
                    const bitrate = bitrateFor({
                        width, height, frameRate, quality: bitrateSelect.value, preset: preset.v
                    });

                    const frameRange = frameRangeInput.value as number[];

                    const videoSettings = {
                        startFrame: frameRange[0],
                        endFrame: frameRange[1],
                        frameRate,
                        width,
                        height,
                        bitrate,
                        transparentBg: transparentBgBoolean.value,
                        showDebug: !is360 && showDebugBoolean.value,
                        format: formatSelect.value as 'mp4' | 'webm' | 'mov' | 'mkv',
                        codec: codecSelect.value as 'h264' | 'h265' | 'vp9' | 'av1',
                        projection: (is360 ? 'equirect' : 'standard') as 'standard' | 'equirect',
                        levelHorizon: is360 && levelHorizonBoolean.value
                    };

                    resolve(videoSettings);
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

export { VideoSettingsDialog };
