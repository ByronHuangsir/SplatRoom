// gamepad-menu.ts — 底部居中浮动控制菜单（模式切换 + 状态栏 + 自动隐藏）。
// 移植自 3DGS-Gamepad v3，文案接入 i18n，并增加「沉浸模式」按钮（浏览子模式）。

import { Container } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';

const AUTO_HIDE_DELAY = 4000;

class GamepadMenu extends Container {
    private events: Events;
    private visible: boolean = true;
    private autoHideTimer: number | null = null;
    private lastActivity: number = 0;

    private gamepadBtn: HTMLButtonElement;
    private droneBtn: HTMLButtonElement;
    private browseBtn: HTMLButtonElement;
    private settingsBtn: HTMLButtonElement;
    private speedGearLabel: HTMLSpanElement;
    private heightLockLabel: HTMLSpanElement;
    private statusDot: HTMLSpanElement;
    private currentMode: 'gamepad' | 'drone' = 'gamepad';
    private currentSubMode: 'normal' | 'browse' = 'normal';

    constructor(events: Events, args = {}) {
        args = { ...args, id: 'gamepad-menu' };
        super(args);
        this.events = events;

        const menuDom = this.dom;

        const title = document.createElement('div');
        title.className = 'gamepad-menu-title';
        title.textContent = i18n.t('gamepad.menu.title');
        menuDom.appendChild(title);

        const modeContainer = document.createElement('div');
        modeContainer.className = 'gamepad-menu-modes';

        this.gamepadBtn = document.createElement('button');
        this.gamepadBtn.className = 'gamepad-menu-btn active';
        this.gamepadBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6 8c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2s2-.9 2-2v-4c0-1.1-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2s2-.9 2-2v-4c0-1.1-.9-2-2-2zm-6 1c-2.2 0-4 1.8-4 4h8c0-2.2-1.8-4-4-4zm0 2c1.1 0 2 .9 2 2h-4c0-1.1.9-2 2-2z"/></svg><span></span>';
        this.gamepadBtn.querySelector('span')!.textContent = i18n.t('gamepad.menu.fps');
        modeContainer.appendChild(this.gamepadBtn);

        this.droneBtn = document.createElement('button');
        this.droneBtn.className = 'gamepad-menu-btn';
        this.droneBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2L8 6h3v4H7L4 7v3l3 3-3 3v3l3-3h4v4l-3 4h8l-3-4v-4h4l3 3v-3l-3-3 3-3V7l-3 3h-4V6h3l-4-4z"/></svg><span></span>';
        this.droneBtn.querySelector('span')!.textContent = i18n.t('gamepad.menu.drone');
        modeContainer.appendChild(this.droneBtn);

        this.browseBtn = document.createElement('button');
        this.browseBtn.className = 'gamepad-menu-btn';
        this.browseBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg><span></span>';
        this.browseBtn.querySelector('span')!.textContent = i18n.t('gamepad.menu.browse');
        modeContainer.appendChild(this.browseBtn);

        this.settingsBtn = document.createElement('button');
        this.settingsBtn.className = 'gamepad-menu-btn';
        this.settingsBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg><span></span>';
        this.settingsBtn.querySelector('span')!.textContent = i18n.t('gamepad.menu.settings');
        modeContainer.appendChild(this.settingsBtn);

        menuDom.appendChild(modeContainer);

        const statusBar = document.createElement('div');
        statusBar.className = 'gamepad-menu-status';

        const gearContainer = document.createElement('div');
        gearContainer.className = 'gamepad-menu-status-item';
        const gearLabel = document.createElement('span');
        gearLabel.className = 'gamepad-menu-status-label';
        gearLabel.textContent = i18n.t('gamepad.menu.speed');
        this.speedGearLabel = document.createElement('span');
        this.speedGearLabel.className = 'gamepad-menu-status-value';
        this.speedGearLabel.textContent = '3/6';
        gearContainer.appendChild(gearLabel);
        gearContainer.appendChild(this.speedGearLabel);
        statusBar.appendChild(gearContainer);

        const heightContainer = document.createElement('div');
        heightContainer.className = 'gamepad-menu-status-item';
        const heightLabel = document.createElement('span');
        heightLabel.className = 'gamepad-menu-status-label';
        heightLabel.textContent = i18n.t('gamepad.menu.height');
        this.heightLockLabel = document.createElement('span');
        this.heightLockLabel.className = 'gamepad-menu-status-value gamepad-menu-status-off';
        this.heightLockLabel.textContent = i18n.t('gamepad.settings.off');
        heightContainer.appendChild(heightLabel);
        heightContainer.appendChild(this.heightLockLabel);
        statusBar.appendChild(heightContainer);

        const connContainer = document.createElement('div');
        connContainer.className = 'gamepad-menu-status-item';
        const connLabel = document.createElement('span');
        connLabel.className = 'gamepad-menu-status-label';
        connLabel.textContent = i18n.t('gamepad.menu.gamepad');
        this.statusDot = document.createElement('span');
        this.statusDot.className = 'gamepad-menu-conn-dot gamepad-menu-conn-off';
        this.statusDot.textContent = '●';
        connContainer.appendChild(connLabel);
        connContainer.appendChild(this.statusDot);
        statusBar.appendChild(connContainer);

        menuDom.appendChild(statusBar);

        const hint = document.createElement('div');
        hint.className = 'gamepad-menu-hint';
        hint.textContent = i18n.t('gamepad.menu.hint');
        menuDom.appendChild(hint);

        // Event handlers
        this.gamepadBtn.addEventListener('click', (e) => {
            e.stopPropagation(); this.setMode('gamepad'); this.scheduleAutoHide();
        });
        this.droneBtn.addEventListener('click', (e) => {
            e.stopPropagation(); this.setMode('drone'); this.scheduleAutoHide();
        });
        this.browseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.events.fire('gamepad.setSubMode', this.currentSubMode === 'browse' ? 'normal' : 'browse');
            this.scheduleAutoHide();
        });
        this.settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation(); this.hideMenu(); this.events.fire('gamepad.settingsOpen');
        });
        this.dom.addEventListener('pointermove', () => {
            this.scheduleAutoHide();
        });
        this.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation(); this.scheduleAutoHide();
        });

        events.on('gamepad.menu.toggle', () => {
            this.toggle();
        });
        events.on('gamepad.settingsOpen', () => {
            this.hideMenu();
        });
        events.on('gamepad.setMode', (mode: 'gamepad' | 'drone') => {
            this.setMode(mode);
        });
        events.on('gamepad.speedGear', (gear: number) => {
            this.speedGearLabel.textContent = `${gear + 1}/6`;
        });
        events.on('gamepad.heightLock', (locked: boolean) => {
            if (locked) {
                this.heightLockLabel.textContent = i18n.t('gamepad.settings.on');
                this.heightLockLabel.classList.remove('gamepad-menu-status-off');
                this.heightLockLabel.classList.add('gamepad-menu-status-on');
            } else {
                this.heightLockLabel.textContent = i18n.t('gamepad.settings.off');
                this.heightLockLabel.classList.remove('gamepad-menu-status-on');
                this.heightLockLabel.classList.add('gamepad-menu-status-off');
            }
        });
        events.on('gamepad.subModeChanged', (mode: 'normal' | 'browse') => {
            this.currentSubMode = mode;
            this.browseBtn.classList.toggle('active', mode === 'browse');
        });
        events.on('gamepad.connected', (id: string) => {
            this.statusDot.className = 'gamepad-menu-conn-dot gamepad-menu-conn-on';
            this.statusDot.title = id;
        });
        events.on('gamepad.disconnected', () => {
            this.statusDot.className = 'gamepad-menu-conn-dot gamepad-menu-conn-off';
            this.statusDot.title = '';
        });

        this.scheduleAutoHide();
    }

    private setMode(mode: 'gamepad' | 'drone') {
        if (mode === this.currentMode) return;
        this.currentMode = mode;
        if (mode === 'gamepad') {
            this.gamepadBtn.classList.add('active');
            this.droneBtn.classList.remove('active');
        } else {
            this.gamepadBtn.classList.remove('active');
            this.droneBtn.classList.add('active');
        }
        this.events.fire('gamepad.setMode', mode);
        this.events.fire('gamepad.menuActivity');
    }

    private toggle() {
        if (this.visible) {
            this.hideMenu();
        } else {
            this.showMenu(); this.scheduleAutoHide();
        }
    }

    private showMenu() {
        this.visible = true;
        this.dom.classList.remove('gamepad-menu-hidden');
        this.dom.classList.add('gamepad-menu-visible');
        this.events.fire('gamepad.menuVisibility', true);
    }

    private hideMenu() {
        this.visible = false;
        this.dom.classList.add('gamepad-menu-hidden');
        this.dom.classList.remove('gamepad-menu-visible');
        this.events.fire('gamepad.menuVisibility', false);
    }

    private scheduleAutoHide() {
        this.lastActivity = Date.now();
        if (this.autoHideTimer !== null) {
            clearTimeout(this.autoHideTimer);
        }
        if (!this.visible) {
            this.showMenu();
        }
        this.autoHideTimer = window.setTimeout(() => {
            if (Date.now() - this.lastActivity >= AUTO_HIDE_DELAY - 100) {
                this.hideMenu();
            }
        }, AUTO_HIDE_DELAY);
    }
}

export { GamepadMenu };
