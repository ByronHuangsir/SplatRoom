// 给 panel.groundwater.title 加调试后缀
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'locales');
const files = readdirSync(dir).filter(f => f.endsWith('.json'));

const suffix = {
    'en.json': ' (Debug)',
    'zh-CN.json': '（调试中）',
    'de.json': ' (Debug)',
    'es.json': ' (Debug)',
    'fr.json': ' (Debug)',
    'ja.json': ' (デバッグ)',
    'ko.json': ' (디버그)',
    'pt-BR.json': ' (Debug)',
    'ru.json': ' (отладка)'
};

for (const file of files) {
    const path = join(dir, file);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    const base = {
        'en.json': 'Ground / Water Flatten',
        'zh-CN.json': '地面/水域平整',
        'de.json': 'Boden/Wasser glätten',
        'es.json': 'Aplanar suelo/agua',
        'fr.json': 'Aplatir sol/eau',
        'ja.json': '地面/水面の平坦化',
        'ko.json': '지면/수면 평탄화',
        'pt-BR.json': 'Aplanar chão/água',
        'ru.json': 'Выровнять землю/воду'
    }[file];
    if (json['panel.groundwater.title'] === undefined) continue;
    json['panel.groundwater.title'] = base + (suffix[file] || ' (Debug)');
    writeFileSync(path, `${JSON.stringify(json, null, 4)}\n`, 'utf8');
    console.log(`updated ${file}: ${json['panel.groundwater.title']}`);
}
