import { Button, Container, Label } from '@playcanvas/pcui';

import { i18n } from './localization';
import { Tooltips } from './tooltips';
import { Events } from '../core/events';
import { ShortcutManager } from '../core/shortcut-manager';
import { Splat } from '../splat/splat';

class StatusBar extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'status-bar'
        };

        super(args);

        // Track the currently active panel
        let activePanel = '';

        // Toggle buttons for panels
        const timelineButton = new Button({
            class: 'status-bar-toggle'
        });
        i18n.bindText(timelineButton, () => i18n.t('status-bar.timeline').toUpperCase());

        const splatDataButton = new Button({
            class: 'status-bar-toggle'
        });
        i18n.bindText(splatDataButton, () => i18n.t('status-bar.splat-data').toUpperCase());

        // Panel toggle logic
        const setActivePanel = (panel: string) => {
            activePanel = panel;
            timelineButton.dom.classList[panel === 'timeline' ? 'add' : 'remove']('active');
            splatDataButton.dom.classList[panel === 'splatData' ? 'add' : 'remove']('active');
            events.fire('statusBar.panelChanged', panel || null);
        };

        timelineButton.on('click', () => {
            setActivePanel(activePanel === 'timeline' ? '' : 'timeline');
        });

        splatDataButton.on('click', () => {
            setActivePanel(activePanel === 'splatData' ? '' : 'splatData');
        });

        // Right section: stats
        const statsContainer = new Container({
            class: 'status-bar-stats'
        });

        const createStat = (labelKey: string) => {
            const container = new Container({
                class: 'status-bar-stat'
            });
            const label = new Label({
                class: 'status-bar-stat-label'
            });
            i18n.bindText(label, labelKey);
            const value = new Label({
                class: 'status-bar-stat-value',
                text: '0'
            });
            container.append(label);
            container.append(value);
            statsContainer.append(container);
            return value;
        };

        const splatsValue = createStat('status-bar.splats');
        const selectedValue = createStat('status-bar.selected');
        const lockedValue = createStat('status-bar.locked');
        const deletedValue = createStat('status-bar.deleted');

        // WebGL2 后端提示：CPU 排序在相机运动时必然滞后（结构性，见
        // docs/旋转错序-结构性规避与SuperSplat对照-2026-09-22.md），WebGPU 才能同帧排序。
        // 由 main.ts 在设备创建后 fire 'backend.ready' 决定显隐 —— WebGPU 下整条不出现。
        const backendHint = new Label({
            class: 'status-bar-backend-hint',
            hidden: true
        });
        i18n.bindText(backendHint, 'status-bar.backend-hint');

        this.append(timelineButton);
        this.append(splatDataButton);
        this.append(backendHint);
        this.append(statsContainer);

        // register tooltips
        const shortcutManager: ShortcutManager = events.invoke('shortcutManager');
        const tooltip = (localeKey: string, shortcutId?: string) => () => {
            const text = i18n.t(localeKey);
            if (shortcutId) {
                const shortcut = shortcutManager.formatShortcut(shortcutId);
                if (shortcut) {
                    return i18n.formatTooltipWithShortcut(text, shortcut);
                }
            }
            return text;
        };

        tooltips.register(timelineButton, tooltip('tooltip.status-bar.timeline', 'timelinePanel.toggle'), 'top');
        tooltips.register(splatDataButton, tooltip('tooltip.status-bar.splat-data', 'dataPanel.toggle'), 'top');
        tooltips.register(backendHint, tooltip('tooltip.status-bar.backend-hint'), 'top');

        events.on('backend.ready', (backend: string) => {
            backendHint.hidden = backend !== 'webgl2';
        });

        // Handle keyboard shortcuts for panel toggles
        events.on('dataPanel.toggle', () => {
            setActivePanel(activePanel === 'splatData' ? '' : 'splatData');
        });

        events.on('timelinePanel.toggle', () => {
            setActivePanel(activePanel === 'timeline' ? '' : 'timeline');
        });

        // Update stats from splat state
        let splat: Splat;

        const updateStats = () => {
            if (!splat) return;
            const state = splat.splatData.getProp('state') as Uint8Array;
            if (state) {
                splatsValue.text = i18n.formatInteger(state.length - splat.numDeleted);
                selectedValue.text = i18n.formatInteger(splat.numSelected);
                lockedValue.text = i18n.formatInteger(splat.numLocked);
                deletedValue.text = i18n.formatInteger(splat.numDeleted);
            }
        };

        events.on('splat.stateChanged', (splat_: Splat) => {
            splat = splat_;
            updateStats();
        });

        events.on('selection.changed', (selection: Element) => {
            if (selection instanceof Splat) {
                splat = selection;
                updateStats();
            }
        });
    }
}

export { StatusBar };
