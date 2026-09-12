// 更新特效菜单/面板翻译键 v2：移除叠加粒子预设键，改为模型粒子化散射键
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'locales');
const files = readdirSync(dir).filter(f => f.endsWith('.json'));

// 需要删除的旧键（叠加粒子系统预设）
const removeKeys = [
    'menu.effects.sparkle',
    'menu.effects.snow',
    'menu.effects.sparks',
    'menu.effects.fog',
    'menu.effects.clear',
    'panel.effects.clear'
];

const enTexts = {
    'menu.effects.scatter': 'Scatter to Particles',
    'menu.effects.aggregate': 'Aggregate Back',
    'panel.effects.scatter': 'Scatter to Particles',
    'panel.effects.aggregate': 'Aggregate Back'
};

const translations = {
    'en.json': enTexts,
    'zh-CN.json': {
        'menu.effects.scatter': '粒子化',
        'menu.effects.aggregate': '聚合恢复',
        'panel.effects.scatter': '粒子化（散开）',
        'panel.effects.aggregate': '聚合恢复（回模型）'
    },
    'de.json': {
        'menu.effects.scatter': 'Zu Partikeln streuen',
        'menu.effects.aggregate': 'Wieder vereinen',
        'panel.effects.scatter': 'Zu Partikeln streuen',
        'panel.effects.aggregate': 'Wieder vereinen'
    },
    'es.json': {
        'menu.effects.scatter': 'Dispersar en partículas',
        'menu.effects.aggregate': 'Reagrupar',
        'panel.effects.scatter': 'Dispersar en partículas',
        'panel.effects.aggregate': 'Reagrupar'
    },
    'fr.json': {
        'menu.effects.scatter': 'Disperser en particules',
        'menu.effects.aggregate': 'Réassembler',
        'panel.effects.scatter': 'Disperser en particules',
        'panel.effects.aggregate': 'Réassembler'
    },
    'ja.json': {
        'menu.effects.scatter': 'パーティクル化',
        'menu.effects.aggregate': '元に戻す',
        'panel.effects.scatter': 'パーティクル化（拡散）',
        'panel.effects.aggregate': '元に戻す（モデルへ）'
    },
    'ko.json': {
        'menu.effects.scatter': '입자화',
        'menu.effects.aggregate': '원래대로',
        'panel.effects.scatter': '입자화 (확산)',
        'panel.effects.aggregate': '원래대로 (모델로)'
    },
    'pt-BR.json': {
        'menu.effects.scatter': 'Dispersar em partículas',
        'menu.effects.aggregate': 'Reagregar',
        'panel.effects.scatter': 'Dispersar em partículas',
        'panel.effects.aggregate': 'Reagregar'
    },
    'ru.json': {
        'menu.effects.scatter': 'Разлететься в частицы',
        'menu.effects.aggregate': 'Собрать обратно',
        'panel.effects.scatter': 'Разлететься в частицы',
        'panel.effects.aggregate': 'Собрать обратно'
    }
};

for (const file of files) {
    const path = join(dir, file);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    const texts = translations[file] || enTexts;

    // 删除旧键
    for (const k of removeKeys) {
        delete json[k];
    }
    // 添加新键（放在 menu.effects.particles 之后）
    const keys = Object.keys(json);
    const idx = keys.indexOf('menu.effects.particles');
    const newObj = {};
    for (const k of keys) {
        newObj[k] = json[k];
        if (k === 'menu.effects.particles') {
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
