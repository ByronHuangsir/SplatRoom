// Keep the 去浮云 locale block in step with the detector.
//
//   panel.floater.details          - tooltip: limit / hardLimit / opacity / radius / reference / candidates
//   panel.floater.sensitivityHint   - rewritten once the criterion gained the "and it is faint" clause and
//                                     the scope control (walls/floor on real scans are as sparse as floaters)
//   panel.floater.scope{,.all,.selection,.exclude} - NEW: 处理范围 (whole model / selection only / skip selection)
//
// The new keys are inserted after the last `panel.floater.*` key in every file so the key ORDER stays
// identical across locales (scripts/check-locales.mjs compares names and order against en.json).
//
// usage: node update-floater-locales.cjs [--check]
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'static', 'locales');
const LANGS = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh-CN'];

const DETAILS = {
    'en': 'Criterion: under {{limit}} neighbours within {{radius}} and opacity \u2264 {{opacity}} (or under {{hardLimit}} neighbours whatever the opacity); a surface here has about {{reference}}. Scope: {{candidates}} gaussians.',
    'zh-CN': '判据：半径 {{radius}} 内邻居数 < {{limit}} 且不透明度 \u2264 {{opacity}}（或邻居数 < {{hardLimit}}，不看透明度）；本模型表面处约 {{reference}} 个。范围 {{candidates}} 个高斯。',
    'de': 'Kriterium: weniger als {{limit}} Nachbarn im Radius {{radius}} und Deckkraft \u2264 {{opacity}} (oder weniger als {{hardLimit}} Nachbarn unabhängig von der Deckkraft); eine Oberfläche hat hier etwa {{reference}}. Bereich: {{candidates}} Punkte.',
    'es': 'Criterio: menos de {{limit}} vecinos en un radio de {{radius}} y opacidad \u2264 {{opacity}} (o menos de {{hardLimit}} vecinos sin mirar la opacidad); una superficie aquí tiene unos {{reference}}. Ámbito: {{candidates}} puntos.',
    'fr': 'Critère : moins de {{limit}} voisins dans un rayon de {{radius}} et opacité \u2264 {{opacity}} (ou moins de {{hardLimit}} voisins quelle que soit l\u2019opacité) ; une surface en compte environ {{reference}}. Portée : {{candidates}} points.',
    'ja': '判定：半径 {{radius}} 内の近傍が {{limit}} 個未満かつ不透明度 \u2264 {{opacity}}（または不透明度に関わらず近傍 {{hardLimit}} 個未満）。このモデルの表面では約 {{reference}} 個。範囲：{{candidates}} 点。',
    'ko': '판정: 반경 {{radius}} 안의 이웃이 {{limit}}개 미만이고 불투명도 \u2264 {{opacity}}(또는 불투명도와 무관하게 이웃 {{hardLimit}}개 미만). 이 모델 표면은 약 {{reference}}개. 범위: {{candidates}}개.',
    'pt-BR': 'Critério: menos de {{limit}} vizinhos num raio de {{radius}} e opacidade \u2264 {{opacity}} (ou menos de {{hardLimit}} vizinhos independentemente da opacidade); uma superfície aqui tem cerca de {{reference}}. Escopo: {{candidates}} pontos.',
    'ru': 'Критерий: меньше {{limit}} соседей в радиусе {{radius}} и непрозрачность \u2264 {{opacity}} (или меньше {{hardLimit}} соседей независимо от непрозрачности); на поверхности здесь около {{reference}}. Область: {{candidates}} точек.'
};

