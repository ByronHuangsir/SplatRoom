// Move source modules and fix every relative import that pointed at them.
//
//   node scripts/move-src-modules.mjs --map "src/camera.ts=src/camera/camera.ts,src/controllers.ts=src/camera/controllers.ts" [--apply]
//
// Relative specifiers are resolved against the OLD layout, then recomputed from
// the importer's NEW directory, so both the moved files and their importers keep
// working. References from scripts/ and docs/ (which live outside the TS program
// and would otherwise break silently) are rewritten too.
//
// After applying: `npm run typecheck && npm run lint` — the compiler is the net.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, relative, extname, sep } from 'path';
import { execFileSync } from 'child_process';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const mapArg = argv[argv.indexOf('--map') + 1];
if (!mapArg) {
    console.error('usage: node scripts/move-src-modules.mjs --map "src/a.ts=src/x/a.ts,..." [--apply]');
    process.exit(1);
}

const root = process.cwd();
const normalise = (p) => p.replace(/\\/g, '/');
const map = new Map(mapArg.split(',').filter(Boolean).map((pair) => {
    const [from, to] = pair.split('=').map(s => normalise(s.trim()));
    return [from, to];
}));

for (const [from, to] of map) {
    if (!existsSync(join(root, from))) {
        console.error(`source missing: ${from}`);
        process.exit(1);
    }
    if (existsSync(join(root, to))) {
        console.error(`destination exists: ${to}`);
        process.exit(1);
    }
}

const walk = (dir, filter, out = []) => {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, filter, out);
        else if (filter(p)) out.push(normalise(relative(root, p)));
    }
    return out;
};

const importers = [
    ...walk(join(root, 'src'), p => extname(p) === '.ts'),
    ...walk(join(root, 'scripts'), p => ['.mjs', '.cjs', '.js'].includes(extname(p))),
    ...walk(join(root, 'docs'), p => ['.mjs', '.cjs', '.mts'].includes(extname(p)))
];

// resolve a relative specifier against a file's OLD location
const resolveOld = (importer, spec) => {
    const base = join(root, dirname(importer), spec);
    const candidates = [`${base}.ts`, join(base, 'index.ts'), base];
    for (const c of candidates) {
        if (existsSync(c) && statSync(c).isFile()) return normalise(relative(root, c));
    }
    return null;
};

const newLocation = (file) => map.get(file) ?? file;

let rewritten = 0;
let movedRefs = 0;
const unresolved = [];

for (const importer of importers) {
    const path = join(root, importer);
    const text = readFileSync(path, 'utf8');
    const importerNewDir = dirname(newLocation(importer));
    let changed = false;

    const next = text.replace(/(from\s+|import\s*\(\s*)(['"])(\.[^'"]+)\2/g, (match, prefix, quote, spec) => {
        const target = resolveOld(importer, spec);
        if (!target) {
            if (spec.startsWith('.') && !spec.includes('.scss') && !spec.includes('.svg') && !spec.includes('.json')) {
                unresolved.push(`${importer}: ${spec}`);
            }
            return match;
        }
        const targetNew = newLocation(target);
        if (targetNew === target && !map.has(importer)) return match;

        let rel = normalise(relative(importerNewDir, targetNew));
        if (!rel.startsWith('.')) rel = `./${rel}`;
        // keep an explicit .ts extension when the original had one (Node harnesses need it)
        if (!spec.endsWith('.ts')) rel = rel.replace(/\.ts$/, '');
        if (rel === spec) return match;

        changed = true;
        movedRefs++;
        return `${prefix}${quote}${rel}${quote}`;
    });

    if (changed) {
        rewritten++;
        if (apply) writeFileSync(path, next, 'utf8');
    }
}

if (apply) {
    for (const [from, to] of map) {
        mkdirSync(join(root, dirname(to)), { recursive: true });
        execFileSync('git', ['mv', from, to], { cwd: root, stdio: 'inherit' });
    }
}

console.log(`${apply ? 'moved' : 'would move'} ${map.size} file(s)`);
console.log(`${apply ? 'rewrote' : 'would rewrite'} ${rewritten} importer(s), ${movedRefs} specifier(s)`);
if (unresolved.length) {
    console.log(`\nunresolved relative specifiers (verify by hand): ${unresolved.length}`);
    for (const u of unresolved.slice(0, 20)) console.log(`  ${u}`);
}
if (!apply) console.log('\nre-run with --apply to perform the move');
