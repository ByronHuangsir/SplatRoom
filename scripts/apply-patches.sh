#!/bin/bash
# SplatRoom post-install patch script
# Run this after `npm install` to re-apply custom patches
# Usage: bash scripts/apply-patches.sh

set -e

echo "[SplatRoom] Applying patches..."

# Patch 1: splat-transform MAX_STRIPE_BYTES (8MB -> 128MB)
TARGET="node_modules/@playcanvas/splat-transform/dist/index.mjs"
if [ -f "$TARGET" ]; then
    CURRENT=$(grep -o "MAX_STRIPE_BYTES = [0-9]* \* 1024 \* 1024" "$TARGET" | head -1)
    if echo "$CURRENT" | grep -q "128"; then
        echo "[OK] Patch 1 already applied: $CURRENT"
    else
        cp patches/splat-transform-index.mjs "$TARGET"
        echo "[APPLIED] Patch 1: MAX_STRIPE_BYTES 8MB -> 128MB"
    fi
else
    echo "[SKIP] Patch 1: $TARGET not found (run npm install first)"
fi

echo "[SplatRoom] Patches complete."
