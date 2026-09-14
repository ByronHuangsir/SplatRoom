/**
 * Locale surgery for the three-axis selection range (V3.8.0).
 *
 * The single "选区深度" panel became "选区范围" with three dual-handle ranges, so the title
 * key changes and the two extra screen axes need labels.
 *
 * Usage: node scripts/update-selection-range3-locales.cjs
 */

const { readFileSync, writeFileSync, readdirSync } = require('fs');
const { join } = require('path');

const localesDir = join(__dirname, '..', 'static', 'locales');

const REMOVE = ['select-toolbar.selectionDepth'];

// inserted right after select-toolbar.depthFar (the depth row's keys), i.e. inside the
// selection-toolbar block
const ANCHOR = 'select-toolbar.depthFar';

const ADD = {
    'select-toolbar.selectionRange': {
        en: 'Selection range',
        'zh-CN': '选区范围',
        ja: '選択範囲',
        ko: '선택 범위',
        de: 'Auswahlbereich',
        es: 'Rango de selección',
        fr: 'Plage de sélection',
        'pt-BR': 'Intervalo da seleção',
        ru: 'Диапазон выделения'
    },
    'select-toolbar.rangeLeft': {
        en: 'Left',
        'zh-CN': '左',
        ja: '左',
        ko: '왼쪽',
        de: 'Links',
        es: 'Izquierda',
        fr: 'Gauche',
        'pt-BR': 'Esquerda',
        ru: 'Слева'
    },
    'select-toolbar.rangeRight': {
        en: 'Right',
        'zh-CN': '右',
        ja: '右',
        ko: '오른쪽',
        de: 'Rechts',
        es: 'Derecha',
        fr: 'Droite',
        'pt-BR': 'Direita',
        ru: 'Справа'
    },
    'select-toolbar.rangeTop': {
        en: 'Top',
        'zh-CN': '上',
        ja: '上',
        ko: '위',
        de: 'Oben',
        es: 'Arriba',
        fr: 'Haut',
        'pt-BR': 'Topo',
        ru: 'Сверху'
    },
    'select-toolbar.rangeBottom': {
        en: 'Bottom',
        'zh-CN': '下',
        ja: '下',
        ko: '아래',
        de: 'Unten',
        es: 'Abajo',
        fr: 'Bas',
        'pt-BR': 'Base',
        ru: 'Снизу'
    }
};

const files = readdirSync(localesDir).filter(f => f.endsWith('.json'));
let touched = 0;

for (const file of files) {
    const lang = file.replace(/\.json$/, '');
    const path = join(localesDir, file);
    const data = JSON.parse(readFileSync(path, 'utf8'));

    let changed = false;

    for (const key of REMOVE) {
        if (key in data) {
            delete data[key];
            changed = true;
        }
    }

    const out = {};
    for (const [key, value] of Object.entries(data)) {
        out[key] = value;
        if (key === ANCHOR) {
            for (const [added, translations] of Object.entries(ADD)) {
                if (!(added in data)) {
                    out[added] = translations[lang] ?? translations.en;
                    changed = true;
                }
            }
        }
    }

    if (changed) {
        writeFileSync(path, `${JSON.stringify(out, null, 4)}\n`, 'utf8');
        touched++;
        console.log(`${file}: ${Object.keys(data).length} -> ${Object.keys(out).length} keys`);
    } else {
        console.log(`${file}: unchanged`);
    }
}

console.log(`\nupdated ${touched} locale files`);
