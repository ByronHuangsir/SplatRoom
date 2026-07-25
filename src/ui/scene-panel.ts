import { Button, Container, Element, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import { SplatList } from './splat-list';
import sceneImportSvg from './svg/import.svg';
import sceneNewSvg from './svg/new.svg';
import soloSvg from './svg/solo.svg';
import linkSvg from './svg/link.svg';
import mergeSvg from './svg/merge.svg';
import { Tooltips } from './tooltips';
import { CameraPanel } from './camera-panel';
import { FloaterPanel } from './floater-panel';
import { Transform } from './transform';
import { PreviewWindow } from './preview-window';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class ScenePanel extends Container {
    constructor(events: Events, tooltips: Tooltips, previewWindow: PreviewWindow, args = {}) {
        args = {
            ...args,
            id: 'scene-panel',
            class: 'panel'
        };

        super(args);

        // stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        const sceneHeader = new Container({
            class: 'panel-header'
        });

        const sceneIcon = new Label({
            text: '\uE344',
            class: 'panel-header-icon'
        });

        const sceneLabel = new Label({
            class: 'panel-header-label'
        });
        i18n.bindText(sceneLabel, 'panel.scene');

        let soloActive = false;

        const soloToggle = new Container({
            class: 'panel-header-button'
        });
        soloToggle.dom.appendChild(createSvg(soloSvg));

        soloToggle.on('click', () => {
            soloActive = !soloActive;
            if (soloActive) {
                soloToggle.class.add('active');
            } else {
                soloToggle.class.remove('active');
            }
            events.fire('scene.solo', soloActive);
        });

        // group/link toggle
        const groupToggle = new Container({
            class: 'panel-header-button'
        });
        groupToggle.dom.appendChild(createSvg(linkSvg));

        groupToggle.on('click', () => {
            events.fire('scene.group.toggle');
        });

        // update group button state based on selection or group changes
        const updateGroupToggle = () => {
            const hasSelection = events.invoke('selection.hasMultiple') as boolean;
            const hasGroup = events.invoke('group.hasActive') as boolean;
            if (hasGroup) {
                groupToggle.class.add('active');
            } else {
                groupToggle.class.remove('active');
            }
            groupToggle.dom.style.opacity = hasSelection || hasGroup ? '1' : '0.4';
        };

        events.on('selection.changedMulti', updateGroupToggle);
        events.on('group.created', updateGroupToggle);
        events.on('group.removed', updateGroupToggle);

        // merge selected models into a single new model
        const mergeToggle = new Container({
            class: 'panel-header-button'
        });
        mergeToggle.dom.appendChild(createSvg(mergeSvg));

        mergeToggle.on('click', () => {
            events.fire('scene.group.merge');
        });

        const updateMergeToggle = () => {
            const hasSelection = events.invoke('selection.hasMultiple') as boolean;
            mergeToggle.dom.style.opacity = hasSelection ? '1' : '0.4';
        };

        events.on('selection.changedMulti', updateMergeToggle);

        const sceneImport = new Container({
            class: 'panel-header-button'
        });
        sceneImport.dom.appendChild(createSvg(sceneImportSvg));

        const sceneNew = new Container({
            class: 'panel-header-button'
        });
        sceneNew.dom.appendChild(createSvg(sceneNewSvg));

        sceneHeader.append(sceneIcon);
        sceneHeader.append(sceneLabel);
        sceneHeader.append(soloToggle);
        sceneHeader.append(groupToggle);
        sceneHeader.append(mergeToggle);
        sceneHeader.append(sceneImport);
        sceneHeader.append(sceneNew);

        sceneImport.on('click', async () => {
            await events.invoke('scene.import');
        });

        sceneNew.on('click', () => {
            events.invoke('doc.new');
        });

        tooltips.register(soloToggle, () => i18n.t('tooltip.scene.solo'), 'top');
        tooltips.register(groupToggle, () => i18n.t('tooltip.scene.group'), 'top');
        tooltips.register(mergeToggle, () => i18n.t('tooltip.scene.merge'), 'top');
        tooltips.register(sceneImport, () => i18n.t('tooltip.scene.import'), 'top');
        tooltips.register(sceneNew, () => i18n.t('tooltip.scene.new'), 'top');

        const splatList = new SplatList(events);

        const splatListContainer = new Container({
            class: 'splat-list-container'
        });
        splatListContainer.append(splatList);

        const transformHeader = new Container({
            class: 'panel-header'
        });

        const transformIcon = new Label({
            text: '\uE111',
            class: 'panel-header-icon'
        });

        const transformLabel = new Label({
            class: 'panel-header-label'
        });
        i18n.bindText(transformLabel, 'panel.scene.transform');

        transformHeader.append(transformIcon);
        transformHeader.append(transformLabel);

        this.append(sceneHeader);
        this.append(splatListContainer);
        this.append(transformHeader);
        this.append(new Transform(events));
        this.append(new Element({
            class: 'panel-section-divider',
            height: 8
        }));
        this.append(new CameraPanel(events));
        this.append(new FloaterPanel(events));
        this.append(new Element({
            class: 'panel-header',
            height: 4
        }));
        // Preview window as sidebar element (no absolute positioning)
        this.dom.appendChild(previewWindow.dom);
        this.append(new Element({
            class: 'panel-header',
            height: 20
        }));
    }
}

export { ScenePanel };
