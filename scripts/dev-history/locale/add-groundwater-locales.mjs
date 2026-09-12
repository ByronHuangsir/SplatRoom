// 向所有 locale 追加 groundwater 面板相关翻译键
// 用法: node scripts/add-groundwater-locales.mjs
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'locales');
const files = readdirSync(dir).filter(f => f.endsWith('.json'));

// 英文基准（键名）
const enTexts = {
    'panel.groundwater.title': 'Ground / Water Flatten',
    'panel.groundwater.ground': 'Ground',
    'panel.groundwater.water': 'Water',
    'panel.groundwater.flatten': 'Flatten Ground',
    'panel.groundwater.noSelection': 'Select a splat first',
    'panel.groundwater.tol': 'Detect tolerance',
    'panel.groundwater.ghostTol': 'Ghost color tolerance',
    'tooltip.bottom-toolbar.groundwater': 'Ground/Water Flatten'
};

const translations = {
    'en.json': enTexts,
    'zh-CN.json': {
        'panel.groundwater.title': '地面/水域平整',
        'panel.groundwater.ground': '地面',
        'panel.groundwater.water': '水域',
        'panel.groundwater.flatten': '熨平地面',
        'panel.groundwater.noSelection': '请先选中一个模型',
        'panel.groundwater.tol': '检测容差',
        'panel.groundwater.ghostTol': '幽灵团颜色容差',
        'tooltip.bottom-toolbar.groundwater': '地面/水域平整'
    },
    'de.json': {
        'panel.groundwater.title': 'Boden/Wasser glätten',
        'panel.groundwater.ground': 'Boden',
        'panel.groundwater.water': 'Wasser',
        'panel.groundwater.flatten': 'Boden glätten',
        'panel.groundwater.noSelection': 'Zuerst ein Modell wählen',
        'panel.groundwater.tol': 'Erkennungstoleranz',
        'panel.groundwater.ghostTol': 'Geister-Farbtoleranz',
        'tooltip.bottom-toolbar.groundwater': 'Boden/Wasser glätten'
    },
    'es.json': {
        'panel.groundwater.title': 'Aplanar suelo/agua',
        'panel.groundwater.ground': 'Suelo',
        'panel.groundwater.water': 'Agua',
        'panel.groundwater.flatten': 'Aplanar suelo',
        'panel.groundwater.noSelection': 'Selecciona un modelo primero',
        'panel.groundwater.tol': 'Tolerancia de detección',
        'panel.groundwater.ghostTol': 'Tolerancia de color fantasma',
        'tooltip.bottom-toolbar.groundwater': 'Aplanar suelo/agua'
    },
    'fr.json': {
        'panel.groundwater.title': 'Aplatir sol/eau',
        'panel.groundwater.ground': 'Sol',
        'panel.groundwater.water': 'Eau',
        'panel.groundwater.flatten': 'Aplatir sol',
        'panel.groundwater.noSelection': 'Sélectionnez d\'abord un modèle',
        'panel.groundwater.tol': 'Tolérance de détection',
        'panel.groundwater.ghostTol': 'Tolérance de couleur fantôme',
        'tooltip.bottom-toolbar.groundwater': 'Aplatir sol/eau'
    },
    'ja.json': {
        'panel.groundwater.title': '地面/水面の平坦化',
        'panel.groundwater.ground': '地面',
        'panel.groundwater.water': '水面',
        'panel.groundwater.flatten': '地面を平坦化',
        'panel.groundwater.noSelection': '先にモデルを選択してください',
        'panel.groundwater.tol': '検出許容値',
        'panel.groundwater.ghostTol': 'ゴースト色許容値',
        'tooltip.bottom-toolbar.groundwater': '地面/水面の平坦化'
    },
    'ko.json': {
        'panel.groundwater.title': '지면/수면 평탄화',
        'panel.groundwater.ground': '지면',
        'panel.groundwater.water': '수면',
        'panel.groundwater.flatten': '지면 평탄화',
        'panel.groundwater.noSelection': '먼저 모델을 선택하세요',
        'panel.groundwater.tol': '감지 허용 오차',
        'panel.groundwater.ghostTol': '고스트 색상 허용 오차',
        'tooltip.bottom-toolbar.groundwater': '지면/수면 평탄화'
    },
    'pt-BR.json': {
        'panel.groundwater.title': 'Aplanar chão/água',
        'panel.groundwater.ground': 'Chão',
        'panel.groundwater.water': 'Água',
        'panel.groundwater.flatten': 'Aplanar chão',
        'panel.groundwater.noSelection': 'Selecione um modelo primeiro',
        'panel.groundwater.tol': 'Tolerância de detecção',
        'panel.groundwater.ghostTol': 'Tolerância de cor fantasma',
        'tooltip.bottom-toolbar.groundwater': 'Aplanar chão/água'
    },
    'ru.json': {
        'panel.groundwater.title': 'Выровнять землю/воду',
        'panel.groundwater.ground': 'Земля',
        'panel.groundwater.water': 'Вода',
        'panel.groundwater.flatten': 'Выровнять землю',
        'panel.groundwater.noSelection': 'Сначала выберите модель',
        'panel.groundwater.tol': 'Допуск обнаружения',
        'panel.groundwater.ghostTol': 'Допуск цвета призрака',
        'tooltip.bottom-toolbar.groundwater': 'Выровнять землю/воду'
    }
};

for (const file of files) {
    const path = join(dir, file);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    const texts = translations[file] || enTexts;

    // 在 context.semantic.flattenGround 之后插入
    const insertAfter = 'context.semantic.flattenGround';
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
    for (const nk of Object.keys(enTexts)) {
        newObj[nk] = texts[nk] ?? enTexts[nk];
    }
    writeFileSync(path, `${JSON.stringify(newObj, null, 4)}\n`, 'utf8');
    console.log(`updated ${file}`);
}
