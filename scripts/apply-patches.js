// SplatRoom post-install patch script
// Automatically applies custom patches after `npm install`
// Cross-platform (Windows/macOS/Linux)

const fs = require('fs');
const path = require('path');

console.log('[SplatRoom] Applying patches...');

// Patch 1: splat-transform MAX_STRIPE_BYTES (8MB -> 128MB)
const targetPath = path.join('node_modules', '@playcanvas', 'splat-transform', 'dist', 'index.mjs');
const patchPath = path.join('patches', 'splat-transform-index.mjs');

if (fs.existsSync(targetPath)) {
    const content = fs.readFileSync(targetPath, 'utf8');
    if (content.includes('MAX_STRIPE_BYTES = 128 * 1024 * 1024')) {
        console.log('[OK] Patch 1 already applied: MAX_STRIPE_BYTES = 128MB');
    } else if (content.includes('MAX_STRIPE_BYTES = 8 * 1024 * 1024')) {
        if (fs.existsSync(patchPath)) {
            fs.copyFileSync(patchPath, targetPath);
            console.log('[APPLIED] Patch 1: MAX_STRIPE_BYTES 8MB -> 128MB (file copied)');
        } else {
            // Fallback: sed-style replacement
            const patched = content.replace(
                /MAX_STRIPE_BYTES = 8 \* 1024 \* 1024/,
                'MAX_STRIPE_BYTES = 128 * 1024 * 1024'
            );
            fs.writeFileSync(targetPath, patched);
            console.log('[APPLIED] Patch 1: MAX_STRIPE_BYTES 8MB -> 128MB (inline edit)');
        }
    } else {
        console.log('[WARN] Patch 1: unexpected MAX_STRIPE_BYTES value, skipping');
    }
} else {
    console.log('[SKIP] Patch 1: ' + targetPath + ' not found');
}

// Patch 2: eslint-plugin-import order.js — ESLint 10 移除了
// sourceCode.getTokenOrCommentBefore / getTokenOrCommentAfter API，导致
// `npm run lint` 崩溃（TypeError: sourceCode.getTokenOrCommentBefore is not
// a function）。替换为官方推荐的 getTokenBefore/After(node, { includeComments: true })。
const importOrderPath = path.join('node_modules', '@playcanvas', 'eslint-config', 'node_modules', 'eslint-plugin-import', 'lib', 'rules', 'order.js');

if (fs.existsSync(importOrderPath)) {
    const content = fs.readFileSync(importOrderPath, 'utf8');
    if (!content.includes('getTokenOrComment')) {
        console.log('[OK] Patch 2 already applied: eslint-plugin-import uses ESLint-10 compatible API');
    } else {
        const patched = content
            .replace(/sourceCode\.getTokenOrCommentAfter\(([^)]*)\)/g, 'sourceCode.getTokenAfter($1, { includeComments: true })')
            .replace(/sourceCode\.getTokenOrCommentBefore\(([^)]*)\)/g, 'sourceCode.getTokenBefore($1, { includeComments: true })');
        if (patched === content) {
            console.log('[WARN] Patch 2: unexpected call pattern, skipping');
        } else {
            fs.writeFileSync(importOrderPath, patched);
            console.log('[APPLIED] Patch 2: eslint-plugin-import order.js ESLint-10 API compat');
        }
    }
} else {
    console.log('[SKIP] Patch 2: ' + importOrderPath + ' not found');
}

console.log('[SplatRoom] Patches complete.');
