// backfill-locales.mjs
// 用 en.json 回填各语言缺失的翻译 key。
//
// 背景：新增功能（调色 HSL、裁剪盒、去浮云、修补、平面修整、表面平整等）的
// 翻译 key 只加进了 en.json / zh-CN.json，其余 7 种语言缺 235 个 key，导致
// `npm run lint:locales` 失败，且 UI 中这些 key 直接回退英文。
//
// 本脚本把缺失 key 以英文原文占位回填（UI 行为与回退一致，无回归），并保证
// key 集合与顺序和 en.json 完全一致 → lint:locales 通过。后续人工翻译时只需
// 修改对应文件的值。
//
// 用法: node scripts/backfill-locales.mjs [语言...]
//       不带参数则处理所有语言；可指定如: node scripts/backfill-locales.mjs de fr

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const localesDir = join(import.meta.dirname, '..', 'static', 'locales');
const referenceFile = 'en.json';

const readJson = (file) => JSON.parse(readFileSync(join(localesDir, file), 'utf8'));
const writeJson = (file, obj) => {
    // 与现有文件保持一致: 4 空格缩进 + CRLF + 末尾无换行
    writeFileSync(join(localesDir, file), JSON.stringify(obj, null, 4).replace(/\n/g, '\r\n'));
};

const en = readJson(referenceFile);
const enKeys = Object.keys(en);

const targets = process.argv.length > 2
    ? process.argv.slice(2)
    : ['de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh-CN'];

let failed = false;
for (const lang of targets) {
    const file = `${lang}.json`;
    let langJson;
    try {
        langJson = readJson(file);
    } catch (e) {
        console.error(`✖ ${file}: cannot read/parse — ${e.message}`);
        failed = true;
        continue;
    }

    const out = {};
    let added = 0;
    for (const key of enKeys) {
        if (key in langJson) {
            out[key] = langJson[key];
        } else {
            out[key] = en[key];
            added++;
        }
    }

    writeJson(file, out);
    console.log(`✔ ${file}: ${added} missing keys backfilled with English placeholder (total ${Object.keys(out).length})`);
}

if (failed) {
    process.exit(1);
}