const HINT = {
    'en': 'Higher removes more. A gaussian counts when the space around it is nearly empty AND it is faint (default: under 40 neighbours in a box of 34x the point spacing, opacity \u2264 0.11); a fully isolated one counts whatever its opacity. On real scans walls and floor are sampled as coarsely as floaters, so use Scope above to keep the tool inside a selection.',
    'zh-CN': '数值越高删得越多。判定 =「周围几乎是空的」且「偏透明」（默认：34 倍点间距的方块里邻居数 < 40、不透明度 \u2264 0.11）；完全孤立的点不看透明度。真实扫描里墙面/地面的采样密度和浮云一样稀疏，所以请配合上面的「处理范围」，用选区把工具限制在你圈定的区域内。',
    'de': 'Höhere Werte entfernen mehr. Ein Punkt zählt, wenn der Raum um ihn fast leer UND er blass ist (Standard: unter 40 Nachbarn in einem Kasten von 34x Punktabstand, Deckkraft \u2264 0,11); ein völlig isolierter Punkt zählt unabhängig von der Deckkraft. Bei echten Scans sind Wände und Boden genauso grob abgetastet wie Floater – nutze daher den Bereich oben, um das Werkzeug auf eine Auswahl zu begrenzen.',
    'es': 'Un valor más alto elimina más. Un punto cuenta cuando el espacio a su alrededor está casi vacío Y es tenue (por defecto: menos de 40 vecinos en una caja de 34x la separación entre puntos, opacidad \u2264 0,11); uno totalmente aislado cuenta sin mirar la opacidad. En escaneos reales las paredes y el suelo están muestreados tan gruesamente como los flotantes, así que usa el Ámbito de arriba para limitar la herramienta a una selección.',
    'fr': 'Une valeur plus élevée supprime davantage. Un point compte quand l\u2019espace autour est presque vide ET qu\u2019il est pâle (par défaut : moins de 40 voisins dans une boîte de 34x l\u2019espacement des points, opacité \u2264 0,11) ; un point totalement isolé compte quelle que soit son opacité. Sur un scan réel, les murs et le sol sont échantillonnés aussi grossièrement que les flottants : utilisez la Portée ci-dessus pour limiter l\u2019outil à une sélection.',
    'ja': '値が大きいほど多く削除されます。判定は「周囲がほぼ空」かつ「薄い」こと（既定：点間隔の 34 倍の箱で近傍 40 個未満、不透明度 \u2264 0.11）。完全に孤立した点は不透明度を問いません。実スキャンでは壁や床も浮遊物と同じくらい粗くサンプリングされるため、上の「範囲」で選択範囲内に限定してください。',
    'ko': '값이 높을수록 더 많이 제거됩니다. 판정은 "주변이 거의 비어 있음" 그리고 "옅음"입니다(기본: 점 간격의 34배 상자에서 이웃 40개 미만, 불투명도 \u2264 0.11). 완전히 고립된 점은 불투명도와 무관합니다. 실제 스캔에서는 벽과 바닥도 부유물만큼 성기게 샘플링되므로 위의 "범위"로 선택 영역 안으로 제한하세요.',
    'pt-BR': 'Valores mais altos removem mais. Um ponto conta quando o espaço ao redor está quase vazio E ele é tênue (padrão: menos de 40 vizinhos numa caixa de 34x o espaçamento entre pontos, opacidade \u2264 0,11); um ponto totalmente isolado conta independentemente da opacidade. Em scans reais, paredes e piso são amostrados tão grosseiramente quanto os flutuantes — use o Escopo acima para limitar a ferramenta a uma seleção.',
    'ru': 'Чем выше значение, тем больше удаляется. Точка учитывается, если вокруг почти пусто И она бледная (по умолчанию: меньше 40 соседей в кубе 34\u00d7 расстояние между точками, непрозрачность \u2264 0,11); полностью изолированная точка учитывается независимо от непрозрачности. В реальных сканах стены и пол сэмплированы так же редко, как флоатеры, поэтому используйте «Область» выше, чтобы ограничить инструмент выделением.'
};

const NEW_KEYS = [
    ['panel.floater.scope', {
        'en': 'Scope', 'zh-CN': '处理范围', 'de': 'Bereich', 'es': 'Ámbito', 'fr': 'Portée',
        'ja': '範囲', 'ko': '범위', 'pt-BR': 'Escopo', 'ru': 'Область'
    }],
    ['panel.floater.scope.all', {
        'en': 'Whole model', 'zh-CN': '整个模型', 'de': 'Ganzes Modell', 'es': 'Modelo completo',
        'fr': 'Modèle entier', 'ja': 'モデル全体', 'ko': '모델 전체', 'pt-BR': 'Modelo inteiro', 'ru': 'Вся модель'
    }],
    ['panel.floater.scope.selection', {
        'en': 'Selection only', 'zh-CN': '仅选区内', 'de': 'Nur Auswahl', 'es': 'Solo la selección',
        'fr': 'Sélection seule', 'ja': '選択範囲のみ', 'ko': '선택 영역만', 'pt-BR': 'Somente a seleção', 'ru': 'Только выделенное'
    }],
    ['panel.floater.scope.exclude', {
        'en': 'Skip selection', 'zh-CN': '跳过选区', 'de': 'Auswahl überspringen', 'es': 'Omitir la selección',
        'fr': 'Ignorer la sélection', 'ja': '選択範囲を除外', 'ko': '선택 영역 제외', 'pt-BR': 'Ignorar a seleção', 'ru': 'Пропустить выделенное'
    }]
];

const check = process.argv.includes('--check');
let failed = 0;

for (const lang of LANGS) {
    const full = path.join(DIR, `${lang}.json`);
    const text = fs.readFileSync(full, 'utf8');
    const lines = text.split('\n');
    const indent = (lines[lines.findIndex(l => l.includes('"panel.floater.details"'))] || '    ').match(/^\s*/)[0];

    const setKey = (key, value, afterKey) => {
        const idx = lines.findIndex(l => l.includes(`"${key}"`));
        const line = `${indent}"${key}": ${JSON.stringify(value)},`;
        if (idx !== -1) {
            lines[idx] = line;
        } else {
            const anchor = lines.findIndex(l => l.includes(`"${afterKey}"`));
            if (anchor === -1) {
                throw new Error(`anchor ${afterKey} not found`);
            }
            lines.splice(anchor + 1, 0, line);
        }
    };

    try {
        // drop a leftover key from an earlier revision, if any
        const stale = lines.findIndex(l => l.includes('"panel.floater.detailsSampled"'));
        if (stale !== -1) {
            lines.splice(stale, 1);
        }
        setKey('panel.floater.details', DETAILS[lang]);
        setKey('panel.floater.sensitivityHint', HINT[lang]);
        let anchor = 'panel.floater.clusterDetails';
        for (const [key, values] of NEW_KEYS) {
            setKey(key, values[lang], anchor);
            anchor = key;
        }
        const parsed = JSON.parse(lines.join('\n'));
        const floaterKeys = Object.keys(parsed).filter(k => k.startsWith('panel.floater.'));
        for (const [key] of NEW_KEYS) {
            if (!floaterKeys.includes(key)) {
                throw new Error(`${key} missing after update`);
            }
        }
    } catch (e) {
        console.log(`${lang}: FAILED ${e.message}`);
        failed++;
        continue;
    }

    const next = lines.join('\n');
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
