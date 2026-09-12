// Static audit for the SplatRoom sources. No dependencies, no build needed:
//   node scripts/audit-code.mjs [--json]
//
// Reports things a compiler cannot: exported symbols nobody imports, source
// files nothing imports, locale keys no longer referenced, SVG assets never
// imported, npm dependencies never imported, and counts of the escape hatches
// (`as any`, @ts-ignore, eslint-disable, TODO) with their locations.
//
// Approximate by design (it is a text scan, not a type-aware tool): every hit
// is a candidate to verify by hand, and dynamic access (i18n keys built from
// variables, `import(variable)`, event names in strings) can hide real uses.
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, extname, basename } from 'path';

const root = process.cwd();
const srcDir = join(root, 'src');
const svgDir = join(srcDir, 'ui', 'svg');
const localesDir = join(root, 'static', 'locales');

const walk = (dir, filter, out = []) => {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, filter, out);
        else if (filter(p)) out.push(p);
    }
    return out;
};

const rel = (p) => p.slice(root.length + 1).replace(/\\/g, '/');
const tsFiles = walk(srcDir, p => extname(p) === '.ts');
const sources = new Map(tsFiles.map(p => [rel(p), readFileSync(p, 'utf8')]));
const allSourceText = [...sources.values()].join('\n');

// files outside src/ can also use src exports (verification harnesses, archived
// scripts, electron main): they count as users, but flagged so a reviewer can
// tell "only used by a script" from "used by the app"
const outsideFiles = [
    ...walk(join(root, 'scripts'), p => ['.mjs', '.cjs', '.js'].includes(extname(p))),
    ...walk(join(root, 'docs'), p => ['.mjs', '.cjs', '.js', '.mts'].includes(extname(p)))
].map(p => [rel(p), readFileSync(p, 'utf8')]);
const outsideText = outsideFiles.map(([, t]) => t).join('\n');

// ---------------------------------------------------------------- dead exports
const exportPattern = /^export\s+(?:default\s+)?(?:const|let|function|class|type|interface|enum|abstract class)\s+([A-Za-z_$][\w$]*)/gm;
const deadExports = [];
for (const [file, text] of sources) {
    for (const m of text.matchAll(exportPattern)) {
        const name = m[1];
        const word = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g');
        let uses = 0;
        for (const [otherFile, otherText] of sources) {
            if (otherFile === file) continue;
            uses += (otherText.match(word) ?? []).length;
        }
        if (uses === 0) {
            const outside = (outsideText.match(word) ?? []).length;
            deadExports.push({ file, name, usedOutsideSrc: outside });
        }
    }
}

// --------------------------------------------------------------- orphan files
const rollupConfig = readFileSync(join(root, 'rollup.config.mjs'), 'utf8');
const entries = new Set(['src/main.ts', 'src/index.ts', 'src/sw.ts', 'src/iframe-api.ts']);
for (const m of rollupConfig.matchAll(/input:\s*'([^']+)'/g)) entries.add(m[1]);
const orphanFiles = [];
for (const file of sources.keys()) {
    if (entries.has(file)) continue;
    const stem = basename(file, '.ts');
    const dirName = file.slice(file.lastIndexOf('/', file.lastIndexOf('/') - 1) + 1, file.lastIndexOf('/'));
    const imported = [...sources.entries()].some(([other, text]) => {
        if (other === file) return false;
        if (new RegExp(`from\\s+['"][^'"]*\\b${stem}['"]`).test(text)) return true;
        // barrel imports: './data-processor' resolves to data-processor/index.ts
        return stem === 'index' && new RegExp(`from\\s+['"][^'"]*${dirName}['"]`).test(text);
    }) || outsideFiles.some(([, text]) => new RegExp(`from\\s+['"][^'"]*\\b${stem}(\\.[jt]s)?['"]`).test(text));
    if (!imported) orphanFiles.push(file);
}

