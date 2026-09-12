// Narrow exported symbols that nothing imports (reported by audit-code.mjs):
// `export const X` -> `const X`, and the same for let/function/class/enum, plus
// removal from a trailing `export { A, X };` list.
//
// Types and interfaces are left exported on purpose: they document a module's
// contract and cost nothing at runtime.
//
//   node scripts/narrow-dead-exports.mjs            # dry run (default)
//   node scripts/narrow-dead-exports.mjs --apply    # rewrite the files
//
// Always follow with `npm run typecheck && npm run lint && npm run build`: the
// compiler is the safety net (a symbol that is in fact used elsewhere turns into
// a hard "has no exported member" error).
import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

const apply = process.argv.includes('--apply');
const root = process.cwd();

const json = execFileSync(process.execPath, [join(root, 'scripts', 'audit-code.mjs'), '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
});
const report = JSON.parse(json);

const declarationByFile = new Map();
const skipByFile = new Map();
for (const entry of report.deadExports) {
    // a symbol used by scripts/ or docs/ is NOT dead: those files are outside the
    // TS program, so narrowing them would break the harness with no compiler error
    const target = entry.usedOutsideSrc > 0 ? skipByFile : declarationByFile;
    if (!target.has(entry.file)) target.set(entry.file, []);
    target.get(entry.file).push(entry.usedOutsideSrc > 0 ? `${entry.name}(used by scripts)` : entry.name);
}

// matches `export const|let|var|function|async function|class|abstract class|enum Name`
const valueExport = (name) => new RegExp(`^export\\s+(?:const|let|var|function|async\\s+function|class|abstract\\s+class|enum)\\s+${name.replace(/\$/g, '\\$')}\\b`);

const results = [];
let changed = 0;

for (const [file, names] of declarationByFile) {
    const path = join(root, file);
    let text = readFileSync(path, 'utf8');
    const original = text;
    const narrowed = [];
    const skipped = [];

    for (const name of names) {
        const re = valueExport(name);
        const lines = text.split('\n');
        const index = lines.findIndex(line => re.test(line));
        if (index >= 0) {
            lines[index] = lines[index].replace(/^export\s+/, '');
            text = lines.join('\n');
            narrowed.push(name);
            continue;
        }

        // trailing export list: `export { A, B, C };`
        const listMatch = text.match(/export\s*\{([^}]*)\}\s*;/);
        if (listMatch && listMatch[1].split(',').some(part => part.trim().split(/\s+as\s+/).pop() === name)) {
            const remaining = listMatch[1]
            .split(',')
            .map(part => part.trim())
            .filter(part => part && part.split(/\s+as\s+/).pop() !== name);
            const replacement = remaining.length ? `export { ${remaining.join(', ')} };` : '';
            text = text.replace(listMatch[0], replacement);
            narrowed.push(name);
            continue;
        }

        skipped.push(name);
    }

    if (text !== original) {
        changed++;
        if (apply) writeFileSync(path, text, 'utf8');
    }
    results.push({ file, narrowed, skipped });
}

for (const r of results) {
    const tag = r.skipped.length ? 'skipped:' + r.skipped.join(',') : '';
    console.log(`${apply ? 'rewrote' : 'would rewrite'} ${r.file}: ${r.narrowed.join(', ')} ${tag}`.trim());
}
if (skipByFile.size) {
    console.log('\nleft exported because a script or doc uses them:');
    for (const [file, names] of skipByFile) console.log(`  ${file}: ${names.join(', ')}`);
}
console.log(`\n${apply ? 'rewrote' : 'would rewrite'} ${changed} file(s); ` +
    `${results.reduce((n, r) => n + r.narrowed.length, 0)} symbol(s) narrowed, ` +
    `${results.reduce((n, r) => n + r.skipped.length, 0)} left exported (type-ish or not found)`);
if (!apply) console.log('re-run with --apply to write the changes');
