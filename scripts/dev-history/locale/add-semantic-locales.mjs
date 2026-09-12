// 向所有 locale 插入 semantic 相关翻译键（context.orient 之后）
// 用法: node scripts/add-semantic-locales.mjs
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'locales');
const files = readdirSync(dir).filter(f => f.endsWith('.json'));

// 英文翻译（基准）
const enTexts = {
    'context.semantic': 'Detect Region',
    'context.semantic.selectGround': 'Select Ground',
    'context.semantic.selectWater': 'Select Water',
    'context.semantic.flattenGround': 'Flatten Ground'
};

// 各语言翻译
const translations = {
    'en.json': enTexts,
    'zh-CN.json': {
        'context.semantic': '区域识别',
        'context.semantic.selectGround': '选中地面',
        'context.semantic.selectWater': '选中水面',
        'context.semantic.flattenGround': '熨平地面'
    },
    'de.json': {
        'context.semantic': 'Region erkennen',
        'context.semantic.selectGround': 'Boden auswählen',
        'context.semantic.selectWater': 'Wasser auswählen',
        'context.semantic.flattenGround': 'Boden glätten'
    },
    'es.json': {
        'context.semantic': 'Detectar región',
        'context.semantic.selectGround': 'Seleccionar suelo',
        'context.semantic.selectWater': 'Seleccionar agua',
        'context.semantic.flattenGround': 'Aplanar suelo'
    },
    'fr.json': {
        'context.semantic': 'Détecter région',
        'context.semantic.selectGround': 'Sélectionner sol',
        'context.semantic.selectWater': 'Sélectionner eau',
        'context.semantic.flattenGround': 'Aplatir sol'
    },
    'ja.json': {
        'context.semantic': '領域検出',
        'context.semantic.selectGround': '地面を選択',
        'context.semantic.selectWater': '水面を選択',
        'context.semantic.flattenGround': '地面を平坦化'
    },
    'ko.json': {
        'context.semantic': '영역 감지',
        'context.semantic.selectGround': '지면 선택',
        'context.semantic.selectWater': '수면 선택',
        'context.semantic.flattenGround': '지면 평탄화'
    },
    'pt-BR.json': {
        'context.semantic': 'Detectar região',
        'context.semantic.selectGround': 'Selecionar chão',
        'context.semantic.selectWater': 'Selecionar água',
        'context.semantic.flattenGround': 'Aplanar chão'
    },
    'ru.json': {
        'context.semantic': 'Определить область',
        'context.semantic.selectGround': 'Выбрать землю',
        'context.semantic.selectWater': 'Выбрать воду',
        'context.semantic.flattenGround': 'Выровнять землю'
    }
};

for (const file of files) {
    const path = join(dir, file);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    const texts = translations[file] || enTexts; // 未提供的语言回退英文

    // 在 context.orient 之后插入
    const insertAfter = 'context.orient';
    const keys = Object.keys(json);
    const idx = keys.indexOf(insertAfter);
    if (idx === -1) {
        console.error(`key ${insertAfter} not found in ${file}, skipping`);
        continue;
    }
    const newObj = {};
    for (const k of keys) {
        newObj[k] = json[k];
        if (k === insertAfter) {
            for (const nk of Object.keys(enTexts)) {
                if (!(nk in newObj)) newObj[nk] = texts[nk] ?? enTexts[nk];
            }
        }
    }
    // 若已有键（重跑），用新值覆盖
    for (const nk of Object.keys(enTexts)) {
        newObj[nk] = texts[nk] ?? enTexts[nk];
    }
    writeFileSync(path, `${JSON.stringify(newObj, null, 4)}\n`, 'utf8');
    console.log(`updated ${file}`);
}
