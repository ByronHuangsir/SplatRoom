import { Button, Container, Element, Label, SelectInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
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
    format: 'mp4' | 'webm' | 'mov' | 'mkv';
    codec: 'h264' | 'h265' | 'vp9' | 'av1';
};

class TurntableVideoDialog extends Container {
    show: () => Promise<TurntableVideoSettings | null>;
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
        const standardResolutions = [
            { v: '540', t: '960x540' },
            { v: '720', t: '1280x720' },
            { v: '1080', t: '1920x1080' },
            { v: '1440', t: '2560x1440' },
            { v: '4k', t: '3840x2160' }
        ];

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

        formatSelect.on('change', () => {
            const format = formatSelect.value;
            const options = codecOptions[format] || codecOptions.mp4;
            codecSelect.options = options;

            if (format === 'webm') {
                codecSelect.value = 'vp9';
            } else {
                codecSelect.value = 'h264';
            }
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

        // helper to update computed values
        const updateComputedValues = () => {
            const speed = events.invoke('camera.getAutoRotateSpeed') as number || 15;
            const fps = parseInt(frameRateSelect.value, 10);
            const durationSec = 360 / speed;
            const totalFrames = Math.round(durationSec * fps);

            rotateSpeedValue.text = speed.toFixed(0) + '°/s';
            durationValue.text = durationSec.toFixed(1) + 's';
            totalFramesValue.text = totalFrames.toString();
        };

        // Update computed values when frame rate changes or on show
        frameRateSelect.on('change', updateComputedValues);

        // content
        const content = new Container({ id: 'content' });
        content.append(resolutionRow);
        content.append(formatRow);
        content.append(codecRow);
        content.append(frameRateRow);
        content.append(bitrateRow);
        content.append(rotateSpeedRow);
        content.append(durationRow);
        content.append(totalFramesRow);

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

        this.show = () => {
            updateComputedValues();

            this.hidden = false;
            document.addEventListener('keydown', keydown);
            this.dom.focus();

            return new Promise<TurntableVideoSettings | null>((resolve) => {
                onCancel = () => {
                    resolve(null);
                };

                onOK = () => {
                    const widths: Record<string, number> = {
                        '540': 960,
                        '720': 1280,
                        '1080': 1920,
                        '1440': 2560,
                        '4k': 3840
                    };

                    const heights: Record<string, number> = {
                        '540': 540,
                        '720': 720,
                        '1080': 1080,
                        '1440': 1440,
                        '4k': 2160
                    };

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

                    const bppfs: Record<string, number> = {
                        'low': 0.001,
                        'medium': 0.01,
                        'high': 0.1,
                        'ultra': 1
                    };

                    const bbpfFactors: Record<string, number> = {
                        '540': 1,
                        '720': 1 / 2,
                        '1080': 1 / 3,
                        '1440': 1 / 4,
                        '4k': 1 / 5
                    };

                    const width = widths[resolutionSelect.value];
                    const height = heights[resolutionSelect.value];
                    const frameRate = frameRates[frameRateSelect.value];
                    const bppf = bppfs[bitrateSelect.value] * bbpfFactors[resolutionSelect.value];
                    const bitrate = Math.floor(10 * width * height * frameRate * bppf);

                    const settings: TurntableVideoSettings = {
                        frameRate,
                        width,
                        height,
                        bitrate,
                        format: formatSelect.value as 'mp4' | 'webm' | 'mov' | 'mkv',
                        codec: codecSelect.value as 'h264' | 'h265' | 'vp9' | 'av1'
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
