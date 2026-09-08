// 添加特效菜单/面板翻译键
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'locales');
const files = readdirSync(dir).filter(f => f.endsWith('.json'));

const enTexts = {
    'menu.effects': 'Effects',
    'menu.effects.particles': 'Particle Effects',
    'menu.effects.sparkle': 'Sparkle',
    'menu.effects.snow': 'Snow',
    'menu.effects.sparks': 'Sparks',
    'menu.effects.fog': 'Fog',
    'menu.effects.clear': 'Clear All',
    'panel.effects.title': 'Particle Effects',
    'panel.effects.clear': 'Clear All'
};

const translations = {
    'en.json': enTexts,
    'zh-CN.json': {
        'menu.effects': '特效',
        'menu.effects.particles': '粒子特效',
        'menu.effects.sparkle': '星光',
        'menu.effects.snow': '飘雪',
        'menu.effects.sparks': '火花',
        'menu.effects.fog': '薄雾',
        'menu.effects.clear': '清空特效',
        'panel.effects.title': '粒子特效',
        'panel.effects.clear': '清空全部'
    },
    'de.json': {
        'menu.effects': 'Effekte',
        'menu.effects.particles': 'Partikeleffekte',
        'menu.effects.sparkle': 'Glitzer',
        'menu.effects.snow': 'Schnee',
        'menu.effects.sparks': 'Funken',
        'menu.effects.fog': 'Nebel',
        'menu.effects.clear': 'Alle löschen',
        'panel.effects.title': 'Partikeleffekte',
        'panel.effects.clear': 'Alle löschen'
    },
    'es.json': {
        'menu.effects': 'Efectos',
        'menu.effects.particles': 'Efectos de partículas',
        'menu.effects.sparkle': 'Brillo',
        'menu.effects.snow': 'Nieve',
        'menu.effects.sparks': 'Chispas',
        'menu.effects.fog': 'Niebla',
        'menu.effects.clear': 'Borrar todo',
        'panel.effects.title': 'Efectos de partículas',
        'panel.effects.clear': 'Borrar todo'
    },
    'fr.json': {
        'menu.effects': 'Effets',
        'menu.effects.particles': 'Effets de particules',
        'menu.effects.sparkle': 'Scintillement',
        'menu.effects.snow': 'Neige',
        'menu.effects.sparks': 'Étincelles',
        'menu.effects.fog': 'Brouillard',
        'menu.effects.clear': 'Tout effacer',
        'panel.effects.title': 'Effets de particules',
        'panel.effects.clear': 'Tout effacer'
    },
    'ja.json': {
        'menu.effects': 'エフェクト',
        'menu.effects.particles': 'パーティクルエフェクト',
        'menu.effects.sparkle': 'きらめき',
        'menu.effects.snow': '雪',
        'menu.effects.sparks': '火花',
        'menu.effects.fog': '霧',
        'menu.effects.clear': 'すべてクリア',
        'panel.effects.title': 'パーティクルエフェクト',
        'panel.effects.clear': 'すべてクリア'
    },
    'ko.json': {
        'menu.effects': '효과',
        'menu.effects.particles': '파티클 효과',
        'menu.effects.sparkle': '반짝임',
        'menu.effects.snow': '눈',
        'menu.effects.sparks': '불꽃',
        'menu.effects.fog': '안개',
        'menu.effects.clear': '모두 지우기',
        'panel.effects.title': '파티클 효과',
        'panel.effects.clear': '모두 지우기'
    },
    'pt-BR.json': {
        'menu.effects': 'Efeitos',
        'menu.effects.particles': 'Efeitos de partículas',
        'menu.effects.sparkle': 'Brilho',
        'menu.effects.snow': 'Neve',
        'menu.effects.sparks': 'Faíscas',
        'menu.effects.fog': 'Névoa',
        'menu.effects.clear': 'Limpar tudo',
        'panel.effects.title': 'Efeitos de partículas',
        'panel.effects.clear': 'Limpar tudo'
    },
    'ru.json': {
        'menu.effects': 'Эффекты',
        'menu.effects.particles': 'Эффекты частиц',
        'menu.effects.sparkle': 'Блеск',
        'menu.effects.snow': 'Снег',
        'menu.effects.sparks': 'Искры',
        'menu.effects.fog': 'Туман',
        'menu.effects.clear': 'Очистить все',
        'panel.effects.title': 'Эффекты частиц',
        'panel.effects.clear': 'Очистить все'
    }
};

for (const file of files) {
    const path = join(dir, file);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    const texts = translations[file] || enTexts;

    // 在 menu.tools.customize-controls 之后插入（菜单顺序：工具→特效→渲染）
    const insertAfter = 'menu.tools.customize-controls';
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
