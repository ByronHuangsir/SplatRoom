// Add the selection depth bar's two labels to every locale, after the existing `select-toolbar.*`
// block, keeping the key ORDER identical across files (scripts/check-locales.mjs compares names+order
// against en.json).
//
// usage: node add-selection-depth-keys.cjs [--check]
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'static', 'locales');
const LANGS = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh-CN'];

const KEYS = [
    ['select-toolbar.depth', {
        'en': 'Depth',
        'zh-CN': '深度',
        'de': 'Tiefe',
        'es': 'Profundidad',
        'fr': 'Profondeur',
        'ja': '深度',
        'ko': '깊이',
        'pt-BR': 'Profundidade',
        'ru': 'Глубина'
    }],
    ['select-toolbar.depthThickness', {
        'en': 'Depth thickness (% of model)',
        'zh-CN': '深度厚度(占模型 %)',
        'de': 'Tiefendicke (% des Modells)',
        'es': 'Grosor de profundidad (% del modelo)',
        'fr': 'Épaisseur de profondeur (% du modèle)',
        'ja': '深度の厚み(モデルの %)',
        'ko': '깊이 두께(모델의 %)',
        'pt-BR': 'Espessura de profundidade (% do modelo)',
        'ru': 'Толщина глубины (% модели)'
    }]
];

const check = process.argv.includes('--check');
let failed = 0;

for (const lang of LANGS) {
    const full = path.join(DIR, `${lang}.json`);
    const text = fs.readFileSync(full, 'utf8');
    const lines = text.split('\n');
    const anchorIndex = lines.findIndex(l => l.includes('"select-toolbar.rotation"'));
    const fallback = lines.findIndex(l => l.includes('"select-toolbar.'));
    const anchor = anchorIndex === -1 ? fallback : anchorIndex;
    if (anchor === -1) {
        console.log(`${lang}: no select-toolbar anchor found`);
        failed++;
        continue;
    }
    const indent = lines[anchor].match(/^\s*/)[0];

    let next = lines.slice();
    let insertAt = anchor + 1;
    for (const [key, values] of KEYS) {
        const existing = next.findIndex(l => l.includes(`"${key}"`));
        const line = `${indent}"${key}": ${JSON.stringify(values[lang])},`;
        if (existing !== -1) {
            next[existing] = line;
        } else {
            next.splice(insertAt, 0, line);
            insertAt++;
        }
    }

    const out = next.join('\n');
    try {
        const parsed = JSON.parse(out);
        for (const [key] of KEYS) {
            if (typeof parsed[key] !== 'string' || !parsed[key]) {
                throw new Error(`${key} missing`);
            }
        }
    } catch (e) {
        console.log(`${lang}: FAILED ${e.message}`);
        failed++;
        continue;
    }

    if (check) {
        const same = out === text;
        console.log(`${lang}: ${same ? 'up to date' : 'NEEDS UPDATE'}`);
        if (!same) failed++;
    } else {
        fs.writeFileSync(full, out);
        console.log(`${lang}: updated`);
    }
}

if (check && failed) {
    process.exitCode = 1;
}
