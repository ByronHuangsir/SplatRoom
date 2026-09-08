// 清理特效旧键：菜单/面板已移除，删除全部 menu.effects.* / panel.effects.*
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'locales');
const files = readdirSync(dir).filter(f => f.endsWith('.json'));

const removeKeys = [
    'menu.effects',
    'menu.effects.particles',
    'menu.effects.scatter',
    'menu.effects.aggregate',
    'panel.effects.scatter',
    'panel.effects.aggregate',
    'panel.effects.title'
];

for (const file of files) {
    const path = join(dir, file);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    for (const k of removeKeys) {
        delete json[k];
    }
    writeFileSync(path, `${JSON.stringify(json, null, 4)}\n`, 'utf8');
    console.log(`cleaned ${file}`);
}
