// Update the 去浮云 locale strings in all 9 locales:
//   panel.floater.details        -> new placeholders (radius / limit / reference), like-for-like position
//   panel.floater.sensitivityHint -> rewritten for the new single density criterion
// Any `panel.floater.detailsSampled` key (added while a sampled preview existed, then removed when
// detection became exact) is dropped, so the key set stays identical across locales.
//
// usage: node update-floater-locales.cjs [--check]
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'static', 'locales');

const DETAILS = {
    'en': 'Detector: under {{limit}} neighbours within {{radius}} (a surface here has about {{reference}})',
    'zh-CN': '判据：半径 {{radius}} 内的邻居数 < {{limit}}（本模型表面处约 {{reference}} 个）',
    'de': 'Kriterium: weniger als {{limit}} Nachbarn im Radius {{radius}} (eine Oberfläche hat hier etwa {{reference}})',
    'es': 'Criterio: menos de {{limit}} vecinos en un radio de {{radius}} (una superficie aquí tiene unos {{reference}})',
    'fr': 'Critère : moins de {{limit}} voisins dans un rayon de {{radius}} (une surface en compte environ {{reference}})',
    'ja': '判定：半径 {{radius}} 内の近傍が {{limit}} 個未満（このモデルの表面では約 {{reference}} 個）',
    'ko': '판정: 반경 {{radius}} 안의 이웃이 {{limit}}개 미만(이 모델의 표면은 약 {{reference}}개)',
    'pt-BR': 'Critério: menos de {{limit}} vizinhos num raio de {{radius}} (uma superfície aqui tem cerca de {{reference}})',
    'ru': 'Критерий: меньше {{limit}} соседей в радиусе {{radius}} (на поверхности здесь около {{reference}})'
};

const SAMPLED = null;   // no sampled preview any more: detection is exact and cheap enough
const HINT = {
    'en': 'Higher removes more. A gaussian counts when the space around it is nearly empty: its neighbourhood (about 34x the point spacing) holds under a set share of what a surface here would hold. Default 50 picks ~2.2% of a real 931k scan.',
    'zh-CN': '数值越高删得越多。判据是"这一点周围几乎是空的"：以它为中心、半宽约 34 倍点间距的方块里，邻居数低于本模型表面密度的某个比例就算浮云。默认 50 在 93 万点的真实扫描上选中约 2.2%（覆盖手工清理量的约 39%）。',
    'de': 'Höhere Werte entfernen mehr. Ein Punkt zählt, wenn der Raum um ihn fast leer ist: seine Nachbarschaft (etwa 34x Punktabstand) enthält weniger als ein bestimmter Anteil dessen, was eine Oberfläche hier hätte. Standard 50 wählt ~2,2 % eines echten 931k-Scans.',
    'es': 'Un valor más alto elimina más. Un punto cuenta cuando el espacio a su alrededor está casi vacío: su vecindad (unas 34 veces la separación entre puntos) contiene menos de cierta fracción de lo que tendría una superficie. El valor 50 elige ~2,2 % de un escaneo real de 931k.',
    'fr': 'Une valeur plus élevée supprime davantage. Un point compte quand l\u2019espace autour de lui est presque vide : son voisinage (environ 34x l\u2019espacement des points) contient moins d\u2019une fraction donnée de ce qu\u2019aurait une surface. La valeur 50 sélectionne ~2,2 % d\u2019un scan réel de 931k.',
    'ja': '値が大きいほど多く削除されます。周囲がほぼ空の点が対象で、判定は「点間隔の約 34 倍の半径にある近傍数が、このモデルの表面密度の一定割合未満」です。既定の 50 では 93 万点の実スキャンで約 2.2% が選ばれます。',
    'ko': '값이 높을수록 더 많이 제거됩니다. 주변이 거의 비어 있는 점이 대상이며, 판정은 "점 간격의 약 34배 반경 안의 이웃 수가 이 모델 표면 밀도의 일정 비율 미만"입니다. 기본값 50은 93만 점 실제 스캔에서 약 2.2%를 선택합니다.',
    'pt-BR': 'Valores mais altos removem mais. Um ponto conta quando o espaço ao redor está quase vazio: sua vizinhança (cerca de 34x o espaçamento entre pontos) tem menos de uma fração definida do que uma superfície teria. O padrão 50 escolhe ~2,2 % de um scan real de 931k.',
    'ru': 'Чем выше значение, тем больше удаляется. Точка учитывается, когда пространство вокруг почти пусто: в её окрестности (примерно 34× расстояние между точками) меньше заданной доли от того, что было бы на поверхности. Значение 50 выбирает ~2,2 % реального скана на 931 тыс. точек.'
};

const check = process.argv.includes('--check');
let failed = 0;

for (const file of fs.readdirSync(DIR).filter(f => f.endsWith('.json'))) {
    const lang = path.basename(file, '.json');
    const full = path.join(DIR, file);
    const text = fs.readFileSync(full, 'utf8');
    const lines = text.split('\n');

    const detailsIdx = lines.findIndex(l => l.includes('"panel.floater.details"'));
    const hintIdx = lines.findIndex(l => l.includes('"panel.floater.sensitivityHint"'));
    if (detailsIdx === -1 || hintIdx === -1) {
        console.log(`${lang}: MISSING KEYS (details ${detailsIdx}, hint ${hintIdx})`);
        failed++;
        continue;
    }

    const indent = lines[detailsIdx].match(/^\s*/)[0];
    const trailingComma = lines[detailsIdx].trimEnd().endsWith(',') ? ',' : '';
    const newDetails = `${indent}"panel.floater.details": ${JSON.stringify(DETAILS[lang])}${trailingComma}`;

    const out = lines.slice();
    // replace details, then drop any leftover detailsSampled key
    out[detailsIdx] = newDetails;
    const sampledIdx = out.findIndex(l => l.includes('"panel.floater.detailsSampled"'));
    if (sampledIdx !== -1) {
        out.splice(sampledIdx, 1);
    }
    const hintIdxNow = out.findIndex(l => l.includes('"panel.floater.sensitivityHint"'));
    out[hintIdxNow] = `${indent}"panel.floater.sensitivityHint": ${JSON.stringify(HINT[lang])}${out[hintIdxNow].trimEnd().endsWith(',') ? ',' : ''}`;

    const next = out.join('\n');
    try {
        JSON.parse(next);
    } catch (e) {
        console.log(`${lang}: would produce invalid JSON: ${e.message}`);
        failed++;
        continue;
    }
    if (check) {
        const same = next === text;
        console.log(`${lang}: ${same ? 'up to date' : 'NEEDS UPDATE'}`);
        if (!same) failed++;
    } else {
        fs.writeFileSync(full, next);
        console.log(`${lang}: updated`);
    }
}

if (check && failed) {
    process.exitCode = 1;
}
