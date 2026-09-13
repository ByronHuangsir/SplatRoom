/**
 * Locale surgery for the selection depth range (V3.7.9).
 *
 * Drops the two features the range replaces - "选择深度" (surface-only id pick) and
 * "选择覆盖范围" (footprint coverage) - and adds the 选区深度 keys the new bar uses.
 *
 * Usage: node scripts/update-selection-range-locales.cjs
 */

const { readFileSync, writeFileSync, readdirSync } = require('fs');
const { join, dirname } = require('path');

const localesDir = join(__dirname, '..', 'static', 'locales');

const REMOVE = [
    'select-toolbar.depth',
    'select-toolbar.depthThickness',
    'popup.shortcuts.toggle-selection-depth',
    'popup.shortcuts.toggle-selection-footprint',
    'tooltip.bottom-toolbar.use-depth',
    'tooltip.bottom-toolbar.footprint'
];

// inserted right after select-toolbar.rotation, i.e. the selection-toolbar block
const ANCHOR = 'select-toolbar.rotation';

const ADD = {
    'select-toolbar.selectionDepth': {
        en: 'Selection depth',
        'zh-CN': '选区深度',
        ja: '選択深度',
        ko: '선택 깊이',
        de: 'Auswahltiefe',
        es: 'Profundidad de selección',
        fr: 'Profondeur de sélection',
        'pt-BR': 'Profundidade da seleção',
        ru: 'Глубина выделения'
    },
    'select-toolbar.depthNear': {
        en: 'Near',
        'zh-CN': '最近',
        ja: '最近',
        ko: '가까운 쪽',
        de: 'Nah',
        es: 'Cercano',
        fr: 'Proche',
        'pt-BR': 'Perto',
        ru: 'Ближе'
    },
    'select-toolbar.depthFar': {
        en: 'Far',
        'zh-CN': '最远',
        ja: '最遠',
        ko: '먼 쪽',
        de: 'Fern',
        es: 'Lejano',
        fr: 'Loin',
        'pt-BR': 'Longe',
        ru: 'Дальше'
    },
    'select-toolbar.depthReset': {
        en: 'Reset',
        'zh-CN': '重置',
        ja: 'リセット',
        ko: '초기화',
        de: 'Zurücksetzen',
        es: 'Restablecer',
        fr: 'Réinitialiser',
        'pt-BR': 'Redefinir',
        ru: 'Сброс'
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

    // rebuild in the reference order: everything before/after the anchor is preserved,
    // the new keys land in the selection-toolbar block
    const out = {};
    for (const [key, value] of Object.entries(data)) {
        if (key === ANCHOR) {
            out[key] = value;
            for (const [added, translations] of Object.entries(ADD)) {
                if (!(added in data)) {
                    out[added] = translations[lang] ?? translations.en;
                    changed = true;
                }
            }
            continue;
        }
        out[key] = value;
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