// ------------------------------------------------------------- unused locales
const en = JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf8'));
const unusedLocaleKeys = Object.keys(en).filter((key) => {
    // a literal use is either the full key or the leaf after a dynamic prefix
    if (allSourceText.includes(key)) return false;
    const parts = key.split('.');
    const tail = parts.slice(-2).join('.');
    return !allSourceText.includes(tail) && !allSourceText.includes(parts[parts.length - 1]);
});

// ----------------------------------------------------------------- unused svgs
const svgFiles = existsSync(svgDir) ? walk(svgDir, p => extname(p) === '.svg') : [];
const unusedSvgs = svgFiles.map(rel).filter((file) => {
    const stem = basename(file, '.svg').replace(/\.svg$/, '');
    return !allSourceText.includes(`/${stem}.svg`) && !allSourceText.includes(`'${stem}.svg'`);
});

// -------------------------------------------------------------- unused deps
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const rootConfigs = readdirSync(root)
.filter(n => /\.(js|mjs|cjs|json|ts)$/.test(n) && n !== 'package-lock.json' && n !== 'package.json')
.map(n => [rel(join(root, n)), readFileSync(join(root, n), 'utf8')]);
const searchable = allSourceText + '\n' + outsideText + '\n' + rootConfigs.map(([, t]) => t).join('\n');
const unusedDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((dep) => {
    const names = [dep, dep.replace(/^@[^/]+\//, '')];
    return !names.some(n => searchable.includes(n));
});

// ------------------------------------------------------------ escape hatches
const countWithLocations = (pattern) => {
    const hits = [];
    for (const [file, text] of sources) {
        text.split('\n').forEach((line, i) => {
            if (pattern.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
    }
    return hits;
};

const anyPerFile = [...sources.entries()]
.map(([file, text]) => ({ file, count: (text.match(/\bas any\b/g) ?? []).length }))
.filter(e => e.count > 0)
.sort((a, b) => b.count - a.count);

const tsconfig = readFileSync(join(root, 'tsconfig.json'), 'utf8');
const excluded = [...tsconfig.matchAll(/"(src\/[\w./-]+\.ts)"/g)].map(m => m[1]);

const report = {
    totals: {
        sourceFiles: sources.size,
        lines: [...sources.values()].reduce((n, t) => n + t.split('\n').length, 0),
        localeKeys: Object.keys(en).length,
        svgAssets: svgFiles.length
    },
    deadExports,
    orphanFiles,
    unusedLocaleKeys,
    unusedSvgs,
    unusedDeps,
    tsconfigExcluded: excluded.filter(f => existsSync(join(root, f))),
    escapes: {
        asAny: anyPerFile.reduce((n, e) => n + e.count, 0),
        asAnyTopFiles: anyPerFile.slice(0, 12),
        tsIgnore: countWithLocations(/@ts-ignore/),
        eslintDisable: countWithLocations(/eslint-disable/),
        todo: countWithLocations(/\b(TODO|FIXME|HACK|XXX)\b/)
    }
};

if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
} else {
    const s = report.totals;
    console.log(`sources ${s.sourceFiles} files / ${s.lines} lines, ${s.localeKeys} locale keys, ${s.svgAssets} svg assets\n`);
    const section = (title, rows, fmt) => {
        console.log(`\n== ${title} (${rows.length}) ==`);
        rows.slice(0, 40).forEach(r => console.log('  ' + fmt(r)));
        if (rows.length > 40) console.log(`  … ${rows.length - 40} more`);
    };
    section('dead exports (no importer)', deadExports, e => `${e.file}: ${e.name}`);
    section('orphan files (nothing imports them)', orphanFiles, f => f);
    section('unused locale keys', unusedLocaleKeys, k => k);
    section('unused svg assets', unusedSvgs, f => f);
    section('unused npm deps', unusedDeps, d => d);
    section('tsconfig-excluded files that exist', report.tsconfigExcluded, f => f);
    section('as any per file', anyPerFile, e => `${String(e.count).padStart(4)}  ${e.file}`);
    section('@ts-ignore', report.escapes.tsIgnore, l => l);
    section('eslint-disable', report.escapes.eslintDisable, l => l);
    section('TODO/FIXME/HACK', report.escapes.todo, l => l);
}
